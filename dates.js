'use strict';

// Работа с датами в целевом часовом поясе (cfg.timezone).
// Дата-объект здесь — простой { y, mo, d } (mo: 1..12).

const cfg = require('./config');

const pad = (n) => String(n).padStart(2, '0');
const WD_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function tzNow() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: cfg.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return {
    y: +p.year,
    mo: +p.month,
    d: +p.day,
    h: +(p.hour === '24' ? 0 : p.hour),
    mi: +p.minute,
  };
}

const todayParts = () => {
  const n = tzNow();
  return { y: n.y, mo: n.mo, d: n.d };
};

function shiftParts(t, deltaDays) {
  const dt = new Date(Date.UTC(t.y, t.mo - 1, t.d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

const tomorrowParts = () => shiftParts(todayParts(), 1);

/** Понедельник недели, содержащей t. */
const mondayOf = (t) => shiftParts(t, 1 - weekdayIso(t));

const iso = (t) => `${t.y}-${pad(t.mo)}-${pad(t.d)}`;

function partsFromIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return null;
  const t = { y: +m[1], mo: +m[2], d: +m[3] };
  const dt = new Date(Date.UTC(t.y, t.mo - 1, t.d));
  if (dt.getUTCFullYear() !== t.y || dt.getUTCMonth() !== t.mo - 1 || dt.getUTCDate() !== t.d) return null;
  return t;
}

const isoShift = (s, delta) => {
  const t = partsFromIso(s);
  return t ? iso(shiftParts(t, delta)) : s;
};

const weekdayRu = (t) => WD_RU[new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay()];
// ISO-номер дня недели: Пн=1 … Вс=7
const weekdayIso = (t) => ((new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay() + 6) % 7) + 1;

const fmtDM = (t) => `${pad(t.d)}.${pad(t.mo)}`;
const fmtDMY = (t) => `${pad(t.d)}.${pad(t.mo)}.${t.y}`;

/** "19:00" -> "19:00" (нормализовано), мусор -> null. */
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const hh = +m[1];
  const mm = +m[2];
  if (hh > 23 || mm > 59) return null;
  return `${pad(hh)}:${pad(mm)}`;
}

/** "10:00" -> 600 (минуты от полуночи); мусор -> null. */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  return m ? +m[1] * 60 + +m[2] : null;
}

/**
 * Unix-время (секунды) для «дата dateParts + время hhmm» в поясе TIMEZONE.
 * Нужно для Discord-таймстампов <t:SEC:R>, которые обновляются на клиенте сами.
 */
function epochAt(dateParts, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m || !dateParts) return null;
  const asUTC = Date.UTC(dateParts.y, dateParts.mo - 1, dateParts.d, +m[1], +m[2], 0);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: cfg.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date(asUTC))
      .map((x) => [x.type, x.value]),
  );
  const seenUTC = Date.UTC(
    +p.year,
    +p.month - 1,
    +p.day,
    +(p.hour === '24' ? 0 : p.hour),
    +p.minute,
    +p.second,
  );
  // seenUTC - asUTC = сдвиг пояса; вычитаем его из asUTC, получаем настоящий момент.
  return Math.floor((asUTC - (seenUTC - asUTC)) / 1000);
}

/**
 * Ближайшая дата ежедневной рассылки (unix-секунды) или null.
 * Рассылка идёт в день X в hhmm, если день недели X+1 входит в days.
 */
function nextBroadcast(days, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m || !Array.isArray(days) || !days.length) return null;
  const bMin = +m[1] * 60 + +m[2];
  const now = tzNow();
  const nowMin = now.h * 60 + now.mi;
  for (let i = 0; i <= 14; i++) {
    const sendDay = shiftParts(todayParts(), i);
    if (!days.includes(weekdayIso(shiftParts(sendDay, 1)))) continue;
    if (i === 0 && bMin <= nowMin) continue;
    return epochAt(sendDay, hhmm);
  }
  return null;
}

module.exports = {
  pad,
  tzNow,
  todayParts,
  tomorrowParts,
  mondayOf,
  shiftParts,
  iso,
  partsFromIso,
  isoShift,
  weekdayRu,
  weekdayIso,
  fmtDM,
  fmtDMY,
  parseHHMM,
  toMinutes,
  epochAt,
  nextBroadcast,
};
