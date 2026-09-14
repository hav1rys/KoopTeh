'use strict';

// Telegram-версия бота. Обычно подключается вместе с Discord-ботом из bot.js
// (один процесс, один и тот же users.json — Node кеширует storage.js по пути,
// так что оба бота делят один и тот же объект данных без гонки). Можно также
// запускать отдельно (npm run telegram), но тогда, если Discord-бот в это же
// время пишет в тот же DATA_FILE из другого процесса, нужен СВОЙ DATA_FILE.
//
// Ядро — то же самое, что у Discord-бота: storage.js, scheduleSource.js,
// weather.js, busSource.js, dates.js, render.js, config.js. Отличается только
// этот файл (роутинг) и telegramMenu.js (рендер под Telegram: HTML-текст +
// inline-клавиатуры, без эмбедов и без живых таймеров — время статичное,
// обновляется кнопкой «🔄 Обновить»).

const TelegramBot = require('node-telegram-bot-api');
const cfg = require('./config');
const D = require('./dates');
const storage = require('./storage');
const ss = require('./scheduleSource');
const weather = require('./weather');
const bus = require('./busSource');
const tm = require('./telegramMenu');

if (!cfg.telegramToken) {
  console.error('TELEGRAM_BOT_TOKEN не задан. Добавь переменную в панели BotHost (Startup / Variables) этого сервиса.');
  process.exit(1);
}

