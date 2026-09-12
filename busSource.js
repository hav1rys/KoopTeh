'use strict';

// Расписание пригородных автобусов. Два источника:
//
//  - avokzaly.ru (билетный сайт официального автовокзала Петрозаводска,
//    avokzal.karelia.ru редиректит туда же) — direction «город → домой»,
//    ПРИНУДИТЕЛЬНО, без отката на Яндекс, если известна остановка (сайт не
//    умеет искать «откуда: село», только «куда: конкретная остановка»).
//    SSR, разметка семантическая (div.trip-card / .departure / .arrival /
//    span.time[datetime]).
//
//  - rasp.yandex.ru — direction «домой → город» (у автовокзала нет такого
//    поиска вообще), и «город → домой» как единственный вариант, если
//    остановка не указана. Страница /search/?fromName=...&toName=...
//    отдаётся сервером (SSR) с полным состоянием в window.INITIAL_STATE = {...}
//    — обычный JSON-объект прямо в HTML, без выполнения JS.
//
// ХРУПКО: оба парсера читают вёрстку/внутреннее состояние сайтов, не
// публичные API — если что-то поменяют, парсинг может сломаться молча
// (функции вернут UnavailableError). Тогда расписание придётся занести
// вручную через /admin.

const cfg = require('./config');

class UnavailableError extends Error {}

const UA = 'KoopTehScheduleBot/1.0 (+Discord schedule bot; bus lookup)';
const CITY = 'Петрозаводск';
const AVOKZAL_SLUG = 'petrozavodsk-av';

