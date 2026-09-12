'use strict';

// Расписание пригородных автобусов. Два источника:
//
//  - avokzaly.ru (билетный сайт официального автовокзала Петрозаводска,
//    avokzal.karelia.ru редиректит туда же) — direction «город → домой»,
//    ПРИНУДИТЕЛЬНО, если известна точная остановка (сайт не умеет искать
//    «откуда: село», только «куда: конкретная остановка»). SSR, разметка
//    семантическая (div.trip-card / .departure / .arrival / span.time[datetime]).
//
//  - официальный API Яндекс.Расписаний (api.rasp.yandex-net.ru/v3.0, нужен
//    бесплатный ключ — cfg.yandexRaspApiKey) — direction «домой → город»
//    (у автовокзала такого поиска вообще нет), и «город → домой» без точной
//    остановки. РАНЬШЕ здесь скрапился rasp.yandex.ru, но Яндекс стал отдавать
//    серверным запросам капчу («Вы не робот?») — обычные заголовки браузера
//    это не обходят, это осознанная защита, поэтому перешли на официальный,
//    разрешённый доступ вместо попыток её обойти.
//
// ХРУПКО: парсер avokzaly.ru читает вёрстку, не публичный API — если сайт
// поменяют, может сломаться молча (UnavailableError). Тогда расписание придётся
// занести вручную через /admin.

const cfg = require('./config');
const D = require('./dates');

class UnavailableError extends Error {}

// Обычный браузерный UA — для avokzaly.ru (публичная страница без защиты от ботов).
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const CITY = 'Петрозаводск';
const AVOKZAL_SLUG = 'petrozavodsk-av';

async function httpGet(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.httpTimeout);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers });
    const body = await res.text();
    if (!res.ok) throw new UnavailableError(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    return body;
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

const hhmm = (iso) => (iso ? String(iso).slice(11, 16) : '');

// ---------------------------------------------------------------------------
// Официальный API Яндекс.Расписаний — https://yandex.ru/dev/rasp/
// ---------------------------------------------------------------------------

async function fetchOfficialSegments(fromCode, toCode, dateIso) {
  if (!cfg.yandexRaspApiKey) throw new UnavailableError('не задан YANDEX_RASP_API_KEY');
  const url =
    'https://api.rasp.yandex-net.ru/v3.0/search/' +
    `?apikey=${encodeURIComponent(cfg.yandexRaspApiKey)}` +
    `&from=${encodeURIComponent(fromCode)}&to=${encodeURIComponent(toCode)}` +
    `&format=json&lang=ru_RU&date=${dateIso}&transport_types=bus&limit=200`;
  const body = await httpGet(url, { Accept: 'application/json' });
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new UnavailableError(`не удалось разобрать ответ API: ${body.slice(0, 200)}`);
  }
  if (json && json.errors) throw new UnavailableError(`ошибка API: ${JSON.stringify(json.errors).slice(0, 200)}`);
  if (!json || !Array.isArray(json.segments)) throw new UnavailableError('ответ API без segments');
  return json.segments;
}

const mapOfficialSegment = (s) => ({
  number: (s.thread && s.thread.number) || '',
  title: (s.thread && s.thread.title) || '',
  company: (s.thread && s.thread.carrier && s.thread.carrier.title) || '',
  depHHMM: hhmm(s.departure),
  arrHHMM: hhmm(s.arrival),
  stationFrom: (s.from && s.from.title) || '',
  stationTo: (s.to && s.to.title) || '',
  source: 'yandex-api',
});

/** Рейсы между кодами fromCode/toCode на сегодня, с фильтром по остановке. */
async function officialSearch(fromCode, toCode, { matchField = 'to', matchLoose, matchStop } = {}) {
  const dateIso = D.iso(D.todayParts());
  const segments = await fetchOfficialSegments(fromCode, toCode, dateIso);
  const stopAlts = matchStop ? (Array.isArray(matchStop) ? matchStop : [matchStop]) : null;
  return segments
    .filter((s) => {
      const station = matchField === 'from' ? s.from : s.to;
      const title = (station && station.title) || '';
      if (stopAlts) return stopAlts.includes(title);
      if (matchLoose) return title.startsWith(matchLoose);
      return true;
    })
    .map(mapOfficialSegment)
    .filter((r) => r.depHHMM)
    .sort((a, b) => a.depHHMM.localeCompare(b.depHHMM));
}

// ---------------------------------------------------------------------------
// avokzaly.ru (официальный автовокзал Петрозаводска) — только «город -> домой».
// ---------------------------------------------------------------------------

async function fetchAvokzalyHtml(stopName) {
  const url = `https://avokzaly.ru/${AVOKZAL_SLUG}/raspisanie-avtobusov/${AVOKZAL_SLUG}--${encodeURIComponent(stopName)}/`;
  return httpGet(url, { 'User-Agent': UA, Accept: 'text/html' });
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
 * Рейсы «из города домой» (Петрозаводск -> место). Если известна точная остановка —
 * ПРИНУДИТЕЛЬНО официальный сайт автовокзала. Без остановки — официальный API
 * Яндекса, приблизительно (matchLoose по названию села).
 */
async function toHome(place, { stop } = {}) {
  const names = resolveStopNames(place, stop);
  if (names) return toHomeOfficial(names.avokzal);
  return officialSearch(cfg.yandexCityCode, cfg.yandexHomeCode, { matchField: 'to', matchLoose: place });
}

/**
 * Рейсы «из дома в город» (место -> Петрозаводск). У автовокзала нет такого
 * поиска («откуда: село» не задать) — только официальный API Яндекса.
 */
async function toCity(place, { stop } = {}) {
  const names = resolveStopNames(place, stop);
  const opts = names
    ? { matchField: 'from', matchStop: names.yandexAlts }
    : { matchField: 'from', matchLoose: place };
  return officialSearch(cfg.yandexHomeCode, cfg.yandexCityCode, opts);
}

const yandexUrl = (fromName, toName) =>
  `https://rasp.yandex.ru/search/?fromName=${encodeURIComponent(fromName)}&toName=${encodeURIComponent(toName)}`;

/** Ссылка «проверить» — человекочитаемая страница поиска (не API), для ручной проверки глазами. */
function sourceUrl(direction, place, stop) {
  const names = resolveStopNames(place, stop);
  if (direction === 'toHome' && names) {
    return `https://avokzaly.ru/${AVOKZAL_SLUG}/raspisanie-avtobusov/${AVOKZAL_SLUG}--${encodeURIComponent(names.avokzal)}/`;
  }
  return direction === 'toHome' ? yandexUrl(CITY, place) : yandexUrl(place, CITY);
}

module.exports = { UnavailableError, CITY, toHome, toHomeOfficial, toCity, sourceUrl, resolveStopNames };