// -------------------------------------------------------------------- логи

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const MIN_LEVEL = LEVELS[cfg.logLevel] ?? 20;
function log(level, msg) {
  if ((LEVELS[level] ?? 20) < MIN_LEVEL) return;
  const line = `${new Date().toISOString()} TG ${level} ${msg}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

// Префикс, чтобы id пользователей Telegram никогда не пересеклись с Discord-id
// в общих структурах storage. rawId() — истинный, непривязанный id именно этого
// Telegram-чата (нужен только для самой операции привязки). uid() — id профиля,
// с которым реально работает вся остальная логика: если чат привязан к другому
// мессенджеру через /связать, это будет канонический id ТОГО профиля (и тогда
// расписание/настройки/подписка — общие с Discord/VK-аккаунтом того же человека).
const rawId = (chatId) => `tg:${chatId}`;
const uid = (chatId) => storage.resolveUid(rawId(chatId));

async function logToChannel(text) {
  if (!cfg.telegramLogChatId) return;
  try {
    await bot.sendMessage(cfg.telegramLogChatId, String(text).slice(0, 4000), { parse_mode: 'HTML' });
  } catch (err) {
    log('WARN', `лог-канал: ${err.message}`);
  }
}
const tag = (rawUid) => `${tm.code(rawUid)}`;

/** Логирует показанный пользователю текст расписания целиком. */
async function logSchedule(rawUid, action, data) {
  if (!data) return;
  let text;
  try {
    text = ss.scheduleText(data);
  } catch {
    text = '(не удалось сформировать текст расписания)';
  }
  await logToChannel(`📋 ${tag(rawUid)} — ${tm.esc(action)}\n<pre>${tm.esc(text.slice(0, 1500))}</pre>`);
}

// -------------------------------------------------------------- вспомогательное (как в index.js)

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
  return tm.buildMenu(s, {
    nextBroadcastEpoch: nb,
    nextPair,
    pausedUntil: paused ? s.pausedUntil : null,
    showBus: Boolean(s.away && s.homePlace),
  });
}

// nextPairLine живёт в telegramMenu.js, но он не экспортирован напрямую под этим именем
// для меню (там используется внутри buildNowMessage/scheduleText) — маленькая обёртка,
// чтобы не дублировать логику.
function nextPairLineSafe(data) {
  try {
    const msg = tm.buildNowMessage(data, '');
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

const bot = new TelegramBot(cfg.telegramToken, { polling: true });
bot.on('polling_error', (err) => log('WARN', `polling: ${err.message}`));

/** Единый рендер payload'а {text|photo, keyboard} — редактирует messageId, если можно, иначе шлёт новое. */
async function render(chatId, messageId, payload) {
  const keyboard = payload.keyboard ? { inline_keyboard: payload.keyboard } : undefined;
  if (payload.photo) {
    if (messageId) {
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
      } catch {
        /* было текстовое сообщение или уже без кнопок — не страшно */
      }
    }
    const sent = await bot.sendPhoto(chatId, payload.photo, { caption: (payload.caption || '').slice(0, 1000), reply_markup: keyboard }, { filename: 'image.png', contentType: 'image/png' });
    return sent.message_id;
  }
  const text = payload.text || 'Пусто.';
  if (messageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true });
      return messageId;
    } catch (err) {
      if (!/message is not modified/i.test(err.message || '')) log('DEBUG', `editMessageText fallback: ${err.message}`);
    }
  }
  const sent = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true });
  return sent.message_id;
}

/** Новое сообщение (не редактирует) — для «Прислать отдельно», рассылок и т.д. */
async function send(chatId, payload) {
  if (payload.photo) {
    return bot.sendPhoto(chatId, payload.photo, { caption: (payload.caption || '').slice(0, 1000) }, { filename: 'image.png', contentType: 'image/png' });
  }
  return bot.sendMessage(chatId, (payload.text || '').slice(0, 4000), { parse_mode: 'HTML', disable_web_page_preview: true });
}

// chatId -> { chatId, messageId } — последнее «навигируемое» сообщение (для inline-кнопок)
// не нужен отдельный стейт: callback_query сам несёт query.message.{chat.id,message_id}.

// chatId -> { kind, ...extra } — ожидание текстового ввода (замена модалок)
const awaiting = new Map();

// uid -> список групп (для листания), uid -> {kind, params, iso} (поиск), uid -> mondayIso (неделя)
const groupCache = new Map();
const lookupState = new Map();
const weekState = new Map();
const busCache = new Map();

function onlyPrivate(msg) {
  return msg.chat && msg.chat.type === 'private';
}

// ---------------------------------------------------------------- команды

bot.onText(/^\/start\b/, async (msg) => {
  if (!onlyPrivate(msg)) return void bot.sendMessage(msg.chat.id, 'Напиши мне в личные сообщения: t.me/' + (await bot.getMe()).username);
  const rawUid = uid(msg.chat.id);
  const view = menuView(rawUid);
  const sent = await bot.sendMessage(msg.chat.id, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard }, disable_web_page_preview: true });
  void sent;
});

bot.onText(/^\/помощь\b|^\/help\b/, async (msg) => {
  if (!onlyPrivate(msg)) return;
  const view = tm.buildHelpView();
  await bot.sendMessage(msg.chat.id, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
});

bot.onText(/^\/звонки\b/, async (msg) => {
  if (!onlyPrivate(msg)) return;
  const view = tm.bellView();
  await bot.sendMessage(msg.chat.id, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
});

bot.onText(/^\/сейчас\b/, async (msg) => {
  if (!onlyPrivate(msg)) return;
  const rawUid = uid(msg.chat.id);
  const s = effState(rawUid);
  if (!s.subj) return void bot.sendMessage(msg.chat.id, 'Сначала укажи группу или фамилию через /start.');
  const today = D.todayParts();
  let data = null;
  try {
    data = buildDayData((await ss.fetchDayCsv(today, 5 * 60 * 1000)).csvText, s.subj, today, {});
  } catch {
    /* нет данных */
  }
  const view = tm.buildNowMessage(data, s.subj.name);
  await bot.sendMessage(msg.chat.id, view.text, { parse_mode: 'HTML' });
  await logSchedule(rawUid, '/сейчас', data);
});

bot.onText(/^\/расписание\b\s*(.*)$/, async (msg, match) => {
  if (!onlyPrivate(msg)) return;
  const rawUid = uid(msg.chat.id);
  const s = effState(rawUid);
  const arg = (match[1] || '').trim();
  const subj = s.subj;
  if (!subj) return void bot.sendMessage(msg.chat.id, 'Сначала укажи группу через /start, либо напиши "/расписание дд.мм".');
  const target = arg ? parseDateField(arg) : D.todayParts();
  if (!target) return void bot.sendMessage(msg.chat.id, 'Не понял дату. Формат: дд.мм.');
  const { data, url, error } = await safeSchedule(subj, target, s.showGaps);
  const d = data ? attachNotes(data, rawUid, D.iso(target)) : data;
  const payload = error ? { text: tm.esc(error) } : tm.scheduleMessage(d, url, s.format);
  await send(msg.chat.id, payload);
  await logSchedule(rawUid, `/расписание на ${D.fmtDM(target)}`, d);
});

bot.onText(/^\/поиск\b\s*(.*)$/, async (msg, match) => {
  if (!onlyPrivate(msg)) return;
  const rawUid = uid(msg.chat.id);
  const q = (match[1] || '').trim();
  if (!q) return void bot.sendMessage(msg.chat.id, 'Напиши: /поиск <кабинет или фамилия>, например «/поиск 30» или «/поиск Иванов».');
  const target = D.todayParts();
  const isNum = /^\d/.test(q);
  await showLookup(msg.chat.id, rawUid, 'search', isNum ? { room: q } : { teacher: q }, target, { fresh: true });
});

bot.onText(/^\/преподаватель\b\s*(.*)$/, async (msg, match) => {
  if (!onlyPrivate(msg)) return;
  const rawUid = uid(msg.chat.id);
  const surname = (match[1] || '').trim();
  if (!surname) return void bot.sendMessage(msg.chat.id, 'Напиши: /преподаватель <фамилия>');
  await showLookup(msg.chat.id, rawUid, 'teacher', { surname }, D.todayParts(), { fresh: true });
});

bot.onText(/^\/admin\b/, async (msg) => {
  if (!onlyPrivate(msg)) return;
  const rawUid = uid(msg.chat.id);
  if (!storage.isAdmin(rawUid)) return void bot.sendMessage(msg.chat.id, 'Нет доступа.');
  const view = tm.buildAdminMenu();
  await bot.sendMessage(msg.chat.id, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
});

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

// ---------------------------------------------------------------- поиск/преподаватель

async function runLookup(kind, params, target) {
  const { csvText, humanUrl } = await ss.fetchDayCsv(target, 0);
  const data = kind === 'teacher' ? ss.buildTeacherData(csvText, params.surname, target) : ss.searchSchedule(csvText, params, target);
  return { data, humanUrl };
}

async function showLookup(chatId, rawUid, kind, params, target, { fresh = false, messageId = null } = {}) {
  lookupState.set(rawUid, { kind, params, iso: D.iso(target) });
  let payload;
  try {
    const { data, humanUrl } = await runLookup(kind, params, target);
    payload = { text: tm.scheduleText(data, humanUrl).slice(0, 4000), keyboard: tm.lookupKeyboard(data) };
    const label = kind === 'teacher' ? `поиск преподавателя «${params.surname}»` : 'поиск по кабинету/преподавателю';
    await logSchedule(rawUid, `${label} на ${D.fmtDM(target)}`, data);
  } catch (err) {
    const msg = err instanceof ss.NotPublishedError ? notPublishedText(target) : 'Не удалось выполнить поиск, попробуй позже.';
    if (!(err instanceof ss.NotPublishedError)) log('WARN', `lookup ${kind}: ${err.message}`);
    payload = { text: tm.esc(msg), keyboard: tm.lookupKeyboard(null) };
  }
  if (fresh) await send(chatId, payload);
  else await render(chatId, messageId, payload);
}

// ---------------------------------------------------------------- неделя

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

async function renderWeek(chatId, messageId, rawUid, mondayParts) {
  const s = effState(rawUid);
  const days = await loadWeekDays(s.subj, mondayParts);
  weekState.set(rawUid, D.iso(mondayParts));
  const view = tm.buildWeekView({ days });
  await render(chatId, messageId, view);
}

// ---------------------------------------------------------------- погода

async function renderWeatherView(chatId, messageId, rawUid, targetIso) {
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
    const view = tm.buildWeatherPanel(homeInfo, { place: cfg.weatherPlace, forecast: cityForecast }, targetIso, dateLabel);
    await render(chatId, messageId, view);
  } catch (err) {
    log('WARN', `погода: ${err.message}`);
    await render(chatId, messageId, { text: 'Не удалось получить погоду, попробуй позже.' });
  }
}

// ---------------------------------------------------------------- автобус

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

async function renderBusView(chatId, messageId, rawUid, targetIso, force = false) {
  const s = effState(rawUid);
  try {
    const data = await loadBusData(rawUid, s, force);
    const view = tm.buildBusView(data.place, data.toHomeRows, data.toCityRows, data.toHomeUrl, data.toCityUrl, targetIso);
    await render(chatId, messageId, view);
  } catch (err) {
    log('WARN', `автобус: ${err.message}`);
    await render(chatId, messageId, { text: 'Не удалось получить расписание автобусов, попробуй позже.' });
  }
}

// ---------------------------------------------------------------- callback_query роутер

bot.on('callback_query', async (query) => {
  try {
    await handleCallback(query);
  } catch (err) {
    log('ERROR', `callback: ${err.stack || err}`);
    try {
      await bot.answerCallbackQuery(query.id, { text: 'Что-то пошло не так, попробуй ещё раз.', show_alert: true });
    } catch {
      /* ignore */
    }
  }
});

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const rawUid = uid(chatId);
  const data = query.data || '';
  const [prefix] = data.split(':');

  // тихий ack по умолчанию; конкретные ветки могут переопределить текстом ниже
  const ack = (text) => bot.answerCallbackQuery(query.id, text ? { text, show_alert: false } : undefined).catch(() => {});

  if (data === 'noop') return void ack();

  if (prefix === 'menu') return void (await onMenuButton(chatId, messageId, rawUid, data.slice(5), ack));
  if (prefix === 'set') return void (await onSettingsButton(chatId, messageId, rawUid, data.slice(4), ack));
  if (prefix === 'away') return void (await onAwayButton(chatId, messageId, rawUid, data.slice(5), ack));
  if (prefix === 'link') return void (await onLinkButton(chatId, messageId, rawUid, data.slice(5), ack));
  if (prefix === 'pause') return void (await onPauseButton(chatId, messageId, rawUid, data.slice(6), ack));
  if (prefix === 'role') return void (await onRoleButton(chatId, messageId, rawUid, data.slice(5), ack));
  if (prefix === 'days') return void (await onDaysButton(chatId, messageId, rawUid, data.slice(5), ack));
  if (prefix === 'rem') return void (await onReminderButton(chatId, messageId, rawUid, data.slice(4), ack));
  if (prefix === 'mrn') return void (await onMorningButton(chatId, messageId, rawUid, data.slice(4), ack));
  if (prefix === 'grp') return void (await onGroupButton(chatId, messageId, rawUid, data.slice(4), ack));
  if (prefix === 'sch') return void (await onScheduleButton(chatId, messageId, rawUid, data.slice(4), ack));
  if (prefix === 'lk') return void (await onLookupButton(chatId, messageId, rawUid, data.slice(3), ack));
  if (prefix === 'wk') return void (await onWeekButton(chatId, messageId, rawUid, data.slice(3), ack));
  if (prefix === 'weather') return void (await onWeatherButton(chatId, messageId, rawUid, data.slice(8), ack));
  if (prefix === 'bus') return void (await onBusButton(chatId, messageId, rawUid, data.slice(4), ack));
  if (prefix === 'adm') return void (await onAdminButton(chatId, messageId, rawUid, data.slice(4), ack));
  await ack();
}

async function onMenuButton(chatId, messageId, rawUid, action, ack) {
  const s = effState(rawUid);
  switch (action) {
    case 'schedule': {
      if (!s.subj) return void ack('Сначала укажи группу или фамилию (👤 Роль).');
      await ack();
      const target = D.todayParts();
      const { data, url, error } = await safeSchedule(s.subj, target, s.showGaps);
      const withNotes = data ? attachNotes(data, rawUid, D.iso(target)) : data;
      const payload = error ? { text: tm.esc(error), keyboard: tm.scheduleKeyboard(D.iso(target), null, { rows: [] }) } : { ...tm.scheduleMessage(withNotes, url, s.format), keyboard: tm.scheduleKeyboard(D.iso(target), url, withNotes) };
      await render(chatId, messageId, payload);
      await logSchedule(rawUid, `открыл расписание на ${D.fmtDM(target)}`, withNotes);
      return;
    }
    case 'week':
      if (!s.subj) return void ack('Сначала укажи группу или фамилию.');
      await ack();
      await renderWeek(chatId, messageId, rawUid, D.mondayOf(D.todayParts()));
      return;
    case 'weather':
      await ack();
      await renderWeatherView(chatId, messageId, rawUid, D.iso(D.todayParts()));
      return;
    case 'bus': {
      if (!s.away || !s.homePlace) return void ack('Сначала укажи населённый пункт: ⚙️ Настройки → 🏘 Не из города.');
      await ack();
      await renderBusView(chatId, messageId, rawUid, D.iso(D.todayParts()), true);
      return;
    }
    case 'role':
      await ack();
      await render(chatId, messageId, tm.buildRoleView(s));
      return;
    case 'bell':
      await ack();
      await render(chatId, messageId, tm.bellView());
      return;
    case 'now': {
      if (!s.subj) return void ack('Сначала укажи группу или фамилию.');
      await ack();
      const target = D.tomorrowParts();
      const { data, url, error } = await safeSchedule(s.subj, target, s.showGaps);
      if (error) return void send(chatId, { text: tm.esc(error) });
      const d = attachNotes(data, rawUid, D.iso(target));
      await send(chatId, tm.scheduleMessage(d, url, s.format));
      await logSchedule(rawUid, `запросил расписание отдельным сообщением на ${D.fmtDM(target)}`, d);
      return;
    }
    case 'settings':
      await ack();
      await render(chatId, messageId, tm.buildSettingsView(s));
      return;
    case 'search':
      await ack();
      awaiting.set(rawUid, { kind: 'search' });
      await bot.sendMessage(chatId, 'Напиши кабинет или фамилию преподавателя (можно и то, и другое через запятую):');
      return;
    case 'teacher':
      await ack();
      awaiting.set(rawUid, { kind: 'teacherLookup' });
      await bot.sendMessage(chatId, 'Напиши фамилию преподавателя:');
      return;
    case 'rooms':
      await ack();
      awaiting.set(rawUid, { kind: 'rooms' });
      await bot.sendMessage(chatId, 'Напиши номер пары (1–7), можно через пробел добавить дату дд.мм:');
      return;
    case 'ask':
      await ack();
      awaiting.set(rawUid, { kind: 'ask' });
      await bot.sendMessage(chatId, 'Напиши вопрос администратору (первая строка — короткая тема, дальше — сам вопрос):');
      return;
    case 'help':
      await ack();
      await render(chatId, messageId, tm.buildHelpView());
      return;
    case 'refresh':
      await ack();
      await render(chatId, messageId, menuView(rawUid));
      return;
    default:
      await ack();
  }
}

async function onSettingsButton(chatId, messageId, rawUid, rest, ack) {
  const s = effState(rawUid);
  const back = () => render(chatId, messageId, tm.buildSettingsView(effState(rawUid)));
  switch (rest) {
    case 'back':
      await ack();
      return void (await render(chatId, messageId, menuView(rawUid)));
    case 'group':
      await ack();
      return void (await openGroupPicker(chatId, messageId, rawUid));
    case 'role':
      await ack();
      return void (await render(chatId, messageId, tm.buildRoleView(s)));
    case 'pause':
      await ack();
      return void (await render(chatId, messageId, tm.buildPauseView(s)));
    case 'away':
      await ack();
      return void (await render(chatId, messageId, tm.buildAwayView(s)));
    case 'link':
      await ack();
      return void (await render(chatId, messageId, tm.buildLinkView(storage.linkedIds(rawUid))));
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
      storage.setFormat(rawUid, tm.nextFormat(s.format));
      await ack();
      return void (await back());
    case 'wthrformat':
      storage.setWeatherFormat(rawUid, tm.nextFormat(s.weatherFormat));
      await ack();
      return void (await back());
    case 'time':
      await ack();
      awaiting.set(rawUid, { kind: 'time' });
      await bot.sendMessage(chatId, 'Напиши время рассылки в формате ЧЧ:ММ (например 18:30), или «-» чтобы сбросить на умолчание:');
      return;
    case 'days':
      await ack();
      return void (await render(chatId, messageId, tm.buildDaysView(s.days)));
    case 'reminder':
      await ack();
      return void (await render(chatId, messageId, tm.buildReminderView(s.reminderMinutes)));
    case 'morning':
      await ack();
      return void (await render(chatId, messageId, tm.buildMorningView(s)));
    default:
      await ack();
  }
}

async function onAwayButton(chatId, messageId, rawUid, rest, ack) {
  if (rest === 'back') {
    await ack();
    return void (await render(chatId, messageId, tm.buildSettingsView(effState(rawUid))));
  }
  if (rest === 'toggle') {
    const s = effState(rawUid);
    if (!s.away && !s.homePlace) return void ack('Сначала укажи населённый пункт.');
    storage.setAway(rawUid, !s.away);
    await ack();
    return void (await render(chatId, messageId, tm.buildAwayView(effState(rawUid))));
  }
  if (rest === 'place') {
    await ack();
    awaiting.set(rawUid, { kind: 'awayplace' });
    await bot.sendMessage(chatId, 'Напиши название населённого пункта (или «-», чтобы выключить):');
    return;
  }
  if (rest === 'stop') {
    await ack();
    awaiting.set(rawUid, { kind: 'awaystop' });
    await bot.sendMessage(chatId, 'Напиши номер остановки (напр. 2) или полное название (напр. «кладбище»), либо «-»:');
    return;
  }
  await ack();
}

async function onLinkButton(chatId, messageId, rawUid, rest, ack) {
  if (rest === 'code') {
    const code = storage.createLinkCode(rawUid);
    await ack();
    return void (await render(chatId, messageId, tm.buildLinkView(storage.linkedIds(rawUid), { code })));
  }
  if (rest === 'enter') {
    await ack();
    awaiting.set(rawUid, { kind: 'linkcode' });
    await bot.sendMessage(chatId, 'Пришли код (6 символов), который показал бот в другом мессенджере:');
    return;
  }
  if (rest === 'unlink') {
    const ok = storage.unlinkPlatform(rawId(chatId));
    await ack(ok ? 'Отвязано.' : undefined);
    return void (await render(chatId, messageId, tm.buildLinkView(storage.linkedIds(uid(chatId)), ok ? {} : { error: 'is-root' })));
  }
  await ack();
}

async function onPauseButton(chatId, messageId, rawUid, rest, ack) {
  if (rest === 'back') {
    await ack();
    return void (await render(chatId, messageId, tm.buildSettingsView(effState(rawUid))));
  }
  if (rest === 'date') {
    await ack();
    awaiting.set(rawUid, { kind: 'pausedate' });
    await bot.sendMessage(chatId, 'Напиши дату возвращения дд.мм (до этого дня — тишина):');
    return;
  }
  if (rest === 'off') {
    storage.setPausedUntil(rawUid, null);
    await ack();
    return void (await render(chatId, messageId, tm.buildPauseView(effState(rawUid))));
  }
  if (rest.startsWith('days:')) {
    const n = Number(rest.slice(5));
    if (!(n >= 1 && n <= 180)) return void ack();
    const until = D.iso(D.shiftParts(D.todayParts(), n));
    storage.setPausedUntil(rawUid, until);
    await ack();
    return void (await render(chatId, messageId, tm.buildPauseView(effState(rawUid))));
  }
  await ack();
}

async function onRoleButton(chatId, messageId, rawUid, rest, ack) {
  if (rest === 'done') {
    await ack();
    return void (await render(chatId, messageId, menuView(rawUid)));
  }
  if (rest === 'setname') {
    await ack();
    awaiting.set(rawUid, { kind: 'teachername' });
    await bot.sendMessage(chatId, 'Напиши свою фамилию (или «-», чтобы очистить):');
    return;
  }
  if (rest === 'student' || rest === 'teacher') {
    const st = storage.get(rawUid);
    if (rest === 'teacher' && !st.teacherName) return void ack('Сначала укажи фамилию (✏️).');
    if (rest === 'student' && !st.group) return void ack('Сначала укажи группу.');
    storage.setRole(rawUid, rest);
    await logToChannel(`👤 ${tag(rawUid)} сменил роль на «${rest === 'teacher' ? 'преподаватель' : 'студент'}»`);
    await ack();
    return void (await render(chatId, messageId, tm.buildRoleView(effState(rawUid))));
  }
  await ack();
}

async function onDaysButton(chatId, messageId, rawUid, rest, ack) {
  if (rest === 'done') {
    await ack();
    return void (await render(chatId, messageId, tm.buildSettingsView(effState(rawUid))));
  }
  if (rest.startsWith('toggle:')) {
    const isoDay = Number(rest.slice(7));
    if (!(isoDay >= 1 && isoDay <= 7)) return void ack();
    const cur = new Set(effState(rawUid).days);
    cur.has(isoDay) ? cur.delete(isoDay) : cur.add(isoDay);
    const next = [...cur].sort((a, c) => a - c);
    storage.setDays(rawUid, next);
    await ack();
    return void (await render(chatId, messageId, tm.buildDaysView(next)));
  }
  await ack();
}

async function onReminderButton(chatId, messageId, rawUid, rest, ack) {
  if (rest === 'done') {
    await ack();
    return void (await render(chatId, messageId, tm.buildSettingsView(effState(rawUid))));
  }
  if (rest.startsWith('set:')) {
    const n = Number(rest.slice(4));
    if (!tm.REMINDER_OPTS.includes(n)) return void ack();
    storage.setReminder(rawUid, n);
    await ack();
    return void (await render(chatId, messageId, tm.buildReminderView(n)));
  }
  await ack();
}

async function onMorningButton(chatId, messageId, rawUid, rest, ack) {
  if (rest === 'done') {
    await ack();
    return void (await render(chatId, messageId, tm.buildSettingsView(effState(rawUid))));
  }
  if (rest === 'time') {
    await ack();
    awaiting.set(rawUid, { kind: 'morningtime' });
    await bot.sendMessage(chatId, 'Напиши время утреннего сообщения ЧЧ:ММ (например 07:30):');
    return;
  }
  if (rest === 'greeting') {
    await ack();
    awaiting.set(rawUid, { kind: 'morninggreeting' });
    await bot.sendMessage(chatId, 'Напиши свой текст приветствия (или «-», чтобы вернуть по умолчанию):');
    return;
  }
  if (rest === 'toggle') {
    storage.setMorning(rawUid, !effState(rawUid).morning);
    await ack();
    return void (await render(chatId, messageId, tm.buildMorningView(effState(rawUid))));
  }
  await ack();
}

async function openGroupPicker(chatId, messageId, rawUid) {
  await render(chatId, messageId, { text: '⏳ Загружаю список групп…' });
  let view;
  try {
    const list = await ss.listAllGroups();
    groupCache.set(rawUid, list);
    view = list.length ? tm.buildGroupPicker(list, 0) : tm.buildGroupPicker([], 0, { error: 'Сайт не отдал список групп. Введи название вручную.' });
  } catch (err) {
    log('WARN', `список групп: ${err.message}`);
    view = tm.buildGroupPicker([], 0, { error: 'Не удалось загрузить список групп с сайта. Введи название вручную.' });
  }
  await render(chatId, messageId, view);
}

async function applyGroupChange(rawUid, newGroupRaw) {
  const old = storage.get(rawUid).group;
  storage.setGroup(rawUid, newGroupRaw);
  const now = storage.get(rawUid).group;
  if (!old) await logToChannel(`🆕 ${tag(rawUid)} зарегистрировался — группа «${tm.esc(now)}»`);
  else if (old !== now) await logToChannel(`🔄 ${tag(rawUid)} сменил группу: «${tm.esc(old)}» → «${tm.esc(now)}»`);
}

async function onGroupButton(chatId, messageId, rawUid, rest, ack) {
  if (rest === 'cancel') {
    await ack();
    return void (await render(chatId, messageId, menuView(rawUid)));
  }
  if (rest === 'manual') {
    await ack();
    awaiting.set(rawUid, { kind: 'group' });
    await bot.sendMessage(chatId, 'Напиши название группы, например 209ИС-1:');
    return;
  }
  if (rest.startsWith('page:')) {
    const page = Number(rest.slice(5)) || 0;
    await ack();
    if (groupCache.has(rawUid)) return void (await render(chatId, messageId, tm.buildGroupPicker(groupCache.get(rawUid), page)));
    await render(chatId, messageId, { text: '⏳ Обновляю список групп…' });
    try {
      const list = await ss.listAllGroups();
      groupCache.set(rawUid, list);
      await render(chatId, messageId, tm.buildGroupPicker(list, page));
    } catch (err) {
      log('WARN', `список групп: ${err.message}`);
      await render(chatId, messageId, tm.buildGroupPicker([], 0, { error: 'Не удалось загрузить список групп.' }));
    }
    return;
  }
  if (rest.startsWith('pick:')) {
    const [, pageStr, idxStr] = rest.split(':');
    const page = Number(pageStr) || 0;
    const idx = Number(idxStr);
    const list = groupCache.get(rawUid) || [];
    const group = list[page * tm.GROUPS_PER_PAGE + idx];
    if (!group) return void ack('Список устарел, попробуй заново.');
    await applyGroupChange(rawUid, group);
    await ack();
    await render(chatId, messageId, menuView(rawUid));
    return;
  }
  await ack();
}

async function renderSchedule(chatId, messageId, rawUid, target) {
  const s = effState(rawUid);
  const { data, url, error } = await safeSchedule(s.subj, target, s.showGaps);
  const withNotes = data ? attachNotes(data, rawUid, D.iso(target)) : data;
  const base = error ? { text: tm.esc(error) } : tm.scheduleMessage(withNotes, url, s.format);
  await render(chatId, messageId, { ...base, keyboard: tm.scheduleKeyboard(D.iso(target), url, withNotes || { rows: [] }) });
  await logSchedule(rawUid, `открыл расписание (кнопка) на ${D.fmtDM(target)}`, withNotes);
}

async function onScheduleButton(chatId, messageId, rawUid, rest, ack) {
  const s = effState(rawUid);
  if (rest === 'menu') {
    await ack();
    return void (await render(chatId, messageId, menuView(rawUid)));
  }
  if (rest.startsWith('report:')) {
    await ack();
    awaiting.set(rawUid, { kind: 'report', iso: rest.slice(7) });
    await bot.sendMessage(chatId, 'Что не так с расписанием? Опиши коротко:');
    return;
  }
  if (rest.startsWith('note:')) {
    await ack();
    awaiting.set(rawUid, { kind: 'note', iso: rest.slice(5) });
    await bot.sendMessage(chatId, 'Напиши: номер пары и через пробел текст заметки (например «3 взять чертёж»):');
    return;
  }
  if (rest.startsWith('send:')) {
    const t = D.partsFromIso(rest.slice(5));
    if (!t || !s.subj) return void ack();
    await ack();
    const { data, url, error } = await safeSchedule(s.subj, t, s.showGaps);
    if (error) return void send(chatId, { text: tm.esc(error) });
    const d = attachNotes(data, rawUid, D.iso(t));
    await send(chatId, tm.scheduleMessage(d, url, s.format));
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
      await send(chatId, { text: tm.scheduleText(data, humanUrl).slice(0, 4000) });
    } catch {
      await send(chatId, { text: tm.esc(notPublishedText(t)) });
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
  if (!s.subj) return void ack('Сначала укажи группу или фамилию в /start.');
  await ack();
  await renderSchedule(chatId, messageId, rawUid, target);
}

async function onLookupButton(chatId, messageId, rawUid, rest, ack) {
  if (rest === 'menu') {
    await ack();
    return void (await render(chatId, messageId, menuView(rawUid)));
  }
  const st = lookupState.get(rawUid);
  if (!st) {
    await ack();
    return void (await render(chatId, messageId, { text: 'Поиск устарел — открой заново из меню.' }));
  }
  if (rest === 'pin') {
    if (st.kind !== 'teacher' || !st.params.surname) return void ack();
    const hadTeacherName = storage.get(rawUid).teacherName;
    storage.setTeacherName(rawUid, st.params.surname);
    storage.setRole(rawUid, 'teacher');
    if (!storage.get(rawUid).subscribed) storage.setSubscribed(rawUid, true);
    await logToChannel(
      hadTeacherName
        ? `🔄 ${tag(rawUid)} сменил фамилию преподавателя: «${tm.esc(hadTeacherName)}» → «${tm.esc(st.params.surname)}» (закреплено через поиск)`
        : `🆕 ${tag(rawUid)} зарегистрировался — преподаватель «${tm.esc(st.params.surname)}» (закреплено через поиск)`,
    );
    await ack();
    return void (await render(chatId, messageId, menuView(rawUid)));
  }
  let target;
  if (rest === 'day:today') target = D.todayParts();
  else if (rest === 'day:tomorrow') target = D.tomorrowParts();
  else if (rest === 'prev' || rest === 'next') {
    const bParts = D.partsFromIso(st.iso) || D.todayParts();
    target = D.shiftParts(bParts, rest === 'prev' ? -1 : 1);
  } else return void ack();
  await ack();
  await showLookup(chatId, rawUid, st.kind, st.params, target, { fresh: false, messageId });
}

async function onWeekButton(chatId, messageId, rawUid, rest, ack) {
  if (rest === 'menu') {
    await ack();
    return void (await render(chatId, messageId, menuView(rawUid)));
  }
  const cur = D.partsFromIso(weekState.get(rawUid) || '') || D.mondayOf(D.todayParts());
  let monday;
  if (rest === 'this') monday = D.mondayOf(D.todayParts());
  else if (rest === 'prev') monday = D.shiftParts(cur, -7);
  else if (rest === 'next') monday = D.shiftParts(cur, 7);
  else return void ack();
  await ack();
  await renderWeek(chatId, messageId, rawUid, monday);
}

async function onWeatherButton(chatId, messageId, rawUid, rest, ack) {
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
  await renderWeatherView(chatId, messageId, rawUid, D.iso(target));
}

async function onBusButton(chatId, messageId, rawUid, rest, ack) {
  let target = null;
  if (rest === 'jump:today') target = D.todayParts();
  else if (rest === 'jump:tomorrow') target = D.tomorrowParts();
  else if (rest.startsWith('prev:') || rest.startsWith('next:')) {
    const bParts = D.partsFromIso(rest.slice(5));
    if (bParts) target = D.shiftParts(bParts, rest.startsWith('prev:') ? -1 : 1);
  }
  if (!target) return void ack();
  await ack();
  await renderBusView(chatId, messageId, rawUid, D.iso(target));
}

// ---------------------------------------------------------------- админ-панель

async function onAdminButton(chatId, messageId, rawUid, rest, ack) {
  if (!storage.isAdmin(rawUid)) return void ack('Нет доступа.');
  if (rest === 'menu') {
    await ack();
    return void (await render(chatId, messageId, tm.buildAdminMenu()));
  }
  if (rest === 'stats') {
    await ack();
    return void (await render(chatId, messageId, tm.buildStatsView(storage.stats())));
  }
  if (rest === 'health') {
    await ack();
    return void (await render(chatId, messageId, tm.buildHealthView(ss.health())));
  }
  if (rest === 'log') {
    await ack();
    return void (await render(chatId, messageId, tm.buildAdminLogView(storage.getAdminLog(15))));
  }
  if (rest === 'schann') {
    await ack();
    return void (await render(chatId, messageId, tm.buildSchedAnnView(storage.listScheduledAnnounces())));
  }
  if (rest === 'schann:add') {
    await ack();
    awaiting.set(rawUid, { kind: 'schann' });
    await bot.sendMessage(chatId, 'Напиши тремя строками:\n1) дд.мм ЧЧ:ММ\n2) группа (или «-» — всем)\n3) текст объявления');
    return;
  }
  if (rest.startsWith('schann:del:')) {
    const sid = rest.slice(11);
    if (storage.removeScheduledAnnounce(sid)) {
      storage.addAdminLog(rawUid, `удалил отложенное объявление ${sid}`);
      await logToChannel(`🛠 ${tag(rawUid)} удалил отложенное объявление <code>${sid}</code>`);
    }
    await ack();
    return void (await render(chatId, messageId, tm.buildSchedAnnView(storage.listScheduledAnnounces())));
  }
  if (rest === 'admins') {
    await ack();
    return void (await render(chatId, messageId, tm.buildAdminsView(storage.getAdmins(), rawUid)));
  }
  if (rest === 'announce') {
    await ack();
    awaiting.set(rawUid, { kind: 'announce' });
    await bot.sendMessage(chatId, 'Напиши текст объявления. Если это объявление для одной группы — первой строкой напиши «группа: <название>», дальше сам текст.');
    return;
  }
  if (rest === 'addadmin') {
    await ack();
    awaiting.set(rawUid, { kind: 'addadmin' });
    await bot.sendMessage(chatId, 'Напиши Telegram chat ID нового админа (числом — его можно узнать через @userinfobot):');
    return;
  }
  if (rest.startsWith('del:')) {
    const id = rest.slice(4);
    if (!storage.removeAdmin(id)) return void ack('Нельзя удалить (последний админ или не найден).');
    storage.addAdminLog(rawUid, `удалил админа …${String(id).slice(-4)}`);
    await logToChannel(`🛠 ${tag(rawUid)} удалил админа ${tag(id)}`);
    await ack();
    return void (await render(chatId, messageId, tm.buildAdminsView(storage.getAdmins(), rawUid)));
  }
  await ack();
}

/** Разослать объявление подписчикам этой платформы (всем или одной группе). */
async function broadcastAnnouncement(text, group) {
  const wantG = group ? ss.normGroup(group) : null;
  const subs = storage.subscribers().filter((u) => {
    if (!String(u.userId).startsWith('tg:')) return false;
    if (!wantG) return true;
    return u.group && u.role !== 'teacher' && ss.normGroup(u.group) === wantG;
  });
  let ok = 0;
  let fail = 0;
  for (const u of subs) {
    try {
      await bot.sendMessage(u.userId.slice(3), `📢 ${tm.b('Объявление')}\n\n${tm.esc(text)}`, { parse_mode: 'HTML' });
      ok += 1;
    } catch {
      fail += 1;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return { ok, fail, total: subs.length };
}

// ---------------------------------------------------------------- ответ на вопрос (закреплено в лог-канале)

async function relayToAdmin(chatId, rawUid, topic, body) {
  const qid = storage.addQuestion(rawUid, `tg:${chatId}`, topic, body);
  const admins = storage.getAdmins().filter((a) => String(a).startsWith('tg:'));
  let delivered = 0;
  for (const adminUid of admins) {
    try {
      await bot.sendMessage(adminUid.slice(3), `❓ ${tm.b(topic)}\n\n${tm.esc(body)}\n\nОт: ${tag(rawUid)}\n\nОтветить: /ответ_${qid} <текст>`, { parse_mode: 'HTML' });
      delivered += 1;
    } catch (err) {
      log('WARN', `вопрос ${qid} -> админу ${adminUid}: ${err.message}`);
    }
  }
  if (delivered) {
    log('INFO', `вопрос ${qid} от ${rawUid} -> ${delivered} админам`);
    await bot.sendMessage(chatId, '✅ Отправлено. Ответ придёт тебе в личные сообщения.');
  } else {
    storage.deleteQuestion(qid);
    await bot.sendMessage(chatId, 'Не удалось доставить администратору. Попробуй позже.');
  }
}

bot.onText(/^\/ответ_([a-f0-9]+)\s+([\s\S]+)$/, async (msg, match) => {
  if (!onlyPrivate(msg)) return;
  const rawUid = uid(msg.chat.id);
  if (!storage.isAdmin(rawUid)) return;
  const qid = match[1];
  const answer = match[2].trim();
  const q = storage.getQuestion(qid);
  if (!q) return void bot.sendMessage(msg.chat.id, 'Вопрос не найден или на него уже ответили.');
  try {
    const askerChatId = String(q.askerTag).replace(/^tg:/, '');
    await bot.sendMessage(askerChatId, `💬 ${tm.b(`Ответ на твой вопрос: ${q.topic}`)}\n\n${tm.esc(q.question)}\n\n${tm.b('Ответ')}: ${tm.esc(answer)}`, { parse_mode: 'HTML' });
    storage.deleteQuestion(qid);
    await bot.sendMessage(msg.chat.id, '✅ Ответ отправлен.');
  } catch (err) {
    log('WARN', `не доставить ответ ${qid}: ${err.message}`);
    await bot.sendMessage(msg.chat.id, 'Не удалось отправить ответ — возможно, у пользователя закрыты ЛС.');
  }
});

// ---------------------------------------------------------------- текстовые ответы (замена модалок)

bot.on('message', async (msg) => {
  try {
    if (!onlyPrivate(msg) || !msg.text || msg.text.startsWith('/')) return;
    const rawUid = uid(msg.chat.id);
    const pending = awaiting.get(rawUid);
    if (!pending) return;
    awaiting.delete(rawUid);
    await handleAwaitingText(msg.chat.id, rawUid, pending, msg.text.trim());
  } catch (err) {
    log('ERROR', `message: ${err.stack || err}`);
    try {
      await bot.sendMessage(msg.chat.id, 'Что-то пошло не так, попробуй ещё раз.');
    } catch {
      /* ignore */
    }
  }
});

async function handleAwaitingText(chatId, rawUid, pending, text) {
  const s = effState(rawUid);
  switch (pending.kind) {
    case 'group': {
      if (!text) return void bot.sendMessage(chatId, 'Пустое название группы.');
      await applyGroupChange(rawUid, text);
      log('INFO', `${rawUid} ввёл группу "${text}"`);
      const view = menuView(rawUid);
      await bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
      return;
    }
    case 'teachername': {
      const surname = text === '-' ? '' : text;
      const hadTeacherName = storage.get(rawUid).teacherName;
      storage.setTeacherName(rawUid, surname || null);
      if (surname) storage.setRole(rawUid, 'teacher');
      else if (storage.get(rawUid).role === 'teacher') storage.setRole(rawUid, 'student');
      if (surname && !hadTeacherName) await logToChannel(`🆕 ${tag(rawUid)} зарегистрировался — преподаватель «${tm.esc(surname)}»`);
      else if (surname && hadTeacherName !== surname) await logToChannel(`🔄 ${tag(rawUid)} сменил фамилию преподавателя: «${tm.esc(hadTeacherName)}» → «${tm.esc(surname)}»`);
      const view = tm.buildRoleView(effState(rawUid));
      await bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
      return;
    }
    case 'time': {
      if (text === '-') {
        storage.setTime(rawUid, null);
      } else {
        const hhmm = D.parseHHMM(text);
        if (!hhmm) return void bot.sendMessage(chatId, 'Неверный формат. Нужно ЧЧ:ММ, например 18:30.');
        storage.setTime(rawUid, hhmm);
      }
      const view = tm.buildSettingsView(effState(rawUid));
      await bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
      return;
    }
    case 'morningtime': {
      const hhmm = D.parseHHMM(text);
      if (!hhmm) return void bot.sendMessage(chatId, 'Неверный формат. Нужно ЧЧ:ММ, например 07:30.');
      storage.setMorningTime(rawUid, hhmm);
      const view = tm.buildMorningView(effState(rawUid));
      await bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
      return;
    }
    case 'morninggreeting': {
      storage.setMorningGreeting(rawUid, text === '-' ? null : text);
      const view = tm.buildMorningView(effState(rawUid));
      await bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
      return;
    }
    case 'pausedate': {
      const target = parseDateField(text);
      const todayIso = D.iso(D.todayParts());
      if (!target || D.iso(target) <= todayIso) return void bot.sendMessage(chatId, 'Нужна будущая дата в формате дд.мм (например 20.09).');
      storage.setPausedUntil(rawUid, D.iso(target));
      const view = tm.buildPauseView(effState(rawUid));
      await bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
      return;
    }
    case 'awayplace': {
      if (text === '-') {
        storage.setHomePlace(rawUid, null, null, null);
        storage.setAway(rawUid, false);
        const view = tm.buildAwayView(effState(rawUid));
        await bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
        return;
      }
      await bot.sendMessage(chatId, '⏳ Ищу населённый пункт…');
      let geo = null;
      try {
        geo = await weather.geocode(text);
      } catch (err) {
        log('WARN', `геокодинг "${text}": ${err.message}`);
      }
      if (!geo) return void bot.sendMessage(chatId, `Не нашёл «${text}» на карте. Проверь написание и попробуй ещё раз.`);
      storage.setHomePlace(rawUid, text, geo.lat, geo.lon);
      log('INFO', `${rawUid} задал населённый пункт «${text}» (${geo.lat}, ${geo.lon})`);
      const view = tm.buildAwayView(effState(rawUid));
      await bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
      return;
    }
    case 'awaystop': {
      storage.setHomeStop(rawUid, text === '-' ? null : text);
      const view = tm.buildAwayView(effState(rawUid));
      await bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
      return;
    }
    case 'linkcode': {
      const r = storage.redeemLinkCode(text, rawId(chatId));
      const view = tm.buildLinkView(storage.linkedIds(uid(chatId)), r.ok ? {} : { error: r.error });
      await bot.sendMessage(chatId, r.ok ? '✅ Связано! Теперь это один профиль.\n\n' + view.text : view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
      return;
    }
    case 'ask': {
      const lines = text.split('\n');
      const topic = (lines[0] || 'Без темы').slice(0, 100);
      const question = (lines.slice(1).join('\n') || lines[0] || '').trim();
      if (!question) return void bot.sendMessage(chatId, 'Пустой вопрос.');
      await relayToAdmin(chatId, rawUid, topic, question);
      return;
    }
    case 'report': {
      const who = s.subj ? (s.subj.kind === 'teacher' ? `преп. ${s.subj.name}` : `группа ${s.subj.name}`) : '—';
      const t = D.partsFromIso(pending.iso);
      await relayToAdmin(chatId, rawUid, `Ошибка в расписании: ${t ? D.fmtDM(t) : pending.iso}, ${who}`, text);
      return;
    }
    case 'note': {
      const m = /^(\d)\s*(.*)$/.exec(text);
      if (!m) return void bot.sendMessage(chatId, 'Начни с номера пары (1–7), например «3 взять чертёж».');
      const pair = Number(m[1]);
      const noteText = m[2].trim();
      storage.setNote(rawUid, pending.iso, pair, noteText || null);
      const t = D.partsFromIso(pending.iso);
      await bot.sendMessage(chatId, noteText ? `📝 Заметка к ${pair}-й паре${t ? ` на ${D.fmtDM(t)}` : ''} сохранена.` : '📝 Заметка удалена.');
      if (t) await renderSchedule(chatId, null, rawUid, t);
      return;
    }
    case 'search': {
      const parts = text.split(',').map((x) => x.trim()).filter(Boolean);
      const room = parts.find((p) => /^\d/.test(p)) || '';
      const teacher = parts.find((p) => !/^\d/.test(p)) || '';
      if (!room && !teacher) return void bot.sendMessage(chatId, 'Заполни кабинет или фамилию.');
      await showLookup(chatId, rawUid, 'search', { room, teacher }, D.todayParts(), { fresh: true });
      return;
    }
    case 'teacherLookup': {
      if (!text) return void bot.sendMessage(chatId, 'Укажи фамилию.');
      await showLookup(chatId, rawUid, 'teacher', { surname: text }, D.todayParts(), { fresh: true });
      return;
    }
    case 'rooms': {
      const m = /^([1-7])\s*(\d{1,2}\.\d{1,2})?/.exec(text);
      if (!m) return void bot.sendMessage(chatId, 'Номер пары — число от 1 до 7 (можно добавить дату дд.мм).');
      const pair = Number(m[1]);
      const target = m[2] ? parseDateField(m[2]) : D.todayParts();
      if (!target) return void bot.sendMessage(chatId, 'Не понял дату.');
      try {
        const { csvText } = await ss.fetchDayCsv(target, 5 * 60 * 1000);
        const result = ss.freeRooms(csvText, target, pair);
        const view = tm.buildRoomsView(result, target);
        await bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
      } catch (err) {
        const errMsg = err instanceof ss.NotPublishedError ? notPublishedText(target) : 'Не удалось получить данные, попробуй позже.';
        if (!(err instanceof ss.NotPublishedError)) log('WARN', `кабинеты: ${err.message}`);
        await bot.sendMessage(chatId, errMsg);
      }
      return;
    }
    case 'announce': {
      if (!storage.isAdmin(rawUid)) return;
      const m = /^группа:\s*(\S.*)\n([\s\S]+)$/i.exec(text);
      const group = m ? m[1].trim() : '';
      const body = m ? m[2].trim() : text;
      if (!body) return void bot.sendMessage(chatId, 'Пустой текст.');
      await bot.sendMessage(chatId, `Рассылаю объявление${group ? ` группе ${group}` : ' всем подписчикам'}…`);
      const { ok, fail, total } = await broadcastAnnouncement(body, group);
      storage.addAdminLog(rawUid, `объявление ${group ? `группе ${group}` : 'всем'} (${ok}/${total})`);
      await logToChannel(`📢 ${tag(rawUid)} разослал объявление${group ? ` группе «${tm.esc(group)}»` : ' всем подписчикам'} (доставлено ${ok}/${total})\n<pre>${tm.esc(body.slice(0, 1200))}</pre>`);
      await bot.sendMessage(chatId, `Готово: доставлено ${ok} из ${total}, не доставлено ${fail}.`);
      return;
    }
    case 'schann': {
      if (!storage.isAdmin(rawUid)) return;
      const lines2 = text.split('\n').map((x) => x.trim());
      const whenRaw = lines2[0] || '';
      const group = lines2[1] && lines2[1] !== '-' ? lines2[1] : '';
      const body = lines2.slice(2).join('\n').trim();
      const m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})$/.exec(whenRaw);
      if (!m || !body) return void bot.sendMessage(chatId, 'Формат: первая строка «дд.мм ЧЧ:ММ», вторая — группа или «-», дальше — текст.');
      const dd = +m[1];
      const mm = +m[2];
      const hh = +m[4];
      const mi = +m[5];
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59) return void bot.sendMessage(chatId, 'Неверная дата или время.');
      const nowY = D.todayParts().y;
      let atParts = D.partsFromIso(`${m[3] ? +m[3] : nowY}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
      if (!atParts) return void bot.sendMessage(chatId, 'Неверная дата.');
      const nowIso = D.iso(D.todayParts());
      if (!m[3] && D.iso(atParts) < nowIso) atParts = D.partsFromIso(`${nowY + 1}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
      const atIso = D.iso(atParts);
      const atHHMM = `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
      const nn = D.tzNow();
      if (atIso < nowIso || (atIso === nowIso && atHHMM <= `${String(nn.h).padStart(2, '0')}:${String(nn.mi).padStart(2, '0')}`)) {
        return void bot.sendMessage(chatId, 'Это время уже прошло.');
      }
      const sid = storage.addScheduledAnnounce({ text: body, atIso, atHHMM, group: group || null, by: rawUid });
      storage.addAdminLog(rawUid, `запланировал объявление ${sid} на ${atIso} ${atHHMM}`);
      await logToChannel(`🕓 ${tag(rawUid)} запланировал объявление <code>${sid}</code> на ${atIso} ${atHHMM}${group ? ` (${tm.esc(group)})` : ''}\n<pre>${tm.esc(body.slice(0, 1200))}</pre>`);
      const view = tm.buildSchedAnnView(storage.listScheduledAnnounces());
      await bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
      return;
    }
    case 'addadmin': {
      if (!storage.isAdmin(rawUid)) return;
      const newChatId = text.trim();
      if (!/^\d{4,15}$/.test(newChatId)) return void bot.sendMessage(chatId, 'Это не похоже на числовой Telegram chat ID.');
      const added = storage.addAdmin(`tg:${newChatId}`);
      if (added) await logToChannel(`🛠 ${tag(rawUid)} добавил админа ${tag(`tg:${newChatId}`)}`);
      const view = tm.buildAdminsView(storage.getAdmins(), rawUid);
      await bot.sendMessage(chatId, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
      return;
    }
    default:
  }
}

