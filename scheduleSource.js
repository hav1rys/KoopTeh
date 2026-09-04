'use strict';

// Скрапинг страницы-календаря koopteh10.ru + парсинг Google-таблицы дня (CSV).
// Без кэширования: каждый вызов заново тянет свежие данные.

const cfg = require('./config');

class NotPublishedError extends Error {} // на эту дату ещё нет ссылки в календаре
class UnavailableError extends Error {}  // сайт/таблица недоступны или не читаются

const WEEKDAYS_RU = [
  'воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота',
];
const UA = 'KoopTehScheduleBot/1.0 (+Discord schedule bot)';

const pad = (n) => String(n).padStart(2, '0');
const weekdayRu = (t) => WEEKDAYS_RU[new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay()];
const fmtDM = (t) => `${pad(t.d)}.${pad(t.mo)}`;
const fmtDMY = (t) => `${pad(t.d)}.${pad(t.mo)}.${t.y}`;

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

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ');
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x2f;/gi, '/');
}

function toCsvUrl(href, gid) {
  let m = /\/spreadsheets\/d\/e\/([a-zA-Z0-9_-]+)/.exec(href);
  if (m) return `https://docs.google.com/spreadsheets/d/e/${m[1]}/pub?output=csv&gid=${gid}`;
  m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(href);
  if (m) return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
  return null;
}

/**
 * Возвращает Map ключ -> csvUrl.
 * Ключи: "dd.mm.yyyy" и "dd.mm" (если рядом со ссылкой нашлась полная дата),
 * иначе число дня месяца (1..31).
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

    const gidM = /[?&#]gid=(\d+)/.exec(href);
    const csvUrl = toCsvUrl(href, gidM ? gidM[1] : '0');
    if (!csvUrl) continue;

    const anchorText = stripTags(chunk).replace(/\s+/g, ' ').trim();

    // 1) Полная дата прямо в тексте ссылки — самый надёжный вариант.
    const full = /\b(\d{2})\.(\d{2})\.(\d{4})\b/.exec(anchorText);
    if (full) {
      out.set(`${full[1]}.${full[2]}.${full[3]}`, csvUrl);
      out.set(`${full[1]}.${full[2]}`, csvUrl);
      continue;
    }

    // 2) Число дня месяца в тексте ссылки (обычный случай: <a ...>9</a>).
    let day = daysInRange(anchorText)[0] ?? null;

    // 3) Иначе — ближайшее число перед ссылкой (напр. <span>9</span><a>…</a>).
    if (day == null) {
      const before = stripTags(html.slice(Math.max(0, m.index - 90), m.index)).replace(/\s+/g, ' ');
      const nums = daysInRange(before);
      if (nums.length) day = nums[nums.length - 1];
    }

    if (day != null && !out.has(day)) out.set(day, csvUrl);
  }
  return out;
}

/** Все «одинокие» числа 1..31 в тексте, в порядке появления. */
function daysInRange(text) {
  return (text.match(/(?<!\d)[0-3]?\d(?!\d)/g) || [])
    .map(Number)
    .filter((v) => v >= 1 && v <= 31);
}

function findSheetUrl(links, t) {
  return (
    links.get(fmtDMY(t)) ||
    links.get(fmtDM(t)) ||
    links.get(t.d) ||
    null
  );
}

async function resolveSheetUrl(calendarUrl, target) {
  const html = await httpGetText(calendarUrl);
  const url = findSheetUrl(extractSheetLinks(html), target);
  if (!url) throw new NotPublishedError(`нет ссылки на расписание для ${fmtDMY(target)}`);
  return url;
}

