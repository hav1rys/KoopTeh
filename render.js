'use strict';

// Рендер расписания дня в PNG. Всё best-effort: если @napi-rs/canvas или шрифт
// недоступны — available() вернёт false, вызывающий код откатится на текст.

const path = require('path');
const D = require('./dates');

let canvas = null;
// latin-семейство первым (цифры, ':', '.', '·'), кириллица как fallback по глифам.
let FONT = 'sans-serif';

try {
  canvas = require('@napi-rs/canvas');
  try {
    const base = path.dirname(require.resolve('@fontsource/roboto/package.json'));
    const reg = (file, family) => {
      try {
        canvas.GlobalFonts.registerFromPath(path.join(base, 'files', file), family);
        return true;
      } catch {
        return false;
      }
    };
    // 400 и 700 регистрируем под одним именем семейства — canvas сам выберет вес.
    reg('roboto-latin-400-normal.woff', 'RobotoL');
    reg('roboto-latin-700-normal.woff', 'RobotoL');
    const okL = canvas.GlobalFonts.families.some((x) => x.family === 'RobotoL');
    reg('roboto-cyrillic-400-normal.woff', 'RobotoC');
    reg('roboto-cyrillic-700-normal.woff', 'RobotoC');
    const okC = canvas.GlobalFonts.families.some((x) => x.family === 'RobotoC');
    const list = [];
    if (okL) list.push('"RobotoL"');
    if (okC) list.push('"RobotoC"');
    list.push('sans-serif');
    FONT = list.join(', ');
    // без нормального шрифта картинка нечитаемая — тогда лучше отключить её вовсе
    if (!okL && !okC) canvas = null;
  } catch {
    /* @fontsource не установлен — останется sans-serif (на alpine глифов может не быть) */
  }
} catch {
  canvas = null;
}

const available = () => Boolean(canvas);

const CL = {
  bg: '#1e1f22',
  card: '#2b2d31',
  cardNow: '#2f3b2e',
  weekday: '#2b6cb0',
  weekend: '#5c636a',
  none: '#2f9e44',
  text: '#e8e8e8',
  dim: '#9aa0a6',
  accent: '#f2c94c',
  now: '#3ba55d',
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fit(ctx, s, maxW) {
  s = String(s || '');
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

/** @returns {Buffer|null} PNG или null, если рендер недоступен/нечего рисовать. */
function renderScheduleImage(data) {
  if (!canvas || (data.mode || 'group') !== 'group' || data.note || !data.rows.length) return null;

  const rows = data.rows;
  const W = 760;
  const padX = 26;
  const headH = 92;
  const rowH = 62;
  const gap = 10;
  const H = headH + 14 + rows.length * (rowH + gap) + 10;

  const cv = canvas.createCanvas(W, H);
  const ctx = cv.getContext('2d');
  const F = FONT;

  ctx.fillStyle = CL.bg;
  ctx.fillRect(0, 0, W, H);

  const weekend = D.weekdayIso(data.target) >= 6;
  ctx.fillStyle = weekend ? CL.weekend : CL.weekday;
  ctx.fillRect(0, 0, W, headH);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 25px ${F}`;
  ctx.fillText(`Расписание на ${D.fmtDM(data.target)} (${data.weekday})`, padX, 38);
  ctx.font = `400 17px ${F}`;
  ctx.fillText(`Группа: ${data.group}`, padX, 68);

  const isToday = D.iso(data.target) === D.iso(D.todayParts());
  const now = D.tzNow();
  const nowMin = now.h * 60 + now.mi;

  let y = headH + 14;
  for (const r of rows) {
    const s = D.toMinutes(r.start);
    const e = D.toMinutes(r.end);
    const cur = isToday && r.kind === 'lesson' && s != null && e != null && s <= nowMin && nowMin < e;

    ctx.fillStyle = cur ? CL.cardNow : CL.card;
    roundRect(ctx, padX, y, W - padX * 2, rowH, 12);
    ctx.fill();
    if (cur) {
      ctx.strokeStyle = CL.now;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = CL.accent;
    ctx.font = `700 14px ${F}`;
    ctx.fillText(r.pair ? `${r.pair} пара` : '', padX + 16, y + 24);
    ctx.fillStyle = CL.text;
    ctx.font = `400 15px ${F}`;
    ctx.fillText(`${r.start}-${r.end}`, padX + 16, y + 45);

    const tx = padX + 128;
    if (r.kind === 'free') {
      ctx.fillStyle = CL.dim;
      ctx.font = `400 16px ${F}`;
      ctx.fillText('- окно -', tx, y + 37);
    } else {
      const subj = r.kind === 'event' ? String(r.subject).replace(/^🔔\s*/, '') : r.subject;
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 16px ${F}`;
      ctx.fillText(fit(ctx, subj, W - tx - padX - 10), tx, y + 25);
      ctx.fillStyle = CL.dim;
      ctx.font = `400 13px ${F}`;
      const meta = [r.teacher, r.room && `ауд. ${r.room}`].filter(Boolean).join('    ');
      ctx.fillText(fit(ctx, meta, W - tx - padX - 10), tx, y + 46);
    }
    y += rowH + gap;
  }

  return cv.toBuffer('image/png');
}

const WDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** @returns {Buffer|null} PNG обзора недели (сетка 3×2) или null. */
function renderWeekImage(week) {
  if (!canvas || !week || !Array.isArray(week.days) || !week.days.length) return null;
  const days = week.days;
  const cols = 3;
  const rowsN = Math.ceil(days.length / cols);
  const W = 1080;
  const pad = 24;
  const gap = 16;
  const cellW = (W - pad * 2 - gap * (cols - 1)) / cols;
  const headH = 68;
  const lineH = 22;
  const maxLines = 9;
  const cellH = 44 + maxLines * lineH;
  const H = headH + pad + rowsN * cellH + (rowsN - 1) * gap + pad;

  const cv = canvas.createCanvas(W, H);
  const ctx = cv.getContext('2d');
  const F = FONT;
  ctx.fillStyle = CL.bg;
  ctx.fillRect(0, 0, W, H);

  const label = days.map((d) => d.data && (d.data.group || d.data.teacher)).find(Boolean) || '';
  const mon = days[0].parts;
  const sat = days[days.length - 1].parts;
  ctx.fillStyle = CL.weekday;
  ctx.fillRect(0, 0, W, headH);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 24px ${F}`;
  ctx.fillText(`Неделя ${D.fmtDM(mon)} - ${D.fmtDM(sat)}${label ? `   ${label}` : ''}`, pad, 43);

  days.forEach((d, i) => {
    const cx = pad + (i % cols) * (cellW + gap);
    const cy = headH + pad + Math.floor(i / cols) * (cellH + gap);
    ctx.fillStyle = CL.card;
    roundRect(ctx, cx, cy, cellW, cellH, 12);
    ctx.fill();

    ctx.fillStyle = CL.accent;
    ctx.font = `700 15px ${F}`;
    ctx.fillText(`${WDAYS[D.weekdayIso(d.parts) - 1]} ${D.fmtDM(d.parts)}`, cx + 14, cy + 26);

    ctx.font = `400 13px ${F}`;
    let ly = cy + 50;
    const put = (txt, dim) => {
      ctx.fillStyle = dim ? CL.dim : CL.text;
      ctx.fillText(fit(ctx, txt, cellW - 26), cx + 14, ly);
      ly += lineH;
    };
    if (d.error) return void put(d.error, true);
    const data = d.data;
    if (!data || data.note === 'not-found') return void put('нет группы', true);
    if (data.note === 'no-lessons' || !data.rows.length) {
      return void put(data.weekend ? 'выходной' : 'пар нет', true);
    }
    for (const r of data.rows.filter((x) => x.kind !== 'free').slice(0, maxLines)) {
      const t = (r.start || '-').slice(0, 5);
      put(`${r.pair != null ? `${r.pair}· ` : ''}${t}  ${String(r.subject).replace(/^🔔\s*/, '')}`);
    }
  });

  return cv.toBuffer('image/png');
}

/** @returns {Buffer|null} PNG-карточка погоды (советы + диапазоны) или null. */
function renderWeatherImage(place, forecast) {
  if (!canvas || !forecast || !Array.isArray(forecast.ranges)) return null;
  const rows = forecast.ranges;
  const advice = forecast.advice || [];
  const W = 640;
  const padX = 24;
  const headH = 64;
  const adviceLineH = 24;
  const adviceH = advice.length ? advice.length * adviceLineH + 14 : 0;
  const rowH = 30;
  const H = headH + adviceH + rows.length * rowH + 24;

  const cv = canvas.createCanvas(W, H);
  const ctx = cv.getContext('2d');
  const F = FONT;

  ctx.fillStyle = CL.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = CL.weekday;
  ctx.fillRect(0, 0, W, headH);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 22px ${F}`;
  ctx.fillText(fit(ctx, `Погода — ${place}`, W - padX * 2), padX, 41);

  let y = headH + 26;
  ctx.font = `700 14px ${F}`;
  for (const a of advice) {
    ctx.fillStyle = CL.accent;
    ctx.fillText(fit(ctx, a, W - padX * 2), padX, y);
    y += adviceLineH;
  }
  if (advice.length) y += 8;

  ctx.font = `400 15px ${F}`;
  for (const r of rows) {
    ctx.fillStyle = CL.dim;
    ctx.fillText(r.label, padX, y);
    ctx.fillStyle = CL.text;
    ctx.fillText(`${r.icon} ${r.temp > 0 ? '+' : ''}${r.temp}°`, padX + 260, y);
    y += rowH;
  }

  return cv.toBuffer('image/png');
}

module.exports = { available, renderScheduleImage, renderWeekImage, renderWeatherImage };
