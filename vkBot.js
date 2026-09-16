'use strict';

// VK-версия бота. Обычно подключается вместе с Discord и Telegram из bot.js
// (один процесс, один и тот же users.json — Node кеширует storage.js по пути,
// так что все боты делят один и тот же объект данных без гонки).
//
// Ядро то же самое, что у Discord/Telegram: storage.js, scheduleSource.js,
// weather.js, busSource.js, dates.js, render.js, config.js. Отличается только
// этот файл (роутинг) и vkMenu.js (рендер под VK: обычный plain-text — VK не
// поддерживает HTML/markdown в сообщениях — + клавиатуры). Внутреннее
// представление кнопок {text, callback_data} такое же, как в telegramMenu.js —
// в реальную VK-клавиатуру их собирает toVkKeyboard() ниже.
//
// ВАЖНО (нюансы VK Bots API, которые важно проверить на живом тесте — Node
// недоступен в среде разработки, поэтому это не прогонялось):
//   - каждый messages.send требует random_id (для дедупликации на стороне VK);
//   - редактирование инлайн-кнопок идёт через messages.edit по
//     conversation_message_id, а не через отдельный "editMessage" у контекста
//     кнопки (message_event) — у него есть только send()/answer();
//   - у кнопок лимит 40 символов на подпись — длинные подписи обрезаются;
//   - ссылок-кнопок (openLink) не делаем — url просто печатается в тексте,
//     VK сам подсвечивает его кликабельным.

const { VK, Keyboard } = require('vk-io');
const cfg = require('./config');
const D = require('./dates');
const storage = require('./storage');
const ss = require('./scheduleSource');
const weather = require('./weather');
const bus = require('./busSource');
const vm = require('./vkMenu');
const discordLog = require('./discordLog');

if (!cfg.vkToken) {
  console.error('VK_BOT_TOKEN не задан. Добавь переменную в панели BotHost (Startup / Variables) этого сервиса.');
  process.exit(1);
}