async function httpGet(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.httpTimeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    if (!res.ok) throw new UnavailableError(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err instanceof UnavailableError) throw err;
    throw new UnavailableError(`сетевая ошибка: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Название остановки: короткий ввод «2» -> «Новая Вилга-2» (Яндекс) /
// «Новая Вилга 2» (автовокзал). Полное слово (напр. «кладбище») — используется
// как есть, без подстановки homePlace (для остановок другого населённого
// пункта — Вилга/Новая Вилга это РАЗНЫЕ сёла).
// ---------------------------------------------------------------------------

/** @returns {{avokzal:string, yandexAlts:string[]}|null} */
function resolveStopNames(place, rawStop) {
  const trimmed = String(rawStop || '').trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const alts = [`${place}-${trimmed}`, `${place} ${trimmed}`];
    if (trimmed === '1') alts.push(place); // первая остановка иногда без номера
    return { avokzal: `${place} ${trimmed}`, yandexAlts: alts };
  }
  return { avokzal: trimmed, yandexAlts: [trimmed] };
}

/** Достаёт JSON из `window.INITIAL_STATE = {...}` в HTML (брейс-мэтчинг с учётом строк/экранирования). */
function extractInitialState(html) {
  const marker = 'window.INITIAL_STATE = ';
  const at = html.indexOf(marker);
  if (at < 0) throw new UnavailableError('не нашёл INITIAL_STATE на странице (вёрстка Яндекса могла измениться)');
  let i = at + marker.length;
  if (html[i] !== '{') throw new UnavailableError('неожиданный формат INITIAL_STATE');
  const start = i;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const jsonText = html.slice(start, i);
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    throw new UnavailableError(`не удалось разобрать INITIAL_STATE: ${err.message}`);
  }
}

/** Ищет в дереве состояния массив рейсов (ключ "segments", элементы с departureLocalDt). */
function findSegments(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node.segments) && node.segments.length && node.segments[0] && node.segments[0].departureLocalDt) {
    return node.segments;
  }
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (v && typeof v === 'object') {
      const found = findSegments(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function fetchSegments(fromName, toName) {
  const url = `https://rasp.yandex.ru/search/?fromName=${encodeURIComponent(fromName)}&toName=${encodeURIComponent(toName)}`;
  const html = await httpGet(url);
  const state = extractInitialState(html);
  const segments = findSegments(state);
  if (!segments) throw new UnavailableError('не нашёл рейсы в ответе Яндекс.Расписаний');
  return segments;
}

const hhmm = (iso) => (iso ? String(iso).slice(11, 16) : '');

/**
 * Рейсы между fromName и toName, отфильтрованные по остановке на стороне matchField.
 * matchStop — точное совпадение (строка или массив вариантов написания);
 * matchLoose — совпадение по началу названия (для «любая остановка в этом
 * населённом пункте», напр. «Новая Вилга» ловит «Новая Вилга», «Новая Вилга-2»).
 */
async function busTimes(fromName, toName, { matchField = 'to', matchLoose, matchStop } = {}) {
  const segments = await fetchSegments(fromName, toName);
  const stopAlts = matchStop ? (Array.isArray(matchStop) ? matchStop : [matchStop]) : null;
  const rows = segments
    .filter((s) => {
      const station = matchField === 'from' ? s.stationFrom : s.stationTo;
      const title = (station && station.title) || '';
      if (stopAlts) return stopAlts.includes(title);
      if (matchLoose) return title.startsWith(matchLoose);
      return true;
    })
    .map((s) => ({
      number: s.number || '',
      title: s.title || '',
      company: (s.company && s.company.title) || '',
      depHHMM: hhmm(s.departureLocalDt),
      arrHHMM: hhmm(s.arrivalLocalDt),
      stationFrom: (s.stationFrom && s.stationFrom.title) || '',
      stationTo: (s.stationTo && s.stationTo.title) || '',
      source: 'yandex',
    }))
    .filter((r) => r.depHHMM)
    .sort((a, b) => a.depHHMM.localeCompare(b.depHHMM));
  return rows;
}

// ---------------------------------------------------------------------------
// avokzaly.ru (официальный автовокзал Петрозаводска) — только «город -> домой».
// ---------------------------------------------------------------------------

async function fetchAvokzalyHtml(stopName) {
  const url = `https://avokzaly.ru/${AVOKZAL_SLUG}/raspisanie-avtobusov/${AVOKZAL_SLUG}--${encodeURIComponent(stopName)}/`;
  return httpGet(url);
}

/** Разбирает карточки `div.trip-card` (Отправление/Прибытие с datetime="HH:MM"). */
function parseAvokzalyTrips(html) {
  const out = [];
  const marker = '<div class="trip-card"';
  let pos = html.indexOf(marker);
  while (pos >= 0) {
    const next = html.indexOf(marker, pos + 1);
    const block = html.slice(pos, next === -1 ? pos + 4000 : next);
    const dep = /class="departure">[\s\S]{0,300}?datetime="(\d{2}:\d{2})"[\s\S]{0,300}?class="station"[\s\S]*?>([^<]+)</.exec(block);
    const arr = /class="arrival">[\s\S]{0,300}?datetime="(\d{2}:\d{2})"[\s\S]{0,300}?class="station"[\s\S]*?>([^<]+)</.exec(block);
    if (dep && arr) {
      out.push({ depHHMM: dep[1], stationFrom: dep[2].trim(), arrHHMM: arr[1], stationTo: arr[2].trim() });
    }
    pos = next;
  }
  return out;
}

/** Рейсы «город -> домой» с официального сайта автовокзала по точной остановке. */
async function toHomeOfficial(stopName) {
  const html = await fetchAvokzalyHtml(stopName);
  const trips = parseAvokzalyTrips(html);
  if (!trips.length) throw new UnavailableError('не нашёл рейсы на сайте автовокзала (проверь название остановки)');
  return trips
    .map((t) => ({
      number: '',
      title: `${t.stationFrom} — ${t.stationTo}`,
      company: '',
      depHHMM: t.depHHMM,
      arrHHMM: t.arrHHMM,
      stationFrom: t.stationFrom,
      stationTo: t.stationTo,
      source: 'avokzal',
    }))
    .sort((a, b) => a.depHHMM.localeCompare(b.depHHMM));
}

/**
 * Рейсы «из города домой» (Петрозаводск -> место). Если остановка известна —
 * ПРИНУДИТЕЛЬНО официальный сайт автовокзала, без отката на Яндекс (сайт не
 * умеет по-другому, но зато он official и точный). Без остановки — Яндекс
 * с приблизительным «любая остановка в этом селе».
 */
async function toHome(place, { stop } = {}) {
  const names = resolveStopNames(place, stop);
  if (names) return toHomeOfficial(names.avokzal);
  return busTimes(CITY, place, { matchField: 'to', matchLoose: place });
}

/**
 * Рейсы «из дома в город» (место -> Петрозаводск). У автовокзала нет такого
 * поиска («откуда: село» не задать) — только Яндекс.
 */
async function toCity(place, { stop } = {}) {
  const names = resolveStopNames(place, stop);
  if (names) return busTimes(place, CITY, { matchField: 'from', matchStop: names.yandexAlts });
  return busTimes(place, CITY, { matchField: 'from', matchLoose: place });
}

const yandexUrl = (fromName, toName) =>
  `https://rasp.yandex.ru/search/?fromName=${encodeURIComponent(fromName)}&toName=${encodeURIComponent(toName)}`;

/** Ссылка «проверить» на реальный источник для этого направления. */
function sourceUrl(direction, place, stop) {
  const names = resolveStopNames(place, stop);
  if (direction === 'toHome' && names) {
    return `https://avokzaly.ru/${AVOKZAL_SLUG}/raspisanie-avtobusov/${AVOKZAL_SLUG}--${encodeURIComponent(names.avokzal)}/`;
  }
  return direction === 'toHome' ? yandexUrl(CITY, place) : yandexUrl(place, CITY);
}

module.exports = { UnavailableError, CITY, busTimes, toHome, toHomeOfficial, toCity, sourceUrl, resolveStopNames };
