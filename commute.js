'use strict';

// Общая (не привязанная к площадке) логика для связки автобуса/учёбы с погодой:
//  - nextTrip()              — «ближайший» рейс в списке (та же логика, что раньше
//                               была продублирована внутри busLine() в каждом menu.js);
//  - weatherHighlightWindows() — какие часы погоды стоит подсветить: момент выхода
//                               из дома (отправление рейса «домой -> город», ±1ч),
//                               момент возвращения домой (прибытие рейса «город ->
//                               домой», ±1ч) и сама учёба (первая пара -1ч .. последняя +1ч);
//  - rangeOverlapsWindows()    — попадает ли диапазон погоды (weather.js: fromMin/toMin)
//                               в одно из этих окон.

const D = require('./dates');

/** Тот же рейс, что показывается как «Ближайший» — первый с отправлением в будущем (на сегодня) либо первый по расписанию (на другой день). */
function nextTrip(rows, target) {
  const isToday = D.iso(target) === D.iso(D.todayParts());
  const dated = (rows || []).map((r) => ({ ...r, epoch: r.depHHMM ? D.epochAt(target, r.depHHMM) : null }));
  if (!dated.length) return null;
  const now = Date.now();
  return (isToday ? dated.find((r) => r.epoch && r.epoch * 1000 > now) : dated[0]) || null;
}

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/**
 * @param {{toCityRows: object[], toHomeRows: object[], target: object, lessons: object[]}} p
 *   toCityRows/toHomeRows — рейсы «домой -> город» / «город -> домой» (busSource.js);
 *   lessons — строки расписания с kind:'lesson' (нужны start/end).
 * @returns {Array<{start:number, end:number}>} окна в минутах от начала суток
 */
function weatherHighlightWindows({ toCityRows, toHomeRows, target, lessons } = {}) {
  const windows = [];
  const leave = nextTrip(toCityRows, target); // домой -> город: выходишь из дома к этому отправлению
  if (leave && leave.depHHMM) {
    const m = toMin(leave.depHHMM);
    windows.push({ start: m - 60, end: m + 60 });
  }
  const back = nextTrip(toHomeRows, target); // город -> домой: возвращаешься домой к этому прибытию
  if (back && back.arrHHMM) {
    const m = toMin(back.arrHHMM);
    windows.push({ start: m - 60, end: m + 60 });
  }
  if (Array.isArray(lessons) && lessons.length) {
    const first = lessons[0];
    const last = lessons[lessons.length - 1];
    if (first.start && last.end) {
      windows.push({ start: toMin(first.start) - 60, end: toMin(last.end) + 60 });
    }
  }
  return windows;
}

/** Пересекается ли диапазон погоды (весь час from..to+1ч) хотя бы с одним окном. */
function rangeOverlapsWindows(range, windows) {
  if (!windows || !windows.length || range.fromMin == null || range.toMin == null) return false;
  const end = range.toMin + 60;
  return windows.some((w) => range.fromMin < w.end && end > w.start);
}

module.exports = { nextTrip, weatherHighlightWindows, rangeOverlapsWindows };
