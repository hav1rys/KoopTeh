'use strict';

// Скрапинг страницы-календаря koopteh10.ru + парсинг Google-таблицы дня (CSV).
// Без кэширования расписания: каждый вызов заново тянет свежие данные.
// (Кэшируется только список групп — он меняется редко.)

const cfg = require('./config');
const D = require('./dates');

class NotPublishedError extends Error {} // на эту дату ещё нет ссылки в календаре
class UnavailableError extends Error {}  // сайт/таблица недоступны или не читаются

const UA = 'KoopTehScheduleBot/1.0 (+Discord schedule bot)';
const { pad, weekdayRu, fmtDM, fmtDMY } = D;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function httpGet(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.httpTimeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,text/csv,*/*' },
    });
    if (!res.ok) throw new UnavailableError(`HTTP ${res.status} при запросе ${url}`);
    const body = await res.text();
    return { headers: res.headers, body };
  } catch (err) {
    if (err instanceof UnavailableError) throw err;
    throw new UnavailableError(`сетевая ошибка (${url}): ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

const httpGetText = async (url) => (await httpGet(url)).body;

// ---------------------------------------------------------------------------
// Календарь -> ссылка на CSV нужного дня
// ---------------------------------------------------------------------------

const stripTags = (s) => s.replace(/<[^>]+>/g, ' ');

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*2f;/gi, '/');
}

function sheetId(href) {
  const e = /\/spreadsheets\/d\/e\/([a-zA-Z0-9_-]+)/.exec(href);
  if (e) return { id: e[1], published: true };
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(href);
  if (m) return { id: m[1], published: false };
  return null;
}

/** Строит ссылку экспорта в CSV. gid может быть null — тогда берётся первый лист. */
function csvExportUrl(id, published, gid) {
  const g = gid ? `&gid=${gid}` : '';
  return published
    ? `https://docs.google.com/spreadsheets/d/e/${id}/pub?output=csv${g}`
    : `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${g}`;
}

function gidFromHref(href) {
  const m = /[?&#]gid=(\d+)/.exec(href);
  return m ? m[1] : null;
}

/** Все «одинокие» числа 1..31 в тексте, в порядке появления. */
function daysInRange(text) {
  return (text.match(/(?<!\d)[0-3]?\d(?!\d)/g) || [])
    .map(Number)
    .filter((v) => v >= 1 && v <= 31);
}

/**
 * Возвращает Map: ключ -> csvUrl.
 * Ключи: "dd.mm.yyyy" и "dd.mm" (если в тексте ссылки есть полная дата),
 * иначе число дня месяца (обычный случай: <a ...>04</a>).
 */
function extractSheetLinks(html) {
  const out = new Map();
  const anchorRe = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const chunk = m[0];
    const hrefM = /href\s*=\s*"([^"]+)"/i.exec(chunk) || /href\s*=\s*'([^']+)'/i.exec(chunk);
    if (!hrefM) continue;
    const href = decodeEntities(hrefM[1]);
    if (!/docs\.google\.com\/spreadsheets/i.test(href)) continue;
    const sid = sheetId(href);
    if (!sid) continue;
    const csvUrl = csvExportUrl(sid.id, sid.published, gidFromHref(href));

    const anchorText = stripTags(chunk).replace(/\s+/g, ' ').trim();

    const full = /\b(\d{2})\.(\d{2})\.(\d{4})\b/.exec(anchorText);
    if (full) {
      out.set(`${full[1]}.${full[2]}.${full[3]}`, csvUrl);
      out.set(`${full[1]}.${full[2]}`, csvUrl);
      continue;
    }

    let day = daysInRange(anchorText)[0] ?? null;
    if (day == null) {
      const before = stripTags(html.slice(Math.max(0, m.index - 90), m.index)).replace(/\s+/g, ' ');
      const nums = daysInRange(before);
      if (nums.length) day = nums[nums.length - 1];
    }
    if (day != null && !out.has(day)) out.set(day, csvUrl);
  }
  return out;
}

function findSheetUrl(links, t) {
  return links.get(fmtDMY(t)) || links.get(fmtDM(t)) || links.get(t.d) || null;
}

async function resolveSheetUrl(calendarUrl, target) {
  const html = await httpGetText(calendarUrl);
  const url = findSheetUrl(extractSheetLinks(html), target);
  if (!url) throw new NotPublishedError(`нет ссылки на расписание для ${fmtDMY(target)}`);
  return url;
}