// -------------------------------------------------------------------- логи

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const MIN_LEVEL = LEVELS[cfg.logLevel] ?? 20;
function log(level, msg) {
  if ((LEVELS[level] ?? 20) < MIN_LEVEL) return;
  const line = `${new Date().toISOString()} VK ${level} ${msg}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

// rawId() — истинный, непривязанный id именно этого VK-диалога (для приватного
// чата с ботом peer_id совпадает с user_id) — нужен только для самой операции
// привязки. uid() — id профиля, с которым реально работает вся остальная
// логика (после /связать это может быть канонический id Discord/Telegram-аккаунта).
const rawId = (peerId) => `vk:${peerId}`;
const uid = (peerId) => storage.resolveUid(rawId(peerId));

async function logToChannel(text) {
  await discordLog.send('vk', text);
}
const tag = (rawUid) => vm.code(rawUid);

/** Логирует показанный пользователю текст расписания целиком. */
async function logSchedule(rawUid, action, data) {
  if (!data) return;
  let text;
  try {
    text = ss.scheduleText(data);
  } catch {
    text = '(не удалось сформировать текст расписания)';
  }
  await logToChannel(`📋 ${tag(rawUid)} — ${action}\n${text.slice(0, 1500)}`);
}

// -------------------------------------------------------------- вспомогательное (как в telegramBot.js)

function subjOf(u) {
  if (u.role === 'teacher' && u.teacherName) return { kind: 'teacher', name: u.teacherName };
  if (u.group) return { kind: 'group', name: u.group };
  if (u.teacherName) return { kind: 'teacher', name: u.teacherName };
  return null;
}
const subjKey = (subj) => (subj.kind === 'teacher' ? `t:${ss.normName(subj.name)}` : `g:${ss.normGroup(subj.name)}`);

function buildDayData(csvText, subj, target, opts = {}) {
  return subj.kind === 'teacher' ? ss.buildTeacherData(csvText, subj.name, target) : ss.buildScheduleData(csvText, subj.name, target, opts);
}

function effState(rawUid) {
  const s = storage.get(rawUid);
  return {
    group: s.group,
    teacherName: s.teacherName,
    role: s.role,
    subj: subjOf(s),
    subscribed: s.subscribed,
    time: s.time || cfg.defaultTime,
    customTime: Boolean(s.time),
    days: Array.isArray(s.days) ? s.days : cfg.defaultDays,
    showGaps: s.showGaps,
    format: s.format,
    reminderMinutes: s.reminderMinutes,
    morning: s.morning,
    morningTime: s.morningTime,
    morningGreeting: s.morningGreeting,
    pausedUntil: s.pausedUntil,
    away: s.away,
    homePlace: s.homePlace,
    homeStop: s.homeStop,
    homeLat: s.homeLat,
    homeLon: s.homeLon,
    weatherFormat: s.weatherFormat || 'embed',
  };
}

const isPaused = (pausedUntil) => Boolean(pausedUntil) && pausedUntil > D.iso(D.todayParts());

function attachNotes(data, rawUid, iso) {
  if (!data || (data.mode || 'group') !== 'group' || !Array.isArray(data.rows)) return data;
  const notes = storage.getNotesForDay(rawUid, iso);
  if (!notes || !Object.keys(notes).length) return data;
  return { ...data, rows: data.rows.map((r) => (r.pair != null && notes[r.pair] ? { ...r, note: notes[r.pair] } : r)) };
}

function menuView(rawUid) {
  const s = effState(rawUid);
  const paused = isPaused(s.pausedUntil);
  const nb = s.subj && s.subscribed && !paused ? D.nextBroadcast(s.days, s.time) : null;
  let nextPair = null;
  if (s.subj) {
    try {
      const today = D.todayParts();
      const csv = ss.peekCachedDay(today);
      if (csv) {
        const data = buildDayData(csv, s.subj, today, {});
        nextPair = nextPairLineSafe(data);
      }
      if (!nextPair) {
        const csvT = ss.peekCachedDay(D.tomorrowParts());
        if (csvT) {
          const data = buildDayData(csvT, s.subj, D.tomorrowParts(), {});
          nextPair = nextPairLineSafe(data);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return vm.buildMenu(s, {
    nextBroadcastEpoch: nb,
    nextPair,
    pausedUntil: paused ? s.pausedUntil : null,
    showBus: Boolean(s.away && s.homePlace),
  });
}

function nextPairLineSafe(data) {
  try {
    const msg = vm.buildNowMessage(data, '');
    const lines = msg.text.split('\n');
    return lines[1] || null;
  } catch {
    return null;
  }
}

const notPublishedText = (t) => `Расписание на ${ss.fmtDM(t)} (${ss.weekdayRu(t)}) ещё не опубликовано на сайте.`;

async function safeSchedule(subj, target, showGaps) {
  try {
    const { csvText, humanUrl } = await ss.fetchDayCsv(target, 0);
    return { data: buildDayData(csvText, subj, target, { showGaps }), url: humanUrl, error: null };
  } catch (err) {
    if (err instanceof ss.NotPublishedError) return { data: null, url: null, error: notPublishedText(target) };
    log('WARN', `расписание (${subj.kind}:${subj.name}, ${ss.fmtDMY(target)}): ${err.message}`);
    return { data: null, url: null, error: 'Не удалось получить расписание, попробуй позже.' };
  }
}

// -------------------------------------------------------------------- бот

const vk = new VK({ token: cfg.vkToken });

const randomId = () => Math.floor(Math.random() * 2 ** 31) - 2 ** 30;

/** {text, callback_data}[][] (как в telegramMenu.js) -> реальная inline-клавиатура VK. */
function toVkKeyboard(rows) {
  if (!rows || !rows.length) return null;
  const kb = Keyboard.builder().inline();
  for (let i = 0; i < rows.length; i++) {
    for (const btn of rows[i]) {
      const cb = btn.callback_data;
      if (!cb || cb === 'noop') continue;
      kb.callbackButton({ label: String(btn.text).slice(0, 40), payload: { d: cb } });
    }
    if (i < rows.length - 1) kb.row();
  }
  return kb;
}

/** Единый рендер payload'а {text|photo, keyboard} — редактирует cmid, если можно, иначе шлёт новое. */
async function render(peerId, cmid, payload) {
  const kb = toVkKeyboard(payload.keyboard);
  if (payload.photo) {
    let attachment;
    try {
      const uploaded = await vk.upload.messagePhoto({ peer_id: peerId, source: { value: payload.photo } });
      attachment = String(uploaded);
    } catch (err) {
      log('WARN', `загрузка фото: ${err.message}`);
      return void (await render(peerId, cmid, { text: payload.caption || 'Не удалось отправить картинку.', keyboard: payload.keyboard }));
    }
    const sent = await vk.api.messages.send({
      peer_id: peerId,
      message: (payload.caption || '').slice(0, 900),
      attachment,
      keyboard: kb ? String(kb) : undefined,
      random_id: randomId(),
    });
    return sent;
  }
  const text = (payload.text || 'Пусто.').slice(0, 4000);
  if (cmid) {
    try {
      await vk.api.messages.edit({
        peer_id: peerId,
        conversation_message_id: cmid,
        message: text,
        keyboard: kb ? String(kb) : undefined,
      });
      return cmid;
    } catch (err) {
      log('DEBUG', `messages.edit fallback: ${err.message}`);
    }
  }
  const sent = await vk.api.messages.send({ peer_id: peerId, message: text, keyboard: kb ? String(kb) : undefined, random_id: randomId() });
  return sent;
}

/** Новое сообщение (не редактирует) — для «Прислать отдельно», рассылок и т.д. */
async function send(peerId, payload) {
  if (payload.photo) {
    let attachment;
    try {
      const uploaded = await vk.upload.messagePhoto({ peer_id: peerId, source: { value: payload.photo } });
      attachment = String(uploaded);
    } catch (err) {
      log('WARN', `загрузка фото: ${err.message}`);
      return vk.api.messages.send({ peer_id: peerId, message: (payload.caption || '').slice(0, 4000), random_id: randomId() });
    }
    return vk.api.messages.send({ peer_id: peerId, message: (payload.caption || '').slice(0, 900), attachment, random_id: randomId() });
  }
  return vk.api.messages.send({ peer_id: peerId, message: (payload.text || '').slice(0, 4000), random_id: randomId() });
}

const awaiting = new Map();
const groupCache = new Map();
const lookupState = new Map();
const weekState = new Map();
const busCache = new Map();

// Текст постоянной клавиатуры снизу (vm.mainReplyKeyboard()) приходит как обычное
// текстовое сообщение — сверяем по точному тексту кнопки и прогоняем через тот же
// onMenuButton, что и inline-кнопки меню.
const KEYBOARD_LABELS = {
  '📅 Расписание': 'schedule',
  '📅 Неделя': 'week',
  '📨 На завтра': 'now',
  '⚙️ Настройки': 'settings',
  '🔍 Поиск': 'search',
  '👨‍🏫 Преподаватель': 'teacher',
  '🔔 Звонки': 'bell',
  '🚪 Кабинеты': 'rooms',
  '🌤 Погода': 'weather',
  '🚌 Автобус': 'bus',
  '❓ Вопрос': 'ask',
  'ℹ️ Помощь': 'help',
};
const sendAsAck = (peerId) => async (text) => {
  if (text) await send(peerId, { text });
};

/** дд.мм[.гггг] -> {y,mo,d}. Некорректно -> null. */
function parseDateField(raw) {
  const s = String(raw || '').trim();
  if (!s) return D.todayParts();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return D.partsFromIso(`${m[3]}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`);
  m = /^(\d{1,2})\.(\d{1,2})$/.exec(s);
  if (!m) return null;
  const now = D.todayParts();
  const cand = D.partsFromIso(`${now.y}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`);
  if (!cand) return null;
  const ord = (o) => o.y * 400 + o.mo * 31 + o.d;
  return ord(cand) < ord(now) - 40 ? D.partsFromIso(`${now.y + 1}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`) : cand;
}

// ---------------------------------------------------------------- команды

async function sendMainMenu(peerId, rawUid) {
  const view = menuView(rawUid);
  await send(peerId, view);
  // VK, как и Telegram, не совмещает inline- и постоянную клавиатуру на одном
  // сообщении — ставим постоянную снизу вторым, коротким сообщением.
  await vk.api.messages.send({
    peer_id: peerId,
    message: 'Кнопки снизу — быстрый доступ к основным разделам в любой момент.',
    keyboard: String(
      vm.mainReplyKeyboard().reduce((kb, row, i, arr) => {
        for (const label of row) kb.textButton({ label: label.slice(0, 40), payload: { d: `kb:${label}` } });
        if (i < arr.length - 1) kb.row();
        return kb;
      }, Keyboard.builder()),
    ),
    random_id: randomId(),
  });
}

async function runLookup(kind, params, target) {
  const { csvText, humanUrl } = await ss.fetchDayCsv(target, 0);
  const data = kind === 'teacher' ? ss.buildTeacherData(csvText, params.surname, target) : ss.searchSchedule(csvText, params, target);
  return { data, humanUrl };
}

async function showLookup(peerId, rawUid, kind, params, target, { fresh = false, cmid = null } = {}) {
  lookupState.set(rawUid, { kind, params, iso: D.iso(target) });
  let payload;
  try {
    const { data, humanUrl } = await runLookup(kind, params, target);
    payload = { text: vm.scheduleText(data, humanUrl).slice(0, 4000), keyboard: vm.lookupKeyboard(data) };
    const label = kind === 'teacher' ? `поиск преподавателя «${params.surname}»` : 'поиск по кабинету/преподавателю';
    await logSchedule(rawUid, `${label} на ${D.fmtDM(target)}`, data);
  } catch (err) {
    const msg = err instanceof ss.NotPublishedError ? notPublishedText(target) : 'Не удалось выполнить поиск, попробуй позже.';
    if (!(err instanceof ss.NotPublishedError)) log('WARN', `lookup ${kind}: ${err.message}`);
    payload = { text: msg, keyboard: vm.lookupKeyboard(null) };
  }
  if (fresh) await send(peerId, payload);
  else await render(peerId, cmid, payload);
}

async function loadWeekDays(subj, mondayParts) {
  const days = [];
  for (let i = 0; i < 6; i++) {
    const parts = D.shiftParts(mondayParts, i);
    try {
      const { csvText } = await ss.fetchDayCsv(parts, 5 * 60 * 1000);
      days.push({ parts, data: buildDayData(csvText, subj, parts, { showGaps: false }) });
    } catch (err) {
      days.push({ parts, error: err instanceof ss.NotPublishedError ? 'не опубликовано' : 'ошибка' });
    }
  }
  return days;
}

async function renderWeek(peerId, cmid, rawUid, mondayParts) {
  const s = effState(rawUid);
  const days = await loadWeekDays(s.subj, mondayParts);
  weekState.set(rawUid, D.iso(mondayParts));
  const view = vm.buildWeekView({ days });
  await render(peerId, cmid, view);
}

async function renderWeatherView(peerId, cmid, rawUid, targetIso) {
  const s = effState(rawUid);
  try {
    const cityForecast = await weather.dayForecast(cfg.weatherLat, cfg.weatherLon, targetIso);
    let homeInfo = null;
    if (s.away && s.homePlace && s.homeLat != null && s.homeLon != null) {
      const homeForecast = await weather.dayForecast(s.homeLat, s.homeLon, targetIso);
      homeInfo = { place: s.homePlace, forecast: homeForecast };
    }
    const t = D.partsFromIso(targetIso) || D.todayParts();
    const dateLabel = `${D.fmtDM(t)} (${D.weekdayRu(t)})`;
    const view = vm.buildWeatherPanel(homeInfo, { place: cfg.weatherPlace, forecast: cityForecast }, targetIso, dateLabel);
    await render(peerId, cmid, view);
  } catch (err) {
    log('WARN', `погода: ${err.message}`);
    await render(peerId, cmid, { text: 'Не удалось получить погоду, попробуй позже.' });
  }
}

async function loadBusData(rawUid, s, force = false) {
  const hit = busCache.get(rawUid);
  if (!force && hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;
  const opts = { stop: s.homeStop };
  const [toHomeRows, toCityRows] = await Promise.all([
    bus.toHome(s.homePlace, opts).catch((err) => {
      log('WARN', `автобус (домой, ${rawUid}): ${err.message}`);
      return [];
    }),
    bus.toCity(s.homePlace, opts).catch((err) => {
      log('WARN', `автобус (в город, ${rawUid}): ${err.message}`);
      return [];
    }),
  ]);
  const data = {
    at: Date.now(),
    place: s.homePlace,
    toHomeRows,
    toCityRows,
    toHomeUrl: bus.sourceUrl('toHome', s.homePlace, s.homeStop),
    toCityUrl: bus.sourceUrl('toCity', s.homePlace, s.homeStop),
  };
  busCache.set(rawUid, data);
  return data;
}

async function renderBusView(peerId, cmid, rawUid, targetIso, force = false) {
  const s = effState(rawUid);
  try {
    const data = await loadBusData(rawUid, s, force);
    const view = vm.buildBusView(data.place, data.toHomeRows, data.toCityRows, data.toHomeUrl, data.toCityUrl, targetIso);
    await render(peerId, cmid, view);
  } catch (err) {
    log('WARN', `автобус: ${err.message}`);
    await render(peerId, cmid, { text: 'Не удалось получить расписание автобусов, попробуй позже.' });
  }
}

// ---------------------------------------------------------------- message_event роутер

vk.updates.on('message_event', async (context) => {
  try {
    await handleEvent(context);
  } catch (err) {
    log('ERROR', `event: ${err.stack || err}`);
    try {
      await context.answer({ type: 'show_snackbar', text: 'Что-то пошло не так, попробуй ещё раз.' });
    } catch {
      /* ignore */
    }
  }
});

async function handleEvent(context) {
  const peerId = context.peerId;
  const cmid = context.conversationMessageId;
  const rawUid = uid(peerId);
  const payload = context.eventPayload || {};
  const data = String(payload.d || '');
  const [prefix] = data.split(':');

  const ack = (text) => context.answer({ type: 'show_snackbar', text: text || '' }).catch(() => {});

  if (data === 'noop' || !data) return void ack();
  if (data.startsWith('kb:')) return void ack(); // отголосок текстовой кнопки снизу — не должно сюда прилетать, но на всякий случай

  if (prefix === 'menu') return void (await onMenuButton(peerId, cmid, rawUid, data.slice(5), ack));
  if (prefix === 'set') return void (await onSettingsButton(peerId, cmid, rawUid, data.slice(4), ack));
  if (prefix === 'away') return void (await onAwayButton(peerId, cmid, rawUid, data.slice(5), ack));
  if (prefix === 'link') return void (await onLinkButton(peerId, cmid, rawUid, data.slice(5), ack));
  if (prefix === 'pause') return void (await onPauseButton(peerId, cmid, rawUid, data.slice(6), ack));
  if (prefix === 'role') return void (await onRoleButton(peerId, cmid, rawUid, data.slice(5), ack));
  if (prefix === 'days') return void (await onDaysButton(peerId, cmid, rawUid, data.slice(5), ack));
  if (prefix === 'rem') return void (await onReminderButton(peerId, cmid, rawUid, data.slice(4), ack));
  if (prefix === 'mrn') return void (await onMorningButton(peerId, cmid, rawUid, data.slice(4), ack));
  if (prefix === 'grp') return void (await onGroupButton(peerId, cmid, rawUid, data.slice(4), ack));
  if (prefix === 'sch') return void (await onScheduleButton(peerId, cmid, rawUid, data.slice(4), ack));
  if (prefix === 'lk') return void (await onLookupButton(peerId, cmid, rawUid, data.slice(3), ack));
  if (prefix === 'wk') return void (await onWeekButton(peerId, cmid, rawUid, data.slice(3), ack));
  if (prefix === 'weather') return void (await onWeatherButton(peerId, cmid, rawUid, data.slice(8), ack));
  if (prefix === 'bus') return void (await onBusButton(peerId, cmid, rawUid, data.slice(4), ack));
  if (prefix === 'adm') return void (await onAdminButton(peerId, cmid, rawUid, data.slice(4), ack));
  await ack();
}

async function onMenuButton(peerId, cmid, rawUid, action, ack) {
  const s = effState(rawUid);
  switch (action) {
    case 'schedule': {
      if (!s.subj) return void ack('Сначала укажи группу или фамилию (👤 Роль).');
      await ack();
      const target = D.todayParts();
      const { data, url, error } = await safeSchedule(s.subj, target, s.showGaps);
      const withNotes = data ? attachNotes(data, rawUid, D.iso(target)) : data;
      const payload = error ? { text: error, keyboard: vm.scheduleKeyboard(D.iso(target), null, { rows: [] }) } : { ...vm.scheduleMessage(withNotes, url, s.format), keyboard: vm.scheduleKeyboard(D.iso(target), url, withNotes) };
      await render(peerId, cmid, payload);
      await logSchedule(rawUid, `открыл расписание на ${D.fmtDM(target)}`, withNotes);
      return;
    }
    case 'week':
      if (!s.subj) return void ack('Сначала укажи группу или фамилию.');
      await ack();
      await renderWeek(peerId, cmid, rawUid, D.mondayOf(D.todayParts()));
      return;
    case 'weather':
      await ack();
      await renderWeatherView(peerId, cmid, rawUid, D.iso(D.todayParts()));
      return;
    case 'bus': {
      if (!s.away || !s.homePlace) return void ack('Сначала укажи населённый пункт: ⚙️ Настройки → 🏘 Не из города.');
      await ack();
      await renderBusView(peerId, cmid, rawUid, D.iso(D.todayParts()), true);
      return;
    }
    case 'role':
      await ack();
      await render(peerId, cmid, vm.buildRoleView(s));
      return;
    case 'bell':
      await ack();
      await render(peerId, cmid, vm.bellView());
      return;
    case 'now': {
      if (!s.subj) return void ack('Сначала укажи группу или фамилию.');
      await ack();
      const target = D.tomorrowParts();
      const { data, url, error } = await safeSchedule(s.subj, target, s.showGaps);
      if (error) return void send(peerId, { text: error });
      const d = attachNotes(data, rawUid, D.iso(target));
      await send(peerId, vm.scheduleMessage(d, url, s.format));
      await logSchedule(rawUid, `запросил расписание отдельным сообщением на ${D.fmtDM(target)}`, d);
      return;
    }
    case 'settings':
      await ack();
      await render(peerId, cmid, vm.buildSettingsView(s));
      return;
    case 'search':
      await ack();
      awaiting.set(rawUid, { kind: 'search' });
      await send(peerId, { text: 'Напиши кабинет или фамилию преподавателя (можно и то, и другое через запятую):' });
      return;
    case 'teacher':
      await ack();
      awaiting.set(rawUid, { kind: 'teacherLookup' });
      await send(peerId, { text: 'Напиши фамилию преподавателя:' });
      return;
    case 'rooms':
      await ack();
      awaiting.set(rawUid, { kind: 'rooms' });
      await send(peerId, { text: 'Напиши номер пары (1–7), можно через пробел добавить дату дд.мм:' });
      return;
    case 'ask':
      await ack();
      awaiting.set(rawUid, { kind: 'ask' });
      await send(peerId, { text: 'Напиши вопрос администратору (первая строка — короткая тема, дальше — сам вопрос):' });
      return;
    case 'help':
      await ack();
      await render(peerId, cmid, vm.buildHelpView());
      return;
    case 'refresh':
      await ack();
      await render(peerId, cmid, menuView(rawUid));
      return;
    default:
      await ack();
  }
}

async function onSettingsButton(peerId, cmid, rawUid, rest, ack) {
  const s = effState(rawUid);
  const back = () => render(peerId, cmid, vm.buildSettingsView(effState(rawUid)));
  switch (rest) {
    case 'back':
      await ack();
      return void (await render(peerId, cmid, menuView(rawUid)));
    case 'group':
      await ack();
      return void (await openGroupPicker(peerId, cmid, rawUid));
    case 'role':
      await ack();
      return void (await render(peerId, cmid, vm.buildRoleView(s)));
    case 'pause':
      await ack();
      return void (await render(peerId, cmid, vm.buildPauseView(s)));
    case 'away':
      await ack();
      return void (await render(peerId, cmid, vm.buildAwayView(s)));
    case 'link':
      await ack();
      return void (await render(peerId, cmid, vm.buildLinkView(storage.linkedIds(rawUid))));
    case 'togglesub':
      storage.setSubscribed(rawUid, !s.subscribed);
      await logToChannel(`🔔 ${tag(rawUid)} ${!s.subscribed ? 'включил' : 'выключил'} рассылку`);
      await ack();
      return void (await back());
    case 'togglegaps':
      storage.setShowGaps(rawUid, !s.showGaps);
      await ack();
      return void (await back());
    case 'format':
      storage.setFormat(rawUid, vm.nextFormat(s.format));
      await ack();
      return void (await back());
    case 'wthrformat':
      storage.setWeatherFormat(rawUid, vm.nextFormat(s.weatherFormat));
      await ack();
      return void (await back());
    case 'time':
      await ack();
      awaiting.set(rawUid, { kind: 'time' });
      await send(peerId, { text: 'Напиши время рассылки в формате ЧЧ:ММ (например 18:30), или «-» чтобы сбросить на умолчание:' });
      return;
    case 'days':
      await ack();
      return void (await render(peerId, cmid, vm.buildDaysView(s.days)));
    case 'reminder':
      await ack();
      return void (await render(peerId, cmid, vm.buildReminderView(s.reminderMinutes)));
    case 'morning':
      await ack();
      return void (await render(peerId, cmid, vm.buildMorningView(s)));
    default:
      await ack();
  }
}

async function onAwayButton(peerId, cmid, rawUid, rest, ack) {
  if (rest === 'back') {
    await ack();
    return void (await render(peerId, cmid, vm.buildSettingsView(effState(rawUid))));
  }
  if (rest === 'toggle') {
    const s = effState(rawUid);
    if (!s.away && !s.homePlace) return void ack('Сначала укажи населённый пункт.');
    storage.setAway(rawUid, !s.away);
    await ack();
    return void (await render(peerId, cmid, vm.buildAwayView(effState(rawUid))));
  }
  if (rest === 'place') {
    await ack();
    awaiting.set(rawUid, { kind: 'awayplace' });
    await send(peerId, { text: 'Напиши название населённого пункта (или «-», чтобы выключить):' });
    return;
  }
  if (rest === 'stop') {
    await ack();
    awaiting.set(rawUid, { kind: 'awaystop' });
    await send(peerId, { text: 'Напиши номер остановки (напр. 2) или полное название (напр. «кладбище»), либо «-»:' });
    return;
  }
  await ack();
}

async function onLinkButton(peerId, cmid, rawUid, rest, ack) {
  if (rest === 'code') {
    const code = storage.createLinkCode(rawUid);
    await ack();
    return void (await render(peerId, cmid, vm.buildLinkView(storage.linkedIds(rawUid), { code })));
  }
  if (rest === 'enter') {
    await ack();
    awaiting.set(rawUid, { kind: 'linkcode' });
    await send(peerId, { text: 'Пришли код (6 символов), который показал бот в другом мессенджере:' });
    return;
  }
  if (rest === 'unlink') {
    const ok = storage.unlinkPlatform(rawId(peerId));
    await ack(ok ? 'Отвязано.' : undefined);
    return void (await render(peerId, cmid, vm.buildLinkView(storage.linkedIds(uid(peerId)), ok ? {} : { error: 'is-root' })));
  }
  await ack();
}

async function onPauseButton(peerId, cmid, rawUid, rest, ack) {
  if (rest === 'back') {
    await ack();
    return void (await render(peerId, cmid, vm.buildSettingsView(effState(rawUid))));
  }
  if (rest === 'date') {
    await ack();
    awaiting.set(rawUid, { kind: 'pausedate' });
    await send(peerId, { text: 'Напиши дату возвращения дд.мм (до этого дня — тишина):' });
    return;
  }
  if (rest === 'off') {
    storage.setPausedUntil(rawUid, null);
    await ack();
    return void (await render(peerId, cmid, vm.buildPauseView(effState(rawUid))));
  }
  if (rest.startsWith('days:')) {
    const n = Number(rest.slice(5));
    if (!(n >= 1 && n <= 180)) return void ack();
    const until = D.iso(D.shiftParts(D.todayParts(), n));
    storage.setPausedUntil(rawUid, until);
    await ack();
    return void (await render(peerId, cmid, vm.buildPauseView(effState(rawUid))));
  }
  await ack();
}

async function onRoleButton(peerId, cmid, rawUid, rest, ack) {
  if (rest === 'done') {
    await ack();
    return void (await render(peerId, cmid, menuView(rawUid)));
  }
  if (rest === 'setname') {
    await ack();
    awaiting.set(rawUid, { kind: 'teachername' });
    await send(peerId, { text: 'Напиши свою фамилию (или «-», чтобы очистить):' });
    return;
  }
  if (rest === 'student' || rest === 'teacher') {
    const st = storage.get(rawUid);
    if (rest === 'teacher' && !st.teacherName) return void ack('Сначала укажи фамилию (✏️).');
    if (rest === 'student' && !st.group) return void ack('Сначала укажи группу.');
    storage.setRole(rawUid, rest);
    await logToChannel(`👤 ${tag(rawUid)} сменил роль на «${rest === 'teacher' ? 'преподаватель' : 'студент'}»`);
    await ack();
    return void (await render(peerId, cmid, vm.buildRoleView(effState(rawUid))));
  }
  await ack();
}

async function onDaysButton(peerId, cmid, rawUid, rest, ack) {
  if (rest === 'done') {
    await ack();
    return void (await render(peerId, cmid, vm.buildSettingsView(effState(rawUid))));
  }
  if (rest.startsWith('toggle:')) {
    const isoDay = Number(rest.slice(7));
    if (!(isoDay >= 1 && isoDay <= 7)) return void ack();
    const cur = new Set(effState(rawUid).days);
    cur.has(isoDay) ? cur.delete(isoDay) : cur.add(isoDay);
    const next = [...cur].sort((a, c) => a - c);
    storage.setDays(rawUid, next);
    await ack();
    return void (await render(peerId, cmid, vm.buildDaysView(next)));
  }
  await ack();
}

async function onReminderButton(peerId, cmid, rawUid, rest, ack) {
  if (rest === 'done') {
    await ack();
    return void (await render(peerId, cmid, vm.buildSettingsView(effState(rawUid))));
  }
  if (rest.startsWith('set:')) {
    const n = Number(rest.slice(4));
    if (!vm.REMINDER_OPTS.includes(n)) return void ack();
    storage.setReminder(rawUid, n);
    await ack();
    return void (await render(peerId, cmid, vm.buildReminderView(n)));
  }
  await ack();
}

async function onMorningButton(peerId, cmid, rawUid, rest, ack) {
  if (rest === 'done') {
    await ack();
    return void (await render(peerId, cmid, vm.buildSettingsView(effState(rawUid))));
  }
  if (rest === 'time') {
    await ack();
    awaiting.set(rawUid, { kind: 'morningtime' });
    await send(peerId, { text: 'Напиши время утреннего сообщения ЧЧ:ММ (например 07:30):' });
    return;
  }
  if (rest === 'greeting') {
    await ack();
    awaiting.set(rawUid, { kind: 'morninggreeting' });
    await send(peerId, { text: 'Напиши свой текст приветствия (или «-», чтобы вернуть по умолчанию):' });
    return;
  }
  if (rest === 'toggle') {
    storage.setMorning(rawUid, !effState(rawUid).morning);
    await ack();
    return void (await render(peerId, cmid, vm.buildMorningView(effState(rawUid))));
  }
  await ack();
}

async function openGroupPicker(peerId, cmid, rawUid) {
  await render(peerId, cmid, { text: '⏳ Загружаю список групп…' });
  let view;
  try {
    const list = await ss.listAllGroups();
    groupCache.set(rawUid, list);
    view = list.length ? vm.buildGroupPicker(list, 0) : vm.buildGroupPicker([], 0, { error: 'Сайт не отдал список групп. Введи название вручную.' });
  } catch (err) {
    log('WARN', `список групп: ${err.message}`);
    view = vm.buildGroupPicker([], 0, { error: 'Не удалось загрузить список групп с сайта. Введи название вручную.' });
  }
  await render(peerId, cmid, view);
}

async function applyGroupChange(rawUid, newGroupRaw) {
  const old = storage.get(rawUid).group;
  storage.setGroup(rawUid, newGroupRaw);
  const now = storage.get(rawUid).group;
  if (!old) await logToChannel(`🆕 ${tag(rawUid)} зарегистрировался — группа «${now}»`);
  else if (old !== now) await logToChannel(`🔄 ${tag(rawUid)} сменил группу: «${old}» → «${now}»`);
}

async function onGroupButton(peerId, cmid, rawUid, rest, ack) {
  if (rest === 'cancel') {
    await ack();
    return void (await render(peerId, cmid, menuView(rawUid)));
  }
  if (rest === 'manual') {
    await ack();
    awaiting.set(rawUid, { kind: 'group' });
    await send(peerId, { text: 'Напиши название группы, например 209ИС-1:' });
    return;
  }
  if (rest.startsWith('page:')) {
    const page = Number(rest.slice(5)) || 0;
    await ack();
    if (groupCache.has(rawUid)) return void (await render(peerId, cmid, vm.buildGroupPicker(groupCache.get(rawUid), page)));
    await render(peerId, cmid, { text: '⏳ Обновляю список групп…' });
    try {
      const list = await ss.listAllGroups();
      groupCache.set(rawUid, list);
      await render(peerId, cmid, vm.buildGroupPicker(list, page));
    } catch (err) {
      log('WARN', `список групп: ${err.message}`);
      await render(peerId, cmid, vm.buildGroupPicker([], 0, { error: 'Не удалось загрузить список групп.' }));
    }
    return;
  }
  if (rest.startsWith('pick:')) {
    const [, pageStr, idxStr] = rest.split(':');
    const page = Number(pageStr) || 0;
    const idx = Number(idxStr);
    const list = groupCache.get(rawUid) || [];
    const group = list[page * vm.GROUPS_PER_PAGE + idx];
    if (!group) return void ack('Список устарел, попробуй заново.');
    await applyGroupChange(rawUid, group);
    await ack();
    await render(peerId, cmid, menuView(rawUid));
    return;
  }
  await ack();
}

async function renderSchedule(peerId, cmid, rawUid, target) {
  const s = effState(rawUid);
  const { data, url, error } = await safeSchedule(s.subj, target, s.showGaps);
  const withNotes = data ? attachNotes(data, rawUid, D.iso(target)) : data;
  const base = error ? { text: error } : vm.scheduleMessage(withNotes, url, s.format);
  await render(peerId, cmid, { ...base, keyboard: vm.scheduleKeyboard(D.iso(target), url, withNotes || { rows: [] }) });
  await logSchedule(rawUid, `открыл расписание (кнопка) на ${D.fmtDM(target)}`, withNotes);
}

async function onScheduleButton(peerId, cmid, rawUid, rest, ack) {
  const s = effState(rawUid);
  if (rest === 'menu') {
    await ack();
    return void (await render(peerId, cmid, menuView(rawUid)));
  }
  if (rest.startsWith('report:')) {
    await ack();
    awaiting.set(rawUid, { kind: 'report', iso: rest.slice(7) });
    await send(peerId, { text: 'Что не так с расписанием? Опиши коротко:' });
    return;
  }
  if (rest.startsWith('note:')) {
    await ack();
    awaiting.set(rawUid, { kind: 'note', iso: rest.slice(5) });
    await send(peerId, { text: 'Напиши: номер пары и через пробел текст заметки (например «3 взять чертёж»):' });
    return;
  }
  if (rest.startsWith('send:')) {
    const t = D.partsFromIso(rest.slice(5));
    if (!t || !s.subj) return void ack();
    await ack();
    const { data, url, error } = await safeSchedule(s.subj, t, s.showGaps);
    if (error) return void send(peerId, { text: error });
    const d = attachNotes(data, rawUid, D.iso(t));
    await send(peerId, vm.scheduleMessage(d, url, s.format));
    await logSchedule(rawUid, `запросил расписание отдельным сообщением на ${D.fmtDM(t)}`, d);
    return;
  }
  if (rest.startsWith('share:')) {
    const t = D.partsFromIso(rest.slice(6));
    if (!t || !s.subj) return void ack();
    await ack();
    try {
      const { csvText, humanUrl } = await ss.fetchDayCsv(t, 5 * 60 * 1000);
      const data = buildDayData(csvText, s.subj, t, {});
      await send(peerId, { text: vm.scheduleText(data, humanUrl).slice(0, 4000) });
    } catch {
      await send(peerId, { text: notPublishedText(t) });
    }
    return;
  }
  let target = null;
  if (rest === 'jump:today') target = D.todayParts();
  else if (rest === 'jump:tomorrow') target = D.tomorrowParts();
  else if (rest.startsWith('prev:') || rest.startsWith('next:')) {
    const bParts = D.partsFromIso(rest.slice(5));
    if (bParts) target = D.shiftParts(bParts, rest.startsWith('prev:') ? -1 : 1);
  }
  if (!target) return void ack();
  if (!s.subj) return void ack('Сначала укажи группу или фамилию в настройках.');
  await ack();
  await renderSchedule(peerId, cmid, rawUid, target);
}

async function onLookupButton(peerId, cmid, rawUid, rest, ack) {
  if (rest === 'menu') {
    await ack();
    return void (await render(peerId, cmid, menuView(rawUid)));
  }
  const st = lookupState.get(rawUid);
  if (!st) {
    await ack();
    return void (await render(peerId, cmid, { text: 'Поиск устарел — открой заново из меню.' }));
  }
  if (rest === 'pin') {
    if (st.kind !== 'teacher' || !st.params.surname) return void ack();
    const hadTeacherName = storage.get(rawUid).teacherName;
    storage.setTeacherName(rawUid, st.params.surname);
    storage.setRole(rawUid, 'teacher');
    if (!storage.get(rawUid).subscribed) storage.setSubscribed(rawUid, true);
    await logToChannel(
      hadTeacherName
        ? `🔄 ${tag(rawUid)} сменил фамилию преподавателя: «${hadTeacherName}» → «${st.params.surname}» (закреплено через поиск)`
        : `🆕 ${tag(rawUid)} зарегистрировался — преподаватель «${st.params.surname}» (закреплено через поиск)`,
    );
    await ack();
    return void (await render(peerId, cmid, menuView(rawUid)));
  }
  let target;
  if (rest === 'day:today') target = D.todayParts();
  else if (rest === 'day:tomorrow') target = D.tomorrowParts();
  else if (rest === 'prev' || rest === 'next') {
    const bParts = D.partsFromIso(st.iso) || D.todayParts();
    target = D.shiftParts(bParts, rest === 'prev' ? -1 : 1);
  } else return void ack();
  await ack();
  await showLookup(peerId, rawUid, st.kind, st.params, target, { fresh: false, cmid });
}

async function onWeekButton(peerId, cmid, rawUid, rest, ack) {
  if (rest === 'menu') {
    await ack();
    return void (await render(peerId, cmid, menuView(rawUid)));
  }
  const cur = D.partsFromIso(weekState.get(rawUid) || '') || D.mondayOf(D.todayParts());
  let monday;
  if (rest === 'this') monday = D.mondayOf(D.todayParts());
  else if (rest === 'prev') monday = D.shiftParts(cur, -7);
  else if (rest === 'next') monday = D.shiftParts(cur, 7);
  else return void ack();
  await ack();
  await renderWeek(peerId, cmid, rawUid, monday);
}

async function onWeatherButton(peerId, cmid, rawUid, rest, ack) {
  let target = null;
  if (rest === 'jump:today') target = D.todayParts();
  else if (rest === 'jump:tomorrow') target = D.tomorrowParts();
  else if (rest.startsWith('prev:') || rest.startsWith('next:')) {
    const bParts = D.partsFromIso(rest.slice(5));
    if (bParts) target = D.shiftParts(bParts, rest.startsWith('prev:') ? -1 : 1);
  }
  if (!target) return void ack();
  const todayIso = D.iso(D.todayParts());
  const horizonIso = D.iso(D.shiftParts(D.todayParts(), weather.FORECAST_DAYS - 1));
  if (D.iso(target) < todayIso) target = D.todayParts();
  else if (D.iso(target) > horizonIso) target = D.partsFromIso(horizonIso);
  await ack();
  await renderWeatherView(peerId, cmid, rawUid, D.iso(target));
}

async function onBusButton(peerId, cmid, rawUid, rest, ack) {
  let target = null;
  if (rest === 'jump:today') target = D.todayParts();
  else if (rest === 'jump:tomorrow') target = D.tomorrowParts();
  else if (rest.startsWith('prev:') || rest.startsWith('next:')) {
    const bParts = D.partsFromIso(rest.slice(5));
    if (bParts) target = D.shiftParts(bParts, rest.startsWith('prev:') ? -1 : 1);
  }
  if (!target) return void ack();
  await ack();
  await renderBusView(peerId, cmid, rawUid, D.iso(target));
}

// ---------------------------------------------------------------- админ-панель

async function onAdminButton(peerId, cmid, rawUid, rest, ack) {
  if (!storage.isAdmin(rawUid)) return void ack('Нет доступа.');
  if (rest === 'menu') {
    await ack();
    return void (await render(peerId, cmid, vm.buildAdminMenu()));
  }
  if (rest === 'stats') {
    await ack();
    return void (await render(peerId, cmid, vm.buildStatsView(storage.stats())));
  }
  if (rest === 'health') {
    await ack();
    return void (await render(peerId, cmid, vm.buildHealthView(ss.health())));
  }
  if (rest === 'log') {
    await ack();
    return void (await render(peerId, cmid, vm.buildAdminLogView(storage.getAdminLog(15))));
  }
  if (rest === 'schann') {
    await ack();
    return void (await render(peerId, cmid, vm.buildSchedAnnView(storage.listScheduledAnnounces())));
  }
  if (rest === 'schann:add') {
    await ack();
    awaiting.set(rawUid, { kind: 'schann' });
    await send(peerId, { text: 'Напиши тремя строками:\n1) дд.мм ЧЧ:ММ\n2) группа (или «-» — всем)\n3) текст объявления' });
    return;
  }
  if (rest.startsWith('schann:del:')) {
    const sid = rest.slice(11);
    if (storage.removeScheduledAnnounce(sid)) {
      storage.addAdminLog(rawUid, `удалил отложенное объявление ${sid}`);
      await logToChannel(`🛠 ${tag(rawUid)} удалил отложенное объявление ${sid}`);
    }
    await ack();
    return void (await render(peerId, cmid, vm.buildSchedAnnView(storage.listScheduledAnnounces())));
  }
  if (rest === 'admins') {
    await ack();
    return void (await render(peerId, cmid, vm.buildAdminsView(storage.getAdmins(), rawUid)));
  }
  if (rest === 'announce') {
    await ack();
    awaiting.set(rawUid, { kind: 'announce' });
    await send(peerId, { text: 'Напиши текст объявления. Если это объявление для одной группы — первой строкой напиши «группа: <название>», дальше сам текст.' });
    return;
  }
  if (rest === 'addadmin') {
    await ack();
    awaiting.set(rawUid, { kind: 'addadmin' });
    await send(peerId, { text: 'Напиши числовой VK ID нового админа (его можно узнать по ссылке vk.com/id<число> или через vk.com/app6111749):' });
    return;
  }
  if (rest.startsWith('del:')) {
    const id = rest.slice(4);
    if (!storage.removeAdmin(id)) return void ack('Нельзя удалить (последний админ или не найден).');
    storage.addAdminLog(rawUid, `удалил админа …${String(id).slice(-4)}`);
    await logToChannel(`🛠 ${tag(rawUid)} удалил админа ${tag(id)}`);
    await ack();
    return void (await render(peerId, cmid, vm.buildAdminsView(storage.getAdmins(), rawUid)));
  }
  await ack();
}

/** Разослать объявление подписчикам этой платформы (всем или одной группе). */
async function broadcastAnnouncement(text, group) {
  const wantG = group ? ss.normGroup(group) : null;
  const subs = storage.subscribers().filter((u) => {
    if (!String(u.userId).startsWith('vk:')) return false;
    if (!wantG) return true;
    return u.group && u.role !== 'teacher' && ss.normGroup(u.group) === wantG;
  });
  let ok = 0;
  let fail = 0;
  for (const u of subs) {
    try {
      await send(u.userId.slice(3), { text: `📢 Объявление\n\n${text}` });
      ok += 1;
    } catch {
      fail += 1;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return { ok, fail, total: subs.length };
}

// ---------------------------------------------------------------- вопрос администратору

async function relayToAdmin(peerId, rawUid, topic, body) {
  const qid = storage.addQuestion(rawUid, `vk:${peerId}`, topic, body);
  await logToChannel(`❓ ${tag(rawUid)} — ${topic}\n${body.slice(0, 1500)}\nID: ${qid}`);
  const admins = storage.getAdmins().filter((a) => String(a).startsWith('vk:'));
  let delivered = 0;
  for (const adminUid of admins) {
    try {
      await send(adminUid.slice(3), { text: `❓ ${topic}\n\n${body}\n\nОт: ${tag(rawUid)}\n\nОтветить: ответ_${qid} <текст>` });
      delivered += 1;
    } catch (err) {
      log('WARN', `вопрос ${qid} -> админу ${adminUid}: ${err.message}`);
    }
  }
  if (delivered) {
    log('INFO', `вопрос ${qid} от ${rawUid} -> ${delivered} админам`);
    await send(peerId, { text: '✅ Отправлено. Ответ придёт тебе в личные сообщения.' });
  } else {
    storage.deleteQuestion(qid);
    await send(peerId, { text: 'Не удалось доставить администратору. Попробуй позже.' });
  }
}

// ---------------------------------------------------------------- message_new роутер

vk.updates.on('message_new', async (context) => {
  try {
    await handleMessage(context);
  } catch (err) {
    log('ERROR', `message: ${err.stack || err}`);
    try {
      await send(context.peerId, { text: 'Что-то пошло не так, попробуй ещё раз.' });
    } catch {
      /* ignore */
    }
  }
});

async function handleMessage(context) {
  log(
    'INFO',
    `входящее: peerId=${context.peerId} senderId=${context.senderId} isOutbox=${context.isOutbox} isChat=${context.isChat} isFromUser=${context.isFromUser} hasText=${context.hasText} text=${JSON.stringify(context.text)}`,
  );
  if (context.isOutbox || context.isChat || !context.isFromUser || !context.hasText) return;
  const peerId = context.peerId;
  const rawUid = uid(peerId);
  const text = context.text.trim();

  if (/^(начать|старт|start)\b/i.test(text)) return void (await sendMainMenu(peerId, rawUid));
  if (/^помощь\b|^\/?help\b/i.test(text)) {
    const view = vm.buildHelpView();
    return void (await send(peerId, view));
  }
  if (/^звонки\b/i.test(text)) return void (await send(peerId, vm.bellView()));
  if (/^сейчас\b/i.test(text)) {
    const s = effState(rawUid);
    if (!s.subj) return void send(peerId, { text: 'Сначала укажи группу или фамилию (напиши «начать»).' });
    const today = D.todayParts();
    let data = null;
    try {
      data = buildDayData((await ss.fetchDayCsv(today, 5 * 60 * 1000)).csvText, s.subj, today, {});
    } catch {
      /* нет данных */
    }
    const view = vm.buildNowMessage(data, s.subj.name);
    await send(peerId, view);
    await logSchedule(rawUid, 'сейчас', data);
    return;
  }
  const schM = /^расписание\b\s*(.*)$/i.exec(text);
  if (schM) {
    const s = effState(rawUid);
    if (!s.subj) return void send(peerId, { text: 'Сначала укажи группу (напиши «начать»), либо напиши «расписание дд.мм».' });
    const arg = (schM[1] || '').trim();
    const target = arg ? parseDateField(arg) : D.todayParts();
    if (!target) return void send(peerId, { text: 'Не понял дату. Формат: дд.мм.' });
    const { data, url, error } = await safeSchedule(s.subj, target, s.showGaps);
    const d = data ? attachNotes(data, rawUid, D.iso(target)) : data;
    const payload = error ? { text: error } : vm.scheduleMessage(d, url, s.format);
    await send(peerId, payload);
    await logSchedule(rawUid, `расписание на ${D.fmtDM(target)}`, d);
    return;
  }
  const searchM = /^поиск\b\s*(.*)$/i.exec(text);
  if (searchM) {
    const q = (searchM[1] || '').trim();
    if (!q) return void send(peerId, { text: 'Напиши: поиск <кабинет или фамилия>, например «поиск 30» или «поиск Иванов».' });
    const isNum = /^\d/.test(q);
    await showLookup(peerId, rawUid, 'search', isNum ? { room: q } : { teacher: q }, D.todayParts(), { fresh: true });
    return;
  }
  const teacherM = /^преподаватель\b\s*(.*)$/i.exec(text);
  if (teacherM) {
    const surname = (teacherM[1] || '').trim();
    if (!surname) return void send(peerId, { text: 'Напиши: преподаватель <фамилия>' });
    await showLookup(peerId, rawUid, 'teacher', { surname }, D.todayParts(), { fresh: true });
    return;
  }
  if (/^(админ|admin)\b/i.test(text)) {
    if (!storage.isAdmin(rawUid)) return void send(peerId, { text: 'Нет доступа.' });
    return void (await send(peerId, vm.buildAdminMenu()));
  }
  const ansM = /^ответ_([a-f0-9]+)\s+([\s\S]+)$/i.exec(text);
  if (ansM) {
    if (!storage.isAdmin(rawUid)) return;
    const qid = ansM[1];
    const answer = ansM[2].trim();
    const q = storage.getQuestion(qid);
    if (!q) return void send(peerId, { text: 'Вопрос не найден или на него уже ответили.' });
    try {
      const askerPeerId = String(q.askerTag).replace(/^vk:/, '');
      await send(askerPeerId, { text: `💬 Ответ на твой вопрос: ${q.topic}\n\n${q.question}\n\nОтвет: ${answer}` });
      storage.deleteQuestion(qid);
      await send(peerId, { text: '✅ Ответ отправлен.' });
    } catch (err) {
      log('WARN', `не доставить ответ ${qid}: ${err.message}`);
      await send(peerId, { text: 'Не удалось отправить ответ.' });
    }
    return;
  }

  const kbLabelRaw = text;
  const keyboardAction = KEYBOARD_LABELS[kbLabelRaw];
  if (keyboardAction) {
    awaiting.delete(rawUid);
    return void (await onMenuButton(peerId, null, rawUid, keyboardAction, sendAsAck(peerId)));
  }

  const pending = awaiting.get(rawUid);
  if (!pending) return;
  awaiting.delete(rawUid);
  await handleAwaitingText(peerId, rawUid, pending, text);
}

async function handleAwaitingText(peerId, rawUid, pending, text) {
  const s = effState(rawUid);
  switch (pending.kind) {
    case 'group': {
      if (!text) return void send(peerId, { text: 'Пустое название группы.' });
      await applyGroupChange(rawUid, text);
      log('INFO', `${rawUid} ввёл группу "${text}"`);
      await send(peerId, menuView(rawUid));
      return;
    }
    case 'teachername': {
      const surname = text === '-' ? '' : text;
      const hadTeacherName = storage.get(rawUid).teacherName;
      storage.setTeacherName(rawUid, surname || null);
      if (surname) storage.setRole(rawUid, 'teacher');
      else if (storage.get(rawUid).role === 'teacher') storage.setRole(rawUid, 'student');
      if (surname && !hadTeacherName) await logToChannel(`🆕 ${tag(rawUid)} зарегистрировался — преподаватель «${surname}»`);
      else if (surname && hadTeacherName !== surname) await logToChannel(`🔄 ${tag(rawUid)} сменил фамилию преподавателя: «${hadTeacherName}» → «${surname}»`);
      await send(peerId, vm.buildRoleView(effState(rawUid)));
      return;
    }
    case 'time': {
      if (text === '-') {
        storage.setTime(rawUid, null);
      } else {
        const hhmm = D.parseHHMM(text);
        if (!hhmm) return void send(peerId, { text: 'Неверный формат. Нужно ЧЧ:ММ, например 18:30.' });
        storage.setTime(rawUid, hhmm);
      }
      await send(peerId, vm.buildSettingsView(effState(rawUid)));
      return;
    }
    case 'morningtime': {
      const hhmm = D.parseHHMM(text);
      if (!hhmm) return void send(peerId, { text: 'Неверный формат. Нужно ЧЧ:ММ, например 07:30.' });
      storage.setMorningTime(rawUid, hhmm);
      await send(peerId, vm.buildMorningView(effState(rawUid)));
      return;
    }
    case 'morninggreeting': {
      storage.setMorningGreeting(rawUid, text === '-' ? null : text);
      await send(peerId, vm.buildMorningView(effState(rawUid)));
      return;
    }
    case 'pausedate': {
      const target = parseDateField(text);
      const todayIso = D.iso(D.todayParts());
      if (!target || D.iso(target) <= todayIso) return void send(peerId, { text: 'Нужна будущая дата в формате дд.мм (например 20.09).' });
      storage.setPausedUntil(rawUid, D.iso(target));
      await send(peerId, vm.buildPauseView(effState(rawUid)));
      return;
    }
    case 'awayplace': {
      if (text === '-') {
        storage.setHomePlace(rawUid, null, null, null);
        storage.setAway(rawUid, false);
        await send(peerId, vm.buildAwayView(effState(rawUid)));
        return;
      }
      await send(peerId, { text: '⏳ Ищу населённый пункт…' });
      let geo = null;
      try {
        geo = await weather.geocode(text);
      } catch (err) {
        log('WARN', `геокодинг "${text}": ${err.message}`);
      }
      if (!geo) return void send(peerId, { text: `Не нашёл «${text}» на карте. Проверь написание и попробуй ещё раз.` });
      storage.setHomePlace(rawUid, text, geo.lat, geo.lon);
      log('INFO', `${rawUid} задал населённый пункт «${text}» (${geo.lat}, ${geo.lon})`);
      await send(peerId, vm.buildAwayView(effState(rawUid)));
      return;
    }
    case 'awaystop': {
      storage.setHomeStop(rawUid, text === '-' ? null : text);
      await send(peerId, vm.buildAwayView(effState(rawUid)));
      return;
    }
    case 'linkcode': {
      const r = storage.redeemLinkCode(text, rawId(peerId));
      const view = vm.buildLinkView(storage.linkedIds(uid(peerId)), r.ok ? {} : { error: r.error });
      await send(peerId, { ...view, text: (r.ok ? '✅ Связано! Теперь это один профиль.\n\n' : '') + view.text });
      return;
    }
    case 'ask': {
      const lines = text.split('\n');
      const topic = (lines[0] || 'Без темы').slice(0, 100);
      const question = (lines.slice(1).join('\n') || lines[0] || '').trim();
      if (!question) return void send(peerId, { text: 'Пустой вопрос.' });
      await relayToAdmin(peerId, rawUid, topic, question);
      return;
    }
    case 'report': {
      const who = s.subj ? (s.subj.kind === 'teacher' ? `преп. ${s.subj.name}` : `группа ${s.subj.name}`) : '—';
      const t = D.partsFromIso(pending.iso);
      await relayToAdmin(peerId, rawUid, `Ошибка в расписании: ${t ? D.fmtDM(t) : pending.iso}, ${who}`, text);
      return;
    }
    case 'note': {
      const m = /^(\d)\s*(.*)$/.exec(text);
      if (!m) return void send(peerId, { text: 'Начни с номера пары (1–7), например «3 взять чертёж».' });
      const pair = Number(m[1]);
      const noteText = m[2].trim();
      storage.setNote(rawUid, pending.iso, pair, noteText || null);
      const t = D.partsFromIso(pending.iso);
      await send(peerId, { text: noteText ? `📝 Заметка к ${pair}-й паре${t ? ` на ${D.fmtDM(t)}` : ''} сохранена.` : '📝 Заметка удалена.' });
      if (t) await renderSchedule(peerId, null, rawUid, t);
      return;
    }
    case 'search': {
      const parts = text.split(',').map((x) => x.trim()).filter(Boolean);
      const room = parts.find((p) => /^\d/.test(p)) || '';
      const teacher = parts.find((p) => !/^\d/.test(p)) || '';
      if (!room && !teacher) return void send(peerId, { text: 'Заполни кабинет или фамилию.' });
      await showLookup(peerId, rawUid, 'search', { room, teacher }, D.todayParts(), { fresh: true });
      return;
    }
    case 'teacherLookup': {
      if (!text) return void send(peerId, { text: 'Укажи фамилию.' });
      await showLookup(peerId, rawUid, 'teacher', { surname: text }, D.todayParts(), { fresh: true });
      return;
    }
    case 'rooms': {
      const m = /^([1-7])\s*(\d{1,2}\.\d{1,2})?/.exec(text);
      if (!m) return void send(peerId, { text: 'Номер пары — число от 1 до 7 (можно добавить дату дд.мм).' });
      const pair = Number(m[1]);
      const target = m[2] ? parseDateField(m[2]) : D.todayParts();
      if (!target) return void send(peerId, { text: 'Не понял дату.' });
      try {
        const { csvText } = await ss.fetchDayCsv(target, 5 * 60 * 1000);
        const result = ss.freeRooms(csvText, target, pair);
        await send(peerId, vm.buildRoomsView(result, target));
      } catch (err) {
        const errMsg = err instanceof ss.NotPublishedError ? notPublishedText(target) : 'Не удалось получить данные, попробуй позже.';
        if (!(err instanceof ss.NotPublishedError)) log('WARN', `кабинеты: ${err.message}`);
        await send(peerId, { text: errMsg });
      }
      return;
    }
    case 'announce': {
      if (!storage.isAdmin(rawUid)) return;
      const m = /^группа:\s*(\S.*)\n([\s\S]+)$/i.exec(text);
      const group = m ? m[1].trim() : '';
      const body = m ? m[2].trim() : text;
      if (!body) return void send(peerId, { text: 'Пустой текст.' });
      await send(peerId, { text: `Рассылаю объявление${group ? ` группе ${group}` : ' всем подписчикам'}…` });
      const { ok, fail, total } = await broadcastAnnouncement(body, group);
      storage.addAdminLog(rawUid, `объявление ${group ? `группе ${group}` : 'всем'} (${ok}/${total})`);
      await logToChannel(`📢 ${tag(rawUid)} разослал объявление${group ? ` группе «${group}»` : ' всем подписчикам'} (доставлено ${ok}/${total})\n${body.slice(0, 1200)}`);
      await send(peerId, { text: `Готово: доставлено ${ok} из ${total}, не доставлено ${fail}.` });
      return;
    }
    case 'schann': {
      if (!storage.isAdmin(rawUid)) return;
      const lines2 = text.split('\n').map((x) => x.trim());
      const whenRaw = lines2[0] || '';
      const group = lines2[1] && lines2[1] !== '-' ? lines2[1] : '';
      const body = lines2.slice(2).join('\n').trim();
      const m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})$/.exec(whenRaw);
      if (!m || !body) return void send(peerId, { text: 'Формат: первая строка «дд.мм ЧЧ:ММ», вторая — группа или «-», дальше — текст.' });
      const dd = +m[1];
      const mm = +m[2];
      const hh = +m[4];
      const mi = +m[5];
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59) return void send(peerId, { text: 'Неверная дата или время.' });
      const nowY = D.todayParts().y;
      let atParts = D.partsFromIso(`${m[3] ? +m[3] : nowY}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
      if (!atParts) return void send(peerId, { text: 'Неверная дата.' });
      const nowIso = D.iso(D.todayParts());
      if (!m[3] && D.iso(atParts) < nowIso) atParts = D.partsFromIso(`${nowY + 1}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
      const atIso = D.iso(atParts);
      const atHHMM = `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
      const nn = D.tzNow();
      if (atIso < nowIso || (atIso === nowIso && atHHMM <= `${String(nn.h).padStart(2, '0')}:${String(nn.mi).padStart(2, '0')}`)) {
        return void send(peerId, { text: 'Это время уже прошло.' });
      }
      const sid = storage.addScheduledAnnounce({ text: body, atIso, atHHMM, group: group || null, by: rawUid });
      storage.addAdminLog(rawUid, `запланировал объявление ${sid} на ${atIso} ${atHHMM}`);
      await logToChannel(`🕓 ${tag(rawUid)} запланировал объявление ${sid} на ${atIso} ${atHHMM}${group ? ` (${group})` : ''}\n${body.slice(0, 1200)}`);
      await send(peerId, vm.buildSchedAnnView(storage.listScheduledAnnounces()));
      return;
    }
    case 'addadmin': {
      if (!storage.isAdmin(rawUid)) return;
      const newPeerId = text.trim();
      if (!/^\d{1,15}$/.test(newPeerId)) return void send(peerId, { text: 'Это не похоже на числовой VK ID.' });
      const added = storage.addAdmin(`vk:${newPeerId}`);
      if (added) await logToChannel(`🛠 ${tag(rawUid)} добавил админа ${tag(`vk:${newPeerId}`)}`);
      await send(peerId, vm.buildAdminsView(storage.getAdmins(), rawUid));
      return;
    }
    default:
  }
}

