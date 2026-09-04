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

module.exports = {
  pad,
  tzNow,
  todayParts,
  tomorrowParts,
  shiftParts,
  iso,
  partsFromIso,
  isoShift,
  weekdayRu,
  weekdayIso,
  fmtDM,
  fmtDMY,
  parseHHMM,
};