/** Ссылка на CSV самого позднего опубликованного дня (последняя ссылка на странице). */
async function resolveLatestSheetUrl(calendarUrl) {
  const html = await httpGetText(calendarUrl);
  const hrefs = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)]
    .map((x) => decodeEntities(x[1]))
    .filter((h) => /docs\.google\.com\/spreadsheets/i.test(h));
  if (!hrefs.length) throw new NotPublishedError('на странице нет опубликованных таблиц');
  const href = hrefs[hrefs.length - 1];
  const sid = sheetId(href);
  if (!sid) throw new UnavailableError('не удалось разобрать ссылку на таблицу');
  return csvExportUrl(sid.id, sid.published, gidFromHref(href));
}

// ---------------------------------------------------------------------------
// Загрузка CSV с фолбэками по gid
// ---------------------------------------------------------------------------

async function fetchCsvOnce(url) {
  const { headers, body } = await httpGet(url);
  const ctype = headers.get('content-type') || '';
  if (!/csv/i.test(ctype) && body.trimStart().startsWith('<')) {
    throw new UnavailableError('ответ не CSV (нет публичного доступа к документу?)');
  }
  return body;
}

/**
 * Скачивает CSV. Ссылки в календаре часто без gid или с неверным gid,
 * поэтому пробуем по очереди: как есть -> без gid (первый лист) ->
 * с известным gid листа расписания (cfg.scheduleGid).
 */
async function downloadCsv(url) {
  const candidates = [url];
  const idM = /\/spreadsheets\/d\/(?:e\/)?([a-zA-Z0-9_-]+)/.exec(url);
  if (idM) {
    const bare = url.includes('/d/e/')
      ? `https://docs.google.com/spreadsheets/d/e/${idM[1]}/pub?output=csv`
      : `https://docs.google.com/spreadsheets/d/${idM[1]}/export?format=csv`;
    if (!candidates.includes(bare)) candidates.push(bare);
    if (cfg.scheduleGid) {
      const withGid = `${bare}${bare.includes('?') ? '&' : '?'}gid=${cfg.scheduleGid}`;
      if (!candidates.includes(withGid)) candidates.push(withGid);
    }
  }

  let lastErr;
  for (const c of candidates) {
    try {
      return await fetchCsvOnce(c);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof UnavailableError)) throw err;
    }
  }
  throw new UnavailableError(
    `не удалось скачать таблицу (${candidates.length} попыток): ${lastErr && lastErr.message}`,
  );
}

// ---------------------------------------------------------------------------
// Парсинг CSV одного дня
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const DATE_CELL_RE = /^\s*\d{2}\.\d{2}\.\d{4}/;

function parseBlocks(rows) {
  const blocks = [];
  let current = null;
  for (const row of rows) {
    const a = (row[0] || '').trim();
    if (DATE_CELL_RE.test(a)) {
      current = { header: row, rows: [] };
      blocks.push(current);
    } else if (current) {
      current.rows.push(row);
    }
  }
  return blocks;
}

const normGroup = (s) => String(s).replace(/\s+/g, '').toLowerCase().replace(/ё/g, 'е');

function findColumn(header, normedGroup) {
  for (let i = 2; i < header.length; i++) {
    for (const part of String(header[i]).split(',')) {
      if (normGroup(part) === normedGroup) return i;
    }
  }
  return -1;
}

function firstGroupCol(header) {
  for (let i = 2; i < header.length; i++) {
    if (String(header[i]).trim()) return i;
  }
  return 2;
}

const TIME_RE = /(?<!\d)(\d{1,2})\.(\d{2})\s*[-–—]\s*(\d{1,2})\.(\d{2})(?!\d)/;

function timeFromCell(cell) {
  const m = TIME_RE.exec(cell || '');
  if (!m) return [null, null];
  return [`${pad(Number(m[1]))}:${m[2]}`, `${pad(Number(m[3]))}:${m[4]}`];
}

const ROOM_RE =
  /\s+(\d{1,4}[а-яёa-z]?(?:\/\d{1,4})?|спортзал|с\/?зал|актовый\s*зал|библиотека|стадион|дистанционно|онлайн)\s*$/i;