// --------------------------------------------------------- планировщики (как в telegramBot.js, только VK-адресаты)

const isVkId = (id) => String(id).startsWith('vk:');
let broadcasting = false;
const remindersSent = new Set();
const PROCESS_START = Date.now();
const healthAlert = { notifiedBroken: false, lastNotifiedAt: 0 };

function startSchedulers() {
  log('INFO', `VK: рассылка по умолчанию ${cfg.defaultTime} ${cfg.timezone}, дни [${cfg.defaultDays.join(',')}]`);
  setInterval(broadcastTick, 60 * 1000);
  setInterval(morningTick, 60 * 1000);
  setInterval(reminderTick, 60 * 1000);
  setInterval(announceTick, 60 * 1000);
  setInterval(changeTick, 15 * 60 * 1000);
  setInterval(warmTick, 5 * 60 * 1000);
  setInterval(healthTick, 15 * 60 * 1000);
  setInterval(pauseReminderTick, 60 * 60 * 1000);
  broadcastTick();
  warmTick();
}

async function warmTick() {
  const subs = storage.subscribers().filter((u) => isVkId(u.userId));
  if (!subs.length) return;
  for (const t of [D.todayParts(), D.tomorrowParts()]) await ss.fetchDayCsv(t, 4 * 60 * 1000).catch(() => {});
}