async function downloadCsv(url) {
  const { headers, body } = await httpGet(url);
  const ctype = headers.get('content-type') || '';
  if (!/csv/i.test(ctype) && body.trimStart().startsWith('<')) {
    throw new UnavailableError('таблица недоступна как CSV (проверьте публичный доступ к документу)');
  }
  return body;
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
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const DATE_CELL_RE = /^\s*\d{2}\.\d{2}\.\d{4}/;

/** Разбивает строки на блоки по строкам-заголовкам (в столбце A — дата). */
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

/** «2.МДК 02.01 Пашкевич ЕЛ 22» -> «МДК 02.01, Пашкевич Е.Л., ауд. 22». */
function formatLesson(cell) {
  const original = String(cell || '').trim();
  let raw = original
    .replace(/^\s*\d+\.\s*/, '') // ведущий номер пары «2.»
    .replace(/^\s*\d{1,2}[.:]\d{2}\s*[-–—]\s*\d{1,2}[.:]\d{2}\s*/, '') // ведущее время в самой ячейке
    .trim();
  if (!raw) return original;

  let room = null;
  const mr = ROOM_RE.exec(raw);
  if (mr) {
    room = mr[1].replace(/\s+/g, ' ');
    raw = raw.slice(0, mr.index).trim();
  }

  let teacher = null;
  const mt = TEACHER_RE.exec(raw);
  if (mt) {
    const initials = (mt[2].match(/[А-ЯЁ]/g) || []).join('.');
    teacher = initials ? `${mt[1]} ${initials}.` : mt[1];
    raw = raw.slice(0, mt.index).trim();
  }

  const subject = raw.replace(/[\s,;]+$/, '').trim();
  const parts = [subject, teacher].filter(Boolean);
  let line = parts.length ? parts.join(', ') : original;
  if (room) {
    line += /^\d{1,4}[а-яёa-z]?(?:\/\d{1,4})?$/i.test(room) ? `, ауд. ${room}` : `, ${room}`;
  }
  return line;
}

/**
 * Список занятий группы за день.
 * @returns {null | Array<{ kind: 'lesson'|'event'|'free', start: string|null, end: string|null, text: string }>}
 *          null — группа не найдена в таблице этого дня.
 */
function buildEntries(blocks, group) {
  const g = normGroup(group);
  let chosen = null;
  let col = -1;
  for (const b of blocks) {
    const c = findColumn(b.header, g);
    if (c >= 0) { chosen = b; col = c; break; }
  }
  if (!chosen) return null;

  const firstCol = firstGroupCol(chosen.header);
  const entries = [];

  for (const row of chosen.rows) {
    let [start, end] = timeFromCell(row[1] || '');
    const groupCell = (row[col] || '').trim();

    if (groupCell) {
      if (!start) [start, end] = timeFromCell(groupCell);
      entries.push({ kind: 'lesson', start, end, text: formatLesson(groupCell) });
      continue;
    }

    // Общекурсовое событие: во всей строке справа от столбца B заполнена
    // ровно одна ячейка, и это первая групповая колонка блока
    // (объединённая ячейка в Google Sheets кладёт значение именно туда).
    const filled = [];
    for (let i = 2; i < row.length; i++) {
      if ((row[i] || '').trim()) filled.push([i, row[i].trim()]);
    }
    if (filled.length === 1 && filled[0][0] === firstCol) {
      let [s, e] = [start, end];
      if (!s) [s, e] = timeFromCell(filled[0][1]);
      entries.push({ kind: 'event', start: s, end: e, text: formatLesson(filled[0][1]) });
      continue;
    }

    // Реальный тайм-слот, но у нашей группы в это время ничего нет — «окно».
    if (start) entries.push({ kind: 'free', start, end, text: 'пар нет' });
    // Полностью пустая строка — пропускаем.
  }
  return entries;
}

function formatMessage(entries, group, target) {
  const head = `Расписание на ${fmtDM(target)} (${weekdayRu(target)}), группа ${group}:`;
  if (entries === null) return `${head}\nГруппа не найдена в расписании на эту дату.`;

  const realIdx = [];
  entries.forEach((e, i) => {
    if (e.kind === 'lesson' || e.kind === 'event') realIdx.push(i);
  });
  if (!realIdx.length) return `${head}\nПар нет`;

  // Отрезаем ведущие/замыкающие «пар нет», внутренние окна оставляем.
  const slice = entries.slice(realIdx[0], realIdx[realIdx.length - 1] + 1);
  const lines = [head];
  for (const e of slice) {
    let when = '';
    if (e.start && e.end) when = `${e.start}–${e.end} — `;
    else if (e.start) when = `${e.start} — `;
    lines.push(when + (e.kind === 'event' ? '🔔 ' : '') + e.text);
  }
  return lines.join('\n');
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function buildScheduleFromCsv(csvText, group, target) {
  const rows = parseCsv(stripBom(String(csvText)));
  const blocks = parseBlocks(rows);
  if (!blocks.length) throw new UnavailableError('в таблице не найдено блоков расписания');
  return formatMessage(buildEntries(blocks, group), group, target);
}

/** Полный путь: календарь -> CSV -> текст сообщения. Бросает NotPublishedError / UnavailableError. */
async function getScheduleText(group, target) {
  const url = await resolveSheetUrl(cfg.calendarUrl, target);
  const csv = await downloadCsv(url);
  return buildScheduleFromCsv(csv, group, target);
}

module.exports = {
  NotPublishedError,
  UnavailableError,
  weekdayRu,
  fmtDM,
  fmtDMY,
  // высокоуровневое
  getScheduleText,
  resolveSheetUrl,
  downloadCsv,
  buildScheduleFromCsv,
  // низкоуровневое (для тестов)
  parseCsv,
  parseBlocks,
  buildEntries,
  formatMessage,
  formatLesson,
  extractSheetLinks,
  findSheetUrl,
};

// --- Ручная проверка из терминала: node scheduleSource.js <группа> [дд.мм.гггг] ---
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