// --------------------------------------------------------- планировщики (как в index.js, только TG-адресаты)

const isTgId = (id) => String(id).startsWith('tg:');
let broadcasting = false;
const remindersSent = new Set();
const PROCESS_START = Date.now();
const healthAlert = { notifiedBroken: false, lastNotifiedAt: 0 };

function startSchedulers() {
  log('INFO', `Telegram: рассылка по умолчанию ${cfg.defaultTime} ${cfg.timezone}, дни [${cfg.defaultDays.join(',')}]`);
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
  const subs = storage.subscribers().filter((u) => isTgId(u.userId));
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
    if (!isTgId(u.userId)) return false;
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
      const chatId = u.userId.slice(3);
      await bot.sendMessage(chatId, tm.esc(body));
      if (cfg.weatherEnabled) {
        if (u.away && u.homePlace && u.homeLat != null && u.homeLon != null) {
          try {
            const homeForecast = await weather.dayForecast(u.homeLat, u.homeLon);
            const view = tm.buildWeatherPanel({ place: u.homePlace, forecast: homeForecast }, { place: cfg.weatherPlace, forecast: cityForecast || { ranges: [], advice: [] } }, D.iso(today), null);
            await bot.sendMessage(chatId, view.text, { parse_mode: 'HTML' });
          } catch (err) {
            log('WARN', `погода (дом, ${u.userId}): ${err.message}`);
          }
        } else if (cityForecast) {
          await bot.sendMessage(chatId, tm.weatherText(cfg.weatherPlace, cityForecast, null), { parse_mode: 'HTML' }).catch(() => {});
        }
      }
      storage.setMorningLastSent(u.userId, todayIso);
    } catch (err) {
      if (err && /bot was blocked|chat not found/i.test(err.message || '')) storage.setMorningLastSent(u.userId, todayIso);
      else log('WARN', `утро ${u.userId}: ${err.message || err}`);
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
    if (!isTgId(u.userId)) return false;
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
      payload = { text: tm.esc(`Завтра ${ss.weekdayRu(target)} — расписания нет, отдыхаем 🎉`) };
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
        payload = { text: tm.esc(weekendTomorrow ? '🎉 Завтра выходной — пар нет, отдыхай!' : '📭 Завтра пар нет.') };
      } else {
        payload = tm.scheduleMessage(attachNotes(data, u.userId, targetIso), humanUrl, u.format);
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
      if (err && /bot was blocked|chat not found/i.test(err.message || '')) storage.setLastSent(u.userId, targetIso);
      else log('WARN', `ЛС ${u.userId}: ${err.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  log('INFO', `рассылка завершена: отправлено ${sent}, пропущено ${skipped}, отложено ${deferredCount}`);
  await logToChannel(`📨 Ежедневная рассылка на ${D.fmtDM(target)} (${D.weekdayRu(target)}): получателей ${due.length}, отправлено ${sent}, пропущено ${skipped}, отложено ${deferredCount}`);
}

async function reminderTick() {
  const users = storage.subscribers().filter((u) => isTgId(u.userId) && u.reminderMinutes > 0 && !isPaused(u.pausedUntil));
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
        await bot.sendMessage(u.userId.slice(3), `⏰ Через ${u.reminderMinutes} мин пара: ${tm.b(r.subject)}${tm.esc(where)}${tm.esc(who)} (в ${r.start})${note ? `\n📝 ${tm.esc(note)}` : ''}`, { parse_mode: 'HTML' });
      } catch (err) {
        if (!/bot was blocked|chat not found/i.test(err.message || '')) log('WARN', `напоминание ${u.userId}: ${err.message || err}`);
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
  const subs = storage.subscribers().filter((u) => isTgId(u.userId));
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
      if (diff.added.length || diff.removed.length || diff.changed.length) summaryText = tm.changeSummaryText(target, diff);
    }
    storage.setDigest(key, hash, iso, newSnap);
    log('INFO', `расписание изменилось: ${sk} на ${iso}, уведомляю ${affected.length}`);
    const header = summaryText || `⚠️ Расписание на ${D.fmtDM(target)} обновилось:`;
    for (const u of affected) {
      try {
        const data = buildDayData(csvText, subjOf(u), target, { showGaps: u.showGaps });
        const body = tm.scheduleMessage(attachNotes(data, u.userId, iso), humanUrl, u.format);
        await bot.sendMessage(u.userId.slice(3), header, { parse_mode: 'HTML' });
        await send(u.userId.slice(3), body);
      } catch (err) {
        if (!/bot was blocked|chat not found/i.test(err.message || '')) log('WARN', `уведомление об изменении ${u.userId}: ${err.message || err}`);
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  }
}

async function pauseReminderTick() {
  const tomIso = D.iso(D.tomorrowParts());
  for (const u of storage.subscribers().filter((x) => isTgId(x.userId))) {
    if (u.pausedUntil !== tomIso || u.pauseEndNotified === tomIso) continue;
    try {
      await bot.sendMessage(u.userId.slice(3), `⏸ Пауза заканчивается завтра (${D.fmtDM(D.tomorrowParts())}) — рассылка, утро и напоминания снова включатся.`);
    } catch (err) {
      if (!/bot was blocked|chat not found/i.test(err.message || '')) log('WARN', `пауза-напоминание ${u.userId}: ${err.message || err}`);
    }
    storage.setPauseEndNotified(u.userId, tomIso);
  }
}

async function announceTick() {
  const now = D.tzNow();
  const nowIso = D.iso(D.todayParts());
  const nowHHMM = `${D.pad(now.h)}:${D.pad(now.mi)}`;
  const due = storage.dueScheduledAnnounces(nowIso, nowHHMM).filter((a) => String(a.by || '').startsWith('tg:'));
  if (!due.length) return;
  for (const a of due) {
    storage.removeScheduledAnnounce(a.id);
    const { ok, fail, total } = await broadcastAnnouncement(a.text, a.group);
    storage.addAdminLog(a.by || 'система', `отложенное объявление ${a.id} отправлено (${ok}/${total})`);
    await logToChannel(`🕓✅ Отложенное объявление <code>${a.id}</code> отправлено${a.group ? ` группе «${tm.esc(a.group)}»` : ' всем'} (доставлено ${ok}/${total})`);
    if (a.by) {
      try {
        await bot.sendMessage(a.by.slice(3), `✅ Отложенное объявление отправлено: доставлено ${ok} из ${total}.`);
      } catch {
        /* ignore */
      }
    }
    void fail;
  }
}

async function healthTick() {
  if (!cfg.healthAlertEnabled) return;
  const admins = storage.getAdmins().filter((a) => String(a).startsWith('tg:'));
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
    const text = `🔴 Источник расписания не отвечает\n${h.lastOkAt ? `Последняя успешная загрузка ~${hoursAgo} ч назад.` : 'С момента запуска бота ни одной успешной загрузки.'}${h.lastErrMsg ? `\nОшибка: ${tm.esc(String(h.lastErrMsg).slice(0, 300))}` : ''}`;
    for (const a of admins) {
      try {
        await bot.sendMessage(a.slice(3), text);
      } catch {
        /* ignore */
      }
    }
  } else if (!broken && healthAlert.notifiedBroken && h.lastOkAt) {
    healthAlert.notifiedBroken = false;
    healthAlert.lastNotifiedAt = 0;
    for (const a of admins) {
      try {
        await bot.sendMessage(a.slice(3), '🟢 Источник расписания снова доступен.');
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
// в свежий файл — для Telegram-хранилища это бессмысленное значение (никогда не
// совпадёт с "tg:<chatId>"). Досаживаем реального телеграм-админа явно.
function bootstrapAdmin() {
  if (!cfg.telegramAdminId) return;
  if (storage.addAdmin(`tg:${cfg.telegramAdminId}`)) log('INFO', `админ по умолчанию: tg:${cfg.telegramAdminId}`);
}

bot.getMe().then((me) => {
  log('INFO', `Telegram-бот запущен: @${me.username}`);
  bootstrapAdmin();
  startSchedulers();
  logToChannel(`🚀 Telegram-бот запущен — @${me.username}`);
});