const TEACHER_RE =
  /\s+([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?)\s+([А-ЯЁ]\.?(?:\s?[А-ЯЁ]\.?)?)\s*$/;

/** «2.МДК 02.01 Пашкевич ЕЛ 22» -> { subject:'МДК 02.01', teacher:'Пашкевич Е.Л.', room:'22' } */
function parseLesson(cell) {
  const original = String(cell || '').replace(/\s+/g, ' ').trim();
  let raw = original
    .replace(/^\d+\.\s*/, '')
    .replace(/^\d{1,2}[.:]\d{2}\s*[-–—]\s*\d{1,2}[.:]\d{2}\s*/, '')
    .trim();
  if (!raw) return { subject: original, teacher: '', room: '' };

  let room = '';
  const mr = ROOM_RE.exec(raw);
  if (mr) {
    room = mr[1].replace(/\s+/g, ' ');
    raw = raw.slice(0, mr.index).trim();
  }

  let teacher = '';
  const mt = TEACHER_RE.exec(raw);
  if (mt) {
    const initials = (mt[2].match(/[А-ЯЁ]/g) || []).join('.');
    teacher = initials ? `${mt[1]} ${initials}.` : mt[1];
    raw = raw.slice(0, mt.index).trim();
  }

  const subject = raw.replace(/[\s,;]+$/, '').trim() || original;
  return { subject, teacher, room };
}

/** Структуру занятия -> строка «Предмет, Преподаватель, ауд. N». */
function lessonLine({ subject, teacher, room }) {
  const parts = [subject, teacher].filter(Boolean);
  let line = parts.join(', ') || subject;
  if (room) {
    line += /^\d{1,4}[а-яёa-z]?(?:\/\d{1,4})?$/i.test(room) ? `, ауд. ${room}` : `, ${room}`;
  }
  return line;
}

const formatLesson = (cell) => lessonLine(parseLesson(cell));

/**
 * @returns {null | Array<{ kind, start, end, subject, teacher, room, line }>}
 *          null — группа не найдена в таблице дня.
 */
function buildEntries(blocks, group) {
  const g = normGroup(group);
  let chosen = null;
  let col = -1;
  for (const b of blocks) {
    const c = findColumn(b.header, g);
    if (c >= 0) {
      chosen = b;
      col = c;
      break;
    }
  }
  if (!chosen) return null;

  const firstCol = firstGroupCol(chosen.header);
  const entries = [];

  for (const row of chosen.rows) {
    let [start, end] = timeFromCell(row[1] || '');
    const groupCell = (row[col] || '').trim();

    if (groupCell) {
      if (!start) [start, end] = timeFromCell(groupCell);
      const p = parseLesson(groupCell);
      entries.push({ kind: 'lesson', start, end, ...p, line: lessonLine(p) });
      continue;
    }

    const filled = [];
    for (let i = 2; i < row.length; i++) {
      if ((row[i] || '').trim()) filled.push([i, row[i].trim()]);
    }
    if (filled.length === 1 && filled[0][0] === firstCol) {
      let [s, e] = [start, end];
      if (!s) [s, e] = timeFromCell(filled[0][1]);
      const p = parseLesson(filled[0][1]);
      entries.push({ kind: 'event', start: s, end: e, ...p, line: lessonLine(p) });
      continue;
    }

    if (start) {
      entries.push({ kind: 'free', start, end, subject: 'пар нет', teacher: '', room: '', line: 'пар нет' });
    }
  }
  return entries;
}

/**
 * Структурированное расписание дня для рендера (эмбед или текст).
 * @returns {{ group, target, weekday, note:null|'not-found'|'no-lessons', rows: Array }}
 */
function buildScheduleData(csvText, group, target, opts = {}) {
  const blocks = parseBlocks(parseCsv(stripBom(String(csvText))));
  if (!blocks.length) throw new UnavailableError('в таблице не найдено блоков расписания');

  const entries = buildEntries(blocks, group);
  const meta = { group, target, weekday: weekdayRu(target) };

  if (entries === null) return { ...meta, note: 'not-found', rows: [] };

  const realIdx = [];
  entries.forEach((e, i) => {
    if (e.kind === 'lesson' || e.kind === 'event') realIdx.push(i);
  });
  if (!realIdx.length) return { ...meta, note: 'no-lessons', rows: [] };

  let slice = entries.slice(realIdx[0], realIdx[realIdx.length - 1] + 1);
  if (opts.showGaps === false) slice = slice.filter((e) => e.kind !== 'free');

  const rows = slice.map((e) => ({
    kind: e.kind,
    time: e.start && e.end ? `${e.start}–${e.end}` : e.start || '',
    subject: e.kind === 'event' ? `🔔 ${e.subject}` : e.subject,
    room: e.room || '',
    teacher: e.teacher || '',
    line: e.line,
  }));
  return { ...meta, note: null, rows };
}

/** Тот же контент простым текстом (CLI и обратная совместимость). */
function scheduleText(data) {
  const head = `Расписание на ${fmtDM(data.target)} (${data.weekday}), группа ${data.group}:`;
  if (data.note === 'not-found') return `${head}\nГруппа не найдена в расписании на эту дату.`;
  if (data.note === 'no-lessons') return `${head}\nПар нет`;
  const lines = [head];
  for (const r of data.rows) {
    const when = r.time ? `${r.time} — ` : '';
    const prefix = r.kind === 'event' ? '🔔 ' : '';
    lines.push(when + prefix + r.line);
  }
  return lines.join('\n');
}

function buildScheduleFromCsv(csvText, group, target, opts = {}) {
  return scheduleText(buildScheduleData(csvText, group, target, opts));
}

/** Человекочитаемая ссылка на таблицу-источник (для проверки пользователем). */
function humanSheetUrl(anyUrl) {
  const m = /\/spreadsheets\/d\/(?:e\/)?([a-zA-Z0-9_-]+)/.exec(anyUrl || '');
  return m ? `https://docs.google.com/spreadsheets/d/${m[1]}/edit` : null;
}

/**
 * Полный путь: календарь -> CSV -> текст + ссылка на источник.
 * Бросает NotPublishedError / UnavailableError.
 */
async function getSchedule(group, target, opts = {}) {
  const url = await resolveSheetUrl(cfg.calendarUrl, target);
  const csv = await downloadCsv(url);
  return {
    data: buildScheduleData(csv, group, target, opts),
    sheetUrl: url,
    humanUrl: humanSheetUrl(url),
  };
}

const getScheduleText = async (group, target, opts = {}) =>
  scheduleText((await getSchedule(group, target, opts)).data);

// ---------------------------------------------------------------------------
// Список всех групп (для выпадающего меню). Кэш на 1 час.
// ---------------------------------------------------------------------------

let _groupsCache = { at: 0, list: [] };

async function listAllGroups({ maxAgeMs = 60 * 60 * 1000 } = {}) {
  if (_groupsCache.list.length && Date.now() - _groupsCache.at < maxAgeMs) {
    return _groupsCache.list;
  }
  const url = await resolveLatestSheetUrl(cfg.calendarUrl);
  const csv = await downloadCsv(url);
  const blocks = parseBlocks(parseCsv(stripBom(String(csv))));

  const seen = new Map(); // norm -> оригинальное написание
  for (const b of blocks) {
    for (let i = 2; i < b.header.length; i++) {
      for (const part of String(b.header[i]).split(',')) {
        const name = part.replace(/\s+/g, ' ').trim();
        if (name && !seen.has(normGroup(name))) seen.set(normGroup(name), name);
      }
    }
  }
  const list = [...seen.values()].sort((a, b) => a.localeCompare(b, 'ru'));
  if (list.length) _groupsCache = { at: Date.now(), list };
  return list;
}

module.exports = {
  NotPublishedError,
  UnavailableError,
  weekdayRu,
  fmtDM,
  fmtDMY,
  normGroup,
  humanSheetUrl,
  // высокоуровневое
  getSchedule,
  getScheduleText,
  resolveSheetUrl,
  resolveLatestSheetUrl,
  downloadCsv,
  buildScheduleData,
  buildScheduleFromCsv,
  scheduleText,
  listAllGroups,
  // низкоуровневое (для тестов)
  parseCsv,
  parseBlocks,
  buildEntries,
  parseLesson,
  formatLesson,
  extractSheetLinks,
  findSheetUrl,
};

// --- Ручная проверка: node scheduleSource.js <группа> [дд.мм.гггг] ---
if (require.main === module) {
  (async () => {
    const group = process.argv[2];
    if (!group) {
      console.error('Использование: node scheduleSource.js <группа> [дд.мм.гггг]');
      process.exit(1);
    }
    let target;
    if (process.argv[3]) {
      const [d, mo, y] = process.argv[3].split('.').map(Number);
      target = { y, mo, d };
    } else {
      const n = new Date();
      n.setDate(n.getDate() + 1);
      target = { y: n.getFullYear(), mo: n.getMonth() + 1, d: n.getDate() };
    }
    try {
      console.log(await getScheduleText(group, target));
    } catch (err) {
      if (err instanceof NotPublishedError) console.log('Расписание на эту дату ещё не опубликовано.');
      else console.log('Ошибка:', err.message);
      process.exitCode = 2;
    }
  })();
}