async function morningTick() {
  const now = D.tzNow();
  const hhmm = `${D.pad(now.h)}:${D.pad(now.mi)}`;
  const today = D.todayParts();
  const todayIso = D.iso(today);
  const dow = D.weekdayIso(today);
  const due = storage.subscribers().filter((u) => {
    if (!isVkId(u.userId)) return false;
    if (!u.morning || (u.morningTime || '07:30') !== hhmm) return false;
    if (isPaused(u.pausedUntil)) return false;
    const days = Array.isArray(u.days) ? u.days : cfg.defaultDays;
    if (!days.includes(dow)) return false;
    return u.morningLastSent !== todayIso;
  });
  if (!due.length) return;

  let csvText = null;
  try {
    csvText = (await ss.fetchDayCsv(today, 4 * 60 * 1000)).csvText;
  } catch {
    /* поздороваемся и без данных */
  }
  let cityForecast = null;
  if (cfg.weatherEnabled) {
    try {
      cityForecast = await weather.dayForecast(cfg.weatherLat, cfg.weatherLon);
    } catch (err) {
      log('WARN', `погода (город): ${err.message}`);
    }
  }

  const cache = new Map();
  for (const u of due) {
    const subj = subjOf(u);
    const greet = u.morningGreeting || '☀️ Доброе утро!';
    let body = greet;
    if (subj && csvText) {
      const sk = subjKey(subj);
      if (!cache.has(sk)) {
        try {
          cache.set(sk, buildDayData(csvText, subj, today, {}));
        } catch {
          cache.set(sk, null);
        }
      }
      const data = cache.get(sk);
      if (data && !data.note) {
        const lessons = data.rows.filter((r) => r.kind === 'lesson' && r.start);
        if (lessons.length) {
          const n = lessons.length;
          const w = n % 10 === 1 && n % 100 !== 11 ? 'пара' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'пары' : 'пар';
          body = `${greet} Сегодня ${n} ${w}, первая в ${lessons[0].start}, до ${lessons[lessons.length - 1].end}.`;
        } else {
          body = D.weekdayIso(today) >= 6 ? `${greet} Сегодня выходной — пар нет 🎉` : `${greet} Сегодня пар нет.`;
        }
      }
    }
    try {
      const peerId = u.userId.slice(3);
      await send(peerId, { text: body });
      if (cfg.weatherEnabled) {
        if (u.away && u.homePlace && u.homeLat != null && u.homeLon != null) {
          try {
            const homeForecast = await weather.dayForecast(u.homeLat, u.homeLon);
            const view = vm.buildWeatherPanel({ place: u.homePlace, forecast: homeForecast }, { place: cfg.weatherPlace, forecast: cityForecast || { ranges: [], advice: [] } }, D.iso(today), null);
            await send(peerId, { text: view.text });
          } catch (err) {
            log('WARN', `погода (дом, ${u.userId}): ${err.message}`);
          }
        } else if (cityForecast) {
          await send(peerId, { text: vm.weatherText(cfg.weatherPlace, cityForecast, null) }).catch(() => {});
        }
      }
      storage.setMorningLastSent(u.userId, todayIso);
    } catch (err) {
      log('WARN', `утро ${u.userId}: ${err.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 60));
  }
}

async function broadcastTick() {
  if (broadcasting) return;
  const now = D.tzNow();
  const nowMin = now.h * 60 + now.mi;
  const target = D.tomorrowParts();
  const targetIso = D.iso(target);
  const dow = D.weekdayIso(target);

  storage.purgeExpiredPauses(D.iso(D.todayParts()));
  storage.purgeOldNotes(D.iso(D.todayParts()));

  const due = storage.subscribers().filter((u) => {
    if (!isVkId(u.userId)) return false;
    if (isPaused(u.pausedUntil)) return false;
    const [th, tmn] = String(u.time || cfg.defaultTime).split(':').map(Number);
    if (nowMin < th * 60 + tmn) return false;
    const days = Array.isArray(u.days) ? u.days : cfg.defaultDays;
    if (!days.includes(dow)) return false;
    return u.lastSent !== targetIso;
  });
  if (!due.length) return;

  broadcasting = true;
  try {
    await runBroadcast(due, target, targetIso);
  } catch (err) {
    log('ERROR', `рассылка упала: ${err.stack || err}`);
  } finally {
    broadcasting = false;
  }
}

async function runBroadcast(due, target, targetIso) {
  log('INFO', `рассылка: ${due.length} получателей, дата ${ss.fmtDMY(target)}`);
  let csvText = null;
  let humanUrl = null;
  let notPublished = false;
  let sourceFailed = false;
  try {
    const r = await ss.fetchDayCsv(target, 0);
    csvText = r.csvText;
    humanUrl = r.humanUrl;
  } catch (err) {
    if (err instanceof ss.NotPublishedError) notPublished = true;
    else {
      sourceFailed = true;
      log('WARN', `рассылка: источник недоступен: ${err.message}`);
    }
  }
  const weekendTomorrow = D.weekdayIso(target) >= 6;
  if (sourceFailed) return void log('INFO', 'рассылка отложена: источник временно недоступен');
  if (notPublished && !weekendTomorrow) return void log('INFO', `рассылка отложена: расписание на ${targetIso} ещё не опубликовано`);
  if (!notPublished && !csvText) return void log('WARN', 'рассылка отложена: пустой ответ источника');

  const dataCache = new Map();
  const digestSaved = new Set();
  let sent = 0;
  let skipped = 0;
  let deferredCount = 0;

  for (const u of due) {
    let payload;
    if (notPublished) {
      payload = { text: `Завтра ${ss.weekdayRu(target)} — расписания нет, отдыхаем 🎉` };
    } else {
      const subj = subjOf(u);
      const sk = subjKey(subj);
      const key = `${sk}|${u.showGaps ? 1 : 0}`;
      if (!dataCache.has(key)) {
        try {
          dataCache.set(key, buildDayData(csvText, subj, target, { showGaps: u.showGaps }));
        } catch (err) {
          log('WARN', `рассылка: разбор для ${sk}: ${err.message}`);
          dataCache.set(key, null);
        }
      }
      const data = dataCache.get(key);
      if (!data) {
        deferredCount += 1;
        continue;
      }
      if (data.note === 'no-lessons') {
        payload = { text: weekendTomorrow ? '🎉 Завтра выходной — пар нет, отдыхай!' : '📭 Завтра пар нет.' };
      } else {
        payload = vm.scheduleMessage(attachNotes(data, u.userId, targetIso), humanUrl, u.format);
        if (!digestSaved.has(sk)) {
          try {
            const canon = buildDayData(csvText, subj, target, {});
            storage.setDigest(`${sk}|${targetIso}`, ss.scheduleHash(canon), targetIso, ss.rowsSnapshot(canon));
          } catch {
            /* ignore */
          }
          digestSaved.add(sk);
        }
      }
    }
    try {
      await send(u.userId.slice(3), payload);
      sent += 1;
      storage.setLastSent(u.userId, targetIso);
    } catch (err) {
      skipped += 1;
      log('WARN', `ЛС ${u.userId}: ${err.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  log('INFO', `рассылка завершена: отправлено ${sent}, пропущено ${skipped}, отложено ${deferredCount}`);
  await logToChannel(`📨 Ежедневная рассылка на ${D.fmtDM(target)} (${D.weekdayRu(target)}): получателей ${due.length}, отправлено ${sent}, пропущено ${skipped}, отложено ${deferredCount}`);
}

async function reminderTick() {
  const users = storage.subscribers().filter((u) => isVkId(u.userId) && u.reminderMinutes > 0 && !isPaused(u.pausedUntil));
  if (!users.length) return;
  const today = D.todayParts();
  const todayIso = D.iso(today);
  const now = D.tzNow();
  const nowMin = now.h * 60 + now.mi;
  let csvText = null;
  try {
    csvText = (await ss.fetchDayCsv(today, 10 * 60 * 1000)).csvText;
  } catch {
    return;
  }
  const byKey = new Map();
  for (const u of users) {
    const subj = subjOf(u);
    if (!subj) continue;
    const sk = subjKey(subj);
    if (!byKey.has(sk)) {
      try {
        byKey.set(sk, buildDayData(csvText, subj, today, {}));
      } catch {
        byKey.set(sk, null);
      }
    }
    const data = byKey.get(sk);
    if (!data || data.note) continue;
    for (const r of data.rows) {
      if (r.kind !== 'lesson' || !r.start) continue;
      const startMin = D.toMinutes(r.start);
      if (startMin == null || startMin - nowMin !== u.reminderMinutes) continue;
      const dedup = `${u.userId}|${todayIso}|${startMin}`;
      if (remindersSent.has(dedup)) continue;
      remindersSent.add(dedup);
      try {
        const where = r.room ? `, ауд. ${r.room}` : '';
        const who = subj.kind === 'teacher' && r.groupsText ? ` — ${r.groupsText}` : '';
        const note = r.pair != null ? storage.getNotesForDay(u.userId, todayIso)[r.pair] : null;
        await send(u.userId.slice(3), { text: `⏰ Через ${u.reminderMinutes} мин пара: ${r.subject}${where}${who} (в ${r.start})${note ? `\n📝 ${note}` : ''}` });
      } catch (err) {
        log('WARN', `напоминание ${u.userId}: ${err.message || err}`);
      }
    }
  }
  for (const k of remindersSent) if (!k.includes(`|${todayIso}|`)) remindersSent.delete(k);
}

async function changeTick() {
  const todayIso = D.iso(D.todayParts());
  storage.purgeDigests(todayIso);
  const entries = storage.digestEntries().filter((e) => e.iso >= todayIso);
  if (!entries.length) return;
  const subs = storage.subscribers().filter((u) => isVkId(u.userId));
  for (const { key, group: sk, iso } of entries) {
    const target = D.partsFromIso(iso);
    if (!target) continue;
    const affected = subs.filter((u) => {
      if (isPaused(u.pausedUntil)) return false;
      const subj = subjOf(u);
      return subj && subjKey(subj) === sk && u.lastSent === iso;
    });
    if (!affected.length) continue;
    let csvText;
    let humanUrl = null;
    try {
      const r = await ss.fetchDayCsv(target, 10 * 60 * 1000);
      csvText = r.csvText;
      humanUrl = r.humanUrl;
    } catch {
      continue;
    }
    let canon;
    try {
      canon = buildDayData(csvText, subjOf(affected[0]), target, {});
    } catch {
      continue;
    }
    const hash = ss.scheduleHash(canon);
    if (hash === storage.getDigest(key)) continue;
    const oldSnap = storage.getDigestSnapshot(key);
    const newSnap = ss.rowsSnapshot(canon);
    let summaryText = null;
    if (Array.isArray(oldSnap) && oldSnap.length) {
      const diff = ss.diffRows(oldSnap, newSnap);
      if (diff.added.length || diff.removed.length || diff.changed.length) summaryText = vm.changeSummaryText(target, diff);
    }
    storage.setDigest(key, hash, iso, newSnap);
    log('INFO', `расписание изменилось: ${sk} на ${iso}, уведомляю ${affected.length}`);
    const header = summaryText || `⚠️ Расписание на ${D.fmtDM(target)} обновилось:`;
    for (const u of affected) {
      try {
        const data = buildDayData(csvText, subjOf(u), target, { showGaps: u.showGaps });
        const body = vm.scheduleMessage(attachNotes(data, u.userId, iso), humanUrl, u.format);
        await send(u.userId.slice(3), { text: header });
        await send(u.userId.slice(3), body);
      } catch (err) {
        log('WARN', `уведомление об изменении ${u.userId}: ${err.message || err}`);
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  }
}

async function pauseReminderTick() {
  const tomIso = D.iso(D.tomorrowParts());
  for (const u of storage.subscribers().filter((x) => isVkId(x.userId))) {
    if (u.pausedUntil !== tomIso || u.pauseEndNotified === tomIso) continue;
    try {
      await send(u.userId.slice(3), { text: `⏸ Пауза заканчивается завтра (${D.fmtDM(D.tomorrowParts())}) — рассылка, утро и напоминания снова включатся.` });
    } catch (err) {
      log('WARN', `пауза-напоминание ${u.userId}: ${err.message || err}`);
    }
    storage.setPauseEndNotified(u.userId, tomIso);
  }
}

async function announceTick() {
  const now = D.tzNow();
  const nowIso = D.iso(D.todayParts());
  const nowHHMM = `${D.pad(now.h)}:${D.pad(now.mi)}`;
  const due = storage.dueScheduledAnnounces(nowIso, nowHHMM).filter((a) => String(a.by || '').startsWith('vk:'));
  if (!due.length) return;
  for (const a of due) {
    storage.removeScheduledAnnounce(a.id);
    const { ok, fail, total } = await broadcastAnnouncement(a.text, a.group);
    storage.addAdminLog(a.by || 'система', `отложенное объявление ${a.id} отправлено (${ok}/${total})`);
    await logToChannel(`🕓✅ Отложенное объявление ${a.id} отправлено${a.group ? ` группе «${a.group}»` : ' всем'} (доставлено ${ok}/${total})`);
    if (a.by) {
      try {
        await send(a.by.slice(3), { text: `✅ Отложенное объявление отправлено: доставлено ${ok} из ${total}.` });
      } catch {
        /* ignore */
      }
    }
    void fail;
  }
}

async function healthTick() {
  if (!cfg.healthAlertEnabled) return;
  const admins = storage.getAdmins().filter((a) => String(a).startsWith('vk:'));
  if (!admins.length) return;
  const now = D.tzNow();
  const studyTime = now.h >= 7 && now.h < 20 && D.weekdayIso(D.todayParts()) <= 5;
  await ss.fetchDayCsv(D.todayParts(), 5 * 60 * 1000).catch(() => {});
  const h = ss.health();
  const staleMs = Date.now() - (h.lastOkAt || PROCESS_START);
  const broken = staleMs > cfg.healthAlertHours * 60 * 60 * 1000;
  if (broken && studyTime) {
    if (Date.now() - healthAlert.lastNotifiedAt < 6 * 60 * 60 * 1000) return;
    healthAlert.lastNotifiedAt = Date.now();
    healthAlert.notifiedBroken = true;
    const hoursAgo = h.lastOkAt ? Math.round(staleMs / 3600000) : null;
    const text = `🔴 Источник расписания не отвечает\n${h.lastOkAt ? `Последняя успешная загрузка ~${hoursAgo} ч назад.` : 'С момента запуска бота ни одной успешной загрузки.'}${h.lastErrMsg ? `\nОшибка: ${String(h.lastErrMsg).slice(0, 300)}` : ''}`;
    for (const a of admins) {
      try {
        await send(a.slice(3), { text });
      } catch {
        /* ignore */
      }
    }
  } else if (!broken && healthAlert.notifiedBroken && h.lastOkAt) {
    healthAlert.notifiedBroken = false;
    healthAlert.lastNotifiedAt = 0;
    for (const a of admins) {
      try {
        await send(a.slice(3), { text: '🟢 Источник расписания снова доступен.' });
      } catch {
        /* ignore */
      }
    }
  }
}

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.stack ? reason.stack : String(reason);
  log('ERROR', `unhandledRejection: ${msg}`);
});

// storage.js сам подсаживает cfg.adminId (Discord ID, без префикса) первым админом
// в свежий файл — для VK-хранилища это бессмысленное значение. Досаживаем реального
// VK-админа явно (см. тот же приём в telegramBot.js).
function bootstrapAdmin() {
  if (!cfg.vkAdminId) return;
  if (storage.addAdmin(`vk:${cfg.vkAdminId}`)) log('INFO', `админ по умолчанию: vk:${cfg.vkAdminId}`);
}

vk.updates
  .start()
  .then(() => {
    log('INFO', 'VK-бот запущен (Long Poll)');
    bootstrapAdmin();
    startSchedulers();
    logToChannel('🚀 VK-бот запущен');
  })
  .catch((err) => {
    log('ERROR', `не удалось запустить Long Poll: ${err.message}`);
  });
