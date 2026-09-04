'use strict';

// Рендер расписания дня в PNG. Всё best-effort: если @napi-rs/canvas или шрифт
// недоступны — available() вернёт false, вызывающий код откатится на текст.

const path = require('path');
const D = require('./dates');

let canvas = null;
let fontFamily = 'sans-serif';

try {
  canvas = require('@napi-rs/canvas');
  try {
    const base = path.dirname(require.resolve('@fontsource/roboto/package.json'));
    for (const f of [
      'roboto-cyrillic-400-normal.woff',
      'roboto-latin-400-normal.woff',
      'roboto-cyrillic-700-normal.woff',
      'roboto-latin-700-normal.woff',
    ]) {
      try {
        canvas.GlobalFonts.registerFromPath(path.join(base, 'files', f), 'Sched');
      } catch {
        /* конкретный файл не нашёлся — пробуем следующий */
      }
    }
    if (canvas.GlobalFonts.families.some((x) => x.family === 'Sched')) fontFamily = 'Sched';
  } catch {
    /* @fontsource не установлен — останется sans-serif (на alpine может не быть глифов) */
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
  const F = fontFamily;

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
    ctx.fillText(`${r.start}–${r.end}`, padX + 16, y + 45);

    const tx = padX + 128;
    if (r.kind === 'free') {
      ctx.fillStyle = CL.dim;
      ctx.font = `400 16px ${F}`;
      ctx.fillText('— окно —', tx, y + 37);
    } else {
      const subj = r.kind === 'event' ? String(r.subject).replace(/^🔔\s*/, '● ') : r.subject;
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 16px ${F}`;
      ctx.fillText(fit(ctx, subj, W - tx - padX - 10), tx, y + 25);
      ctx.fillStyle = CL.dim;
      ctx.font = `400 13px ${F}`;
      const meta = [r.teacher, r.room && `ауд. ${r.room}`].filter(Boolean).join('   ·   ');
      ctx.fillText(fit(ctx, meta, W - tx - padX - 10), tx, y + 46);
    }
    y += rowH + gap;
  }

  return cv.toBuffer('image/png');
}

module.exports = { available, renderScheduleImage };
