'use strict';

const {
  Client,
  GatewayIntentBits,
  Events,
  ActivityType,
  MessageFlags,
  SlashCommandBuilder,
  ApplicationIntegrationType,
  InteractionContextType,
} = require('discord.js');

const cfg = require('./config');
const D = require('./dates');
const storage = require('./storage');
const ss = require('./scheduleSource');
const render = require('./render');
const weather = require('./weather');
const bus = require('./busSource');
const menu = require('./menu');
const bridge = require('./platformBridge');

if (!cfg.token) {
  console.error('DISCORD_BOT_TOKEN не задан. Добавь переменную в панели BotHost (Startup / Variables).');
  process.exit(1);
}

// -------------------------------------------------------------------- логи

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const MIN_LEVEL = LEVELS[cfg.logLevel] ?? 20;
function log(level, msg) {
  if ((LEVELS[level] ?? 20) < MIN_LEVEL) return;
  const line = `${new Date().toISOString()} ${level} ${msg}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------- подробный лог в канал

const discordLog = require('./discordLog');

/**
 * Пишет строку в один из 4 категорийных каналов (действия/отправки/ошибки/вопросы —
 * см. discordLog.js), категория и цвет определяются по эмодзи в начале текста.
 * Best-effort, не мешает основной логике. Сигнатура не менялась — на ~20 местах
 * вызова ничего трогать не пришлось.
 */
async function logToChannel(text) {
  await discordLog.send('discord', text);
}

const tag = (uid) => `<@${uid}> (\`${uid}\`)`;

/** Логирует конкретный показанный пользователю текст расписания целиком. */
async function logSchedule(uid, action, data) {
  if (!data) return;
  let text;
  try {
    text = ss.scheduleText(data);
  } catch {
    text = '(не удалось сформировать текст расписания)';
  }
  await logToChannel(`📋 ${tag(uid)} — ${action}\n\`\`\`\n${text.slice(0, 1500)}\n\`\`\``);
}

/** Ставит группу и логирует «зарегистрировался» (не было группы) / «сменил группу» (была другая). */
async function applyGroupChange(uid, newGroupRaw) {
  const old = storage.get(uid).group;
  storage.setGroup(uid, newGroupRaw);
  const now = storage.get(uid).group;
  if (!old) await logToChannel(`🆕 ${tag(uid)} зарегистрировался — группа **${now}**`);
  else if (old !== now) await logToChannel(`🔄 ${tag(uid)} сменил группу: **${old}** → **${now}**`);
}

// -------------------------------------------------------------- вспомогательное

/** Что показывать пользователю: его группа или его пары как преподавателя. */
function subjOf(u) {
  if (u.role === 'teacher' && u.teacherName) return { kind: 'teacher', name: u.teacherName };
  if (u.group) return { kind: 'group', name: u.group };
  if (u.teacherName) return { kind: 'teacher', name: u.teacherName };
  return null;
}
const subjKey = (subj) =>
  subj.kind === 'teacher' ? `t:${ss.normName(subj.name)}` : `g:${ss.normGroup(subj.name)}`;

function buildDayData(csvText, subj, target, opts = {}) {
  return subj.kind === 'teacher'
    ? ss.buildTeacherData(csvText, subj.name, target)
    : ss.buildScheduleData(csvText, subj.name, target, opts);
}

// platformRawId — настоящий (непривязанный) Discord id ИМЕННО этого пользователя
// (interaction.user.id) — нужен только для format/weatherFormat: они свои у
// каждой площадки, даже если аккаунты связаны /связать (см. storage.js).
// Необязателен — если не передать, используется uid (без связывания это одно и то же).
function effState(uid, platformRawId = uid) {
  const s = storage.get(uid);
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
    format: storage.getPlatformFormat(platformRawId),
    reminderMinutes: s.reminderMinutes,
    morning: s.morning,
    morningTime: s.morningTime,
    morningGreeting: s.morningGreeting,
    pausedUntil: s.pausedUntil,
    theme: s.theme || 'default',
    away: s.away,
    homePlace: s.homePlace,
    homeStop: s.homeStop,
    homeLat: s.homeLat,
    homeLon: s.homeLon,
    weatherFormat: storage.getPlatformWeatherFormat(platformRawId),
  };
}

/** Активна ли пауза подписки прямо сейчас (pausedUntil строго в будущем). */
const isPaused = (pausedUntil) => Boolean(pausedUntil) && pausedUntil > D.iso(D.todayParts());

/** Прикрепляет личные заметки пользователя к строкам расписания (режим группы, конкретная дата). */
function attachNotes(data, uid, iso) {
  if (!data || (data.mode || 'group') !== 'group' || !Array.isArray(data.rows)) return data;
  const notes = storage.getNotesForDay(uid, iso);
  if (!notes || !Object.keys(notes).length) return data;
  return {
    ...data,
    rows: data.rows.map((r) => (r.pair != null && notes[r.pair] ? { ...r, note: notes[r.pair] } : r)),
  };
}

/** Меню + виджеты «ближайшая рассылка» и «следующая пара» (из кэша, без сети). */
function menuView(uid) {
  const s = effState(uid);
  const paused = isPaused(s.pausedUntil);
  const nb = s.subj && s.subscribed && !paused ? D.nextBroadcast(s.days, s.time) : null;
  let nextPair = null;
  if (s.subj) {
    try {
      const today = D.todayParts();
      const csv = ss.peekCachedDay(today);
      if (csv) nextPair = menu.nextPairLine(buildDayData(csv, s.subj, today, {}));
      if (!nextPair) {
        const csvT = ss.peekCachedDay(D.tomorrowParts());
        if (csvT) nextPair = menu.nextPairLine(buildDayData(csvT, s.subj, D.tomorrowParts(), {}));
      }
    } catch {
      /* ignore */
    }
  }
  return menu.buildMenu(s, {
    nextBroadcastEpoch: nb,
    nextPair,
    pausedUntil: paused ? s.pausedUntil : null,
    showBus: Boolean(s.away && s.homePlace),
  });
}

const notPublishedText = (t) =>
  `Расписание на ${ss.fmtDM(t)} (${ss.weekdayRu(t)}) ещё не опубликовано на сайте.`;

const DM_OK = '📬 Отправил тебе в личные сообщения.';
const DM_FAIL =
  '❌ Не смог написать тебе в ЛС. Открой личные сообщения боту (в настройках приватности сервера разреши сообщения от участников) и повтори команду.';

/**
 * Результат любой слэш-команды уходит пользователю в ЛС.
 * В самих ЛС с ботом — отвечаем на месте. На сервере — эфемерное «ок» + сообщение в ЛС.
 * Вызывать после (опционального) deferReply.
 */
async function deliver(interaction, payload) {
  if (!interaction.inGuild()) {
    if (interaction.deferred || interaction.replied) return void (await interaction.editReply(payload));
    return void (await interaction.reply(payload));
  }
  let failed = false;
  try {
    await interaction.user.send(payload);
  } catch (err) {
    failed = true;
    log('WARN', `ЛС ${interaction.user.id}: ${err.message || err}`);
  }
  const ack = { content: failed ? DM_FAIL : DM_OK };
  if (interaction.deferred || interaction.replied) await interaction.editReply(ack);
  else await interaction.reply({ ...ack, flags: MessageFlags.Ephemeral });
}

/** @returns {{ data: object|null, url: string|null, error: string|null }} */
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

/** Экран расписания: мгновенный update() + editReply() (без двойного клика). */
async function renderSchedule(interaction, uid, target) {
  await interaction.update({
    content: `⏳ Загружаю расписание на ${D.fmtDM(target)} (${D.weekdayRu(target)})…`,
    embeds: [],
    components: [],
  });
  const s = effState(uid, interaction.user.id);
  const { data, url, error } = await safeSchedule(s.subj, target, s.showGaps);
  const withNotes = data ? attachNotes(data, uid, D.iso(target)) : data;
  await interaction.editReply(menu.buildScheduleView(withNotes, D.iso(target), url, error, s.format, s.theme));
  await logSchedule(uid, `открыл расписание (кнопка) на ${D.fmtDM(target)} (${D.weekdayRu(target)})`, withNotes);
}

/** Снимок расписания отдельным сообщением. */
async function sendScheduleSnapshot(interaction, subj, target, showGaps, format, theme, uid) {
  await interaction.deferReply();
  const { data, url, error } = await safeSchedule(subj, target, showGaps);
  if (error) {
    await interaction.editReply({ content: error, embeds: [] });
    return;
  }
  const d = uid ? attachNotes(data, uid, D.iso(target)) : data;
  await interaction.editReply(menu.scheduleMessage(d, url, format, theme));
  await logSchedule(interaction.user.id, `запросил расписание отдельным сообщением на ${D.fmtDM(target)} (${D.weekdayRu(target)})`, d);
}

// -------- поиск / преподаватель (разовый просмотр с навигацией по датам) ------

const lookupState = new Map(); // uid -> { kind:'teacher'|'search', params, iso }

async function runLookup(kind, params, target) {
  const { csvText, humanUrl } = await ss.fetchDayCsv(target, 0);
  const data =
    kind === 'teacher'
      ? ss.buildTeacherData(csvText, params.surname, target)
      : ss.searchSchedule(csvText, params, target);
  return { data, humanUrl };
}

/** Показывает экран поиска/преподавателя. fresh:true — из слэш-команды (в ЛС), иначе из кнопки/модалки (update). */
async function showLookup(interaction, uid, kind, params, target, { fresh = false } = {}) {
  const toDM = fresh && interaction.inGuild();
  if (fresh) await interaction.deferReply(toDM ? { flags: MessageFlags.Ephemeral } : {});
  else await interaction.update({ content: '⏳ Ищу…', embeds: [], components: [] });
  const s = effState(uid, interaction.user.id);
  lookupState.set(uid, { kind, params, iso: D.iso(target) });
  let view;
  try {
    const { data, humanUrl } = await runLookup(kind, params, target);
    view = menu.buildLookupView(data, humanUrl, s.format, undefined, s.theme);
    const label = kind === 'teacher' ? `поиск преподавателя «${params.surname}»` : 'поиск по кабинету/преподавателю';
    await logSchedule(uid, `${label} на ${D.fmtDM(target)} (${D.weekdayRu(target)})`, data);
  } catch (err) {
    const msg = err instanceof ss.NotPublishedError ? notPublishedText(target) : 'Не удалось выполнить поиск, попробуй позже.';
    if (!(err instanceof ss.NotPublishedError)) log('WARN', `lookup ${kind}: ${err.message}`);
    view = menu.buildLookupView(null, null, s.format, msg, s.theme);
  }
  if (toDM) {
    let failed = false;
    try {
      await interaction.user.send(view);
    } catch (err) {
      failed = true;
      log('WARN', `ЛС ${uid}: ${err.message || err}`);
    }
    await interaction.editReply({ content: failed ? DM_FAIL : DM_OK });
  } else {
    await interaction.editReply(view);
  }
}

// uid -> список групп (для листания)
const groupCache = new Map();

// -------- расписание автобусов (кэш на пользователя, листание по датам) ------

const busCache = new Map(); // uid -> { at, place, homeStop, toHomeRows, toCityRows, toHomeUrl, toCityUrl }

async function loadBusData(uid, s, force = false) {
  const hit = busCache.get(uid);
  if (!force && hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;
  const opts = { stop: s.homeStop };
  const [toHomeRows, toCityRows] = await Promise.all([
    bus.toHome(s.homePlace, opts).catch((err) => {
      log('WARN', `автобус (домой, ${uid}): ${err.message}`);
      return [];
    }),
    bus.toCity(s.homePlace, opts).catch((err) => {
      log('WARN', `автобус (в город, ${uid}): ${err.message}`);
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
  busCache.set(uid, data);
  return data;
}

/** Расписание автобусов не зависит от даты (у перевозчика оно ежедневное) — листание дат просто
 * пересчитывает ближайший рейс/обратный отсчёт относительно другого дня, без повторной загрузки. */
async function renderBusView(interaction, uid, targetIso, force = false) {
  const s = effState(uid);
  try {
    const data = await loadBusData(uid, s, force);
    await interaction.editReply(menu.buildBusView(data.place, data.toHomeRows, data.toCityRows, data.toHomeUrl, data.toCityUrl, targetIso));
  } catch (err) {
    log('WARN', `автобус: ${err.message}`);
    await interaction.editReply({ content: 'Не удалось получить расписание автобусов, попробуй позже.', embeds: [], components: [] });
  }
}

async function onBusButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('bus:'.length);
  let target = null;
  if (rest === 'jump:today') target = D.todayParts();
  else if (rest === 'jump:tomorrow') target = D.tomorrowParts();
  else if (rest.startsWith('prev:') || rest.startsWith('next:')) {
    const b = D.partsFromIso(rest.slice(5));
    if (b) target = D.shiftParts(b, rest.startsWith('prev:') ? -1 : 1);
  }
  if (!target) return;
  await interaction.update({ content: '⏳ Обновляю…', embeds: [], components: [] });
  await renderBusView(interaction, uid, D.iso(target));
}

// -------------------------------------------------------------------- клиент

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

client.once(Events.ClientReady, async (c) => {
  log('INFO', `вошёл как ${c.user.tag} (id ${c.user.id})`);
  await registerCommands(c);
  startSchedulers();
  startPresence(c);
  await logToChannel(`🚀 Бот запущен — ${c.user.tag}`);
});

const ACT_TYPES = {
  playing: ActivityType.Playing,
  listening: ActivityType.Listening,
  watching: ActivityType.Watching,
  competing: ActivityType.Competing,
};

const P = ActivityType.Playing;
const W = ActivityType.Watching;
const L = ActivityType.Listening;
const PRESENCE_ROTATION = [
  { name: 'успеть на пару в 08:30', type: P },
  { name: 'угадай, будет ли первая пара', type: P },
  { name: 'где моя пара?', type: P },
  { name: 'koopteh10.ru', type: W },
  { name: 'сколько пар завтра', type: W },
  { name: 'за изменениями в расписании', type: W },
  { name: 'кто опоздал на первую пару', type: W },
  { name: 'звонок на пару', type: L },
  { name: 'вопросы студентов', type: L },
  { name: 'жалобы на 7-ю пару', type: L },
  { name: 'ваши баги и предложения', type: L },
  { name: 'гул перед парой', type: L },
];

function applyPresence(c) {
  try {
    if (cfg.activity) {
      c.user.setActivity(cfg.activity, { type: ACT_TYPES[cfg.activityType] ?? ActivityType.Watching });
      return;
    }
    const pick = PRESENCE_ROTATION[Math.floor(Math.random() * PRESENCE_ROTATION.length)];
    c.user.setActivity(pick.name, { type: pick.type });
  } catch (err) {
    log('WARN', `presence: ${err.message}`);
  }
}

function startPresence(c) {
  applyPresence(c);
  setInterval(() => applyPresence(c), 10 * 60 * 1000);
}

function commandDefs() {
  return [
    new SlashCommandBuilder().setName('start').setDescription('Меню расписания и настроек'),
    new SlashCommandBuilder()
      .setName('расписание')
      .setDescription('Расписание группы на дату')
      .addStringOption((o) => o.setName('группа').setDescription('Название группы').setAutocomplete(true))
      .addStringOption((o) => o.setName('дата').setDescription('дд.мм (по умолчанию сегодня)')),
    new SlashCommandBuilder()
      .setName('поиск')
      .setDescription('Кабинет, преподаватель, предмет, «что у группы сейчас», занятость на паре')
      .addStringOption((o) => o.setName('кабинет').setDescription('Номер кабинета').setAutocomplete(true))
      .addStringOption((o) => o.setName('преподаватель').setDescription('Фамилия').setAutocomplete(true))
      .addStringOption((o) => o.setName('предмет').setDescription('Название — найду ближайшую пару у твоей группы'))
      .addStringOption((o) => o.setName('группа').setDescription('Что у этой группы идёт прямо сейчас').setAutocomplete(true))
      .addIntegerOption((o) =>
        o.setName('пара').setDescription('1–7: свободен ли кабинет/преподаватель на этой паре').setMinValue(1).setMaxValue(7),
      )
      .addStringOption((o) => o.setName('дата').setDescription('дд.мм')),
    new SlashCommandBuilder()
      .setName('преподаватель')
      .setDescription('Пары преподавателя за день')
      .addStringOption((o) => o.setName('фамилия').setDescription('Фамилия').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('дата').setDescription('дд.мм')),
    new SlashCommandBuilder().setName('преподаватели').setDescription('Кто какие предметы ведёт'),
    new SlashCommandBuilder().setName('сейчас').setDescription('Текущая и следующая пара + до звонка'),
    new SlashCommandBuilder().setName('звонки').setDescription('Расписание звонков и текущий статус'),
    new SlashCommandBuilder().setName('помощь').setDescription('Что умеет бот: команды и кнопки'),
    new SlashCommandBuilder().setName('admin').setDescription('Панель администратора'),
  ];
}

function withContexts(b) {
  return b
    .setContexts([InteractionContextType.BotDM, InteractionContextType.PrivateChannel, InteractionContextType.Guild])
    .setIntegrationTypes([ApplicationIntegrationType.UserInstall, ApplicationIntegrationType.GuildInstall]);
}

async function registerCommands(c) {
  const guild = cfg.guildId || undefined;
  const ctx = (b) => (guild ? b : withContexts(b));
  const attempts = [
    ['все команды', () => commandDefs().map((b) => ctx(b).toJSON())],
    // запасной вариант: если кириллические имена отклонены — оставляем ASCII-команды
    ['ASCII-команды', () => commandDefs().filter((b) => /^[a-z-]+$/.test(b.name)).map((b) => ctx(b).toJSON())],
  ];
  for (const [label, build] of attempts) {
    try {
      await c.application.commands.set(build(), guild);
      log('INFO', `команды (${label}) зарегистрированы${guild ? ` на сервере ${guild}` : ' глобально'}`);
      return;
    } catch (err) {
      log('WARN', `регистрация "${label}" не удалась: ${err.message}`);
    }
  }
  log('ERROR', 'не удалось зарегистрировать ни один набор команд');
}

// -------------------------------------------------------------- роутинг

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await onAutocomplete(interaction);
    if (interaction.isChatInputCommand()) return await onSlash(interaction);
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('menu:')) return await onMenuButton(interaction);
      if (id.startsWith('grp:')) return await onGroupButton(interaction);
      if (id.startsWith('sch:')) return await onScheduleButton(interaction);
      if (id.startsWith('lk:')) return await onLookupButton(interaction);
      if (id.startsWith('wk:')) return await onWeekButton(interaction);
      if (id.startsWith('role:')) return await onRoleButton(interaction);
      if (id.startsWith('set:')) return await onSettingsButton(interaction);
      if (id.startsWith('pause:')) return await onPauseButton(interaction);
      if (id.startsWith('away:')) return await onAwayButton(interaction);
      if (id.startsWith('link:')) return await onLinkButton(interaction);
      if (id.startsWith('bus:')) return await onBusButton(interaction);
      if (id.startsWith('weather:')) return await onWeatherButton(interaction);
      if (id.startsWith('days:')) return await onDaysButton(interaction);
      if (id.startsWith('rem:')) return await onReminderButton(interaction);
      if (id.startsWith('mrn:')) return await onMorningButton(interaction);
      if (id.startsWith('ans:')) return await onAnswerButton(interaction);
      if (id.startsWith('adm:')) return await onAdminButton(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'grp:pick') return await onGroupSelect(interaction);
    if (interaction.isModalSubmit()) return await onModal(interaction);
  } catch (err) {
    log('ERROR', `interaction: ${err.stack || err}`);
    try {
      const payload = { content: 'Что-то пошло не так, попробуй ещё раз.' };
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {
      /* ignore */
    }
  }
});

const CHOICE = (v) => ({ name: v.slice(0, 100), value: v.slice(0, 100) });

async function onAutocomplete(interaction) {
  const f = interaction.options.getFocused(true); // { name, value }
  const q = String(f.value || '').toLowerCase().trim();
  let list = [];
  try {
    if (f.name === 'группа') list = await ss.listAllGroups();
    else if (f.name === 'преподаватель' || f.name === 'фамилия') list = await ss.listAllTeachers();
    else if (f.name === 'кабинет') list = await ss.listAllRooms();
  } catch {
    /* ignore */
  }
  const filtered = q ? list.filter((v) => v.toLowerCase().includes(q)) : list;
  await interaction.respond(filtered.slice(0, 25).map(CHOICE));
}

async function onSlash(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const name = interaction.commandName;
  const eph = interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {};

  if (name === 'start') return void (await deliver(interaction, menuView(uid)));

  if (name === 'admin') {
    if (!storage.isAdmin(uid)) return void (await interaction.reply({ content: 'Нет доступа.', ...eph }));
    return void (await deliver(interaction, menu.buildAdminMenu()));
  }

  if (name === 'звонки') return void (await deliver(interaction, menu.bellView()));

  if (name === 'помощь') return void (await deliver(interaction, menu.buildHelpView()));

  if (name === 'преподаватели') {
    await interaction.deferReply(eph);
    let list = [];
    try {
      list = await ss.listTeachersWithSubjects();
    } catch (err) {
      log('WARN', `преподаватели: ${err.message}`);
    }
    if (!list.length) {
      return void (await deliver(interaction, { content: 'Не удалось получить список преподавателей, попробуй позже.' }));
    }
    const text = list.map((x) => `• ${x.teacher} — ${x.subjects.join(', ')}`).join('\n');
    if (text.length <= 1900) {
      await deliver(interaction, { content: `👨‍🏫 **Преподаватели (${list.length})**\n${text}` });
    } else {
      await deliver(interaction, {
        content: `👨‍🏫 Преподаватели (${list.length}) — списком в файле:`,
        files: [{ attachment: Buffer.from(text, 'utf8'), name: 'prepodavateli.txt' }],
      });
    }
    return;
  }

  const s = effState(uid, interaction.user.id);

  if (name === 'сейчас') {
    if (!s.subj) return void (await interaction.reply({ content: 'Сначала укажи группу или фамилию через /start.', ...eph }));
    await interaction.deferReply(eph);
    const today = D.todayParts();
    let data = null;
    try {
      data = buildDayData((await ss.fetchDayCsv(today, 5 * 60 * 1000)).csvText, s.subj, today, {});
    } catch {
      /* нет данных */
    }
    await deliver(interaction, menu.buildNowMessage(data, s.subj.name));
    await logSchedule(uid, `/сейчас (${s.subj.name})`, data);
    return;
  }

  if (name === 'расписание') {
    const grpParam = (interaction.options.getString('группа') || '').trim();
    const subj = grpParam ? { kind: 'group', name: grpParam } : s.subj;
    if (!subj) {
      return void (await interaction.reply({ content: 'Укажи группу параметром или сохрани её через /start.', ...eph }));
    }
    const target = parseDateField(interaction.options.getString('дата'));
    if (!target) return void (await interaction.reply({ content: 'Не понял дату. Формат: дд.мм.', ...eph }));
    await interaction.deferReply(eph);
    const { data, url, error } = await safeSchedule(subj, target, s.showGaps);
    // заметки — только для «своей» группы (без параметра «группа»)
    const d = data && !grpParam ? attachNotes(data, uid, D.iso(target)) : data;
    await deliver(interaction, error ? { content: error, embeds: [] } : menu.scheduleMessage(d, url, s.format, s.theme));
    await logSchedule(uid, `/расписание ${subj.name} на ${D.fmtDM(target)} (${D.weekdayRu(target)})`, d);
    return;
  }

  if (name === 'поиск') {
    const room = (interaction.options.getString('кабинет') || '').trim();
    const teacher = (interaction.options.getString('преподаватель') || '').trim();
    const subject = (interaction.options.getString('предмет') || '').trim();
    const grpParam = (interaction.options.getString('группа') || '').trim();
    const pairNo = interaction.options.getInteger('пара');
    const target = parseDateField(interaction.options.getString('дата'));
    if (!target) return void (await interaction.reply({ content: 'Не понял дату. Формат: дд.мм.', ...eph }));

    // «Что у группы сейчас»
    if (grpParam && !room && !teacher && !subject && !pairNo) {
      await interaction.deferReply(eph);
      let data = null;
      try {
        data = ss.buildScheduleData((await ss.fetchDayCsv(D.todayParts(), 5 * 60 * 1000)).csvText, grpParam, D.todayParts(), {});
      } catch {
        /* нет данных */
      }
      await deliver(interaction, menu.buildNowMessage(data, grpParam));
      await logSchedule(uid, `/поиск группа:${grpParam} (что сейчас)`, data);
      return;
    }

    // «Когда ближайшая <предмет>»
    if (subject) {
      const g = grpParam || (s.subj && s.subj.kind === 'group' ? s.subj.name : null);
      if (!g) {
        return void (await interaction.reply({ content: 'Укажи группу параметром или сохрани её через /start.', ...eph }));
      }
      await interaction.deferReply(eph);
      const answer = await findNextSubject(g, subject, target);
      await deliver(interaction, { content: answer });
      await logToChannel(`📋 ${tag(uid)} — /поиск предмет:${subject} (группа ${g})\n\`\`\`\n${answer.slice(0, 1500)}\n\`\`\``);
      return;
    }

    // «Свободен ли кабинет/преподаватель на N паре»
    if (pairNo && (room || teacher)) {
      await interaction.deferReply(eph);
      const answer = await pairAvailability({ room, teacher }, pairNo, target);
      await deliver(interaction, { content: answer });
      await logToChannel(`📋 ${tag(uid)} — /поиск пара:${pairNo} ${room ? `кабинет:${room}` : `преподаватель:${teacher}`}\n\`\`\`\n${answer.slice(0, 1500)}\n\`\`\``);
      return;
    }

    if (!room && !teacher) {
      return void (await interaction.reply({ content: 'Укажи кабинет, преподавателя, предмет или группу.', ...eph }));
    }
    await showLookup(interaction, uid, 'search', { room, teacher }, target, { fresh: true });
    return;
  }

  if (name === 'преподаватель') {
    const surname = interaction.options.getString('фамилия').trim();
    const target = parseDateField(interaction.options.getString('дата'));
    if (!target) return void (await interaction.reply({ content: 'Не понял дату. Формат: дд.мм.', ...eph }));
    await showLookup(interaction, uid, 'teacher', { surname }, target, { fresh: true });
  }
}

/** «Когда ближайшая <предмет>» — сканирует до 10 дней от target для группы g. */
async function findNextSubject(g, subject, startTarget) {
  for (let i = 0; i < 10; i++) {
    const day = D.shiftParts(startTarget, i);
    let data;
    try {
      data = ss.buildScheduleData((await ss.fetchDayCsv(day, 5 * 60 * 1000)).csvText, g, day, {});
    } catch {
      continue;
    }
    if (!data || data.note) continue;
    const hit = data.rows.find((r) => r.kind === 'lesson' && ss.subjectMatches(r.subject, subject));
    if (hit) {
      const when = i === 0 ? 'сегодня' : i === 1 ? 'завтра' : `${D.fmtDM(day)} (${D.weekdayRu(day)})`;
      const where = hit.room ? `, ауд. ${hit.room}` : '';
      const who = hit.teacher ? `, ${hit.teacher}` : '';
      return `🔎 Ближайшая «${subject}» у ${g}: ${when}, ${hit.pair ? `${hit.pair}. ` : ''}${hit.start || ''}${where}${who}`;
    }
  }
  return `🔎 «${subject}» у группы ${g} не нашёл в ближайшие 10 дней.`;
}

/** «Свободен ли кабинет/преподаватель на N паре» на дату target. */
async function pairAvailability({ room, teacher }, pairNo, target) {
  let csvText;
  try {
    csvText = (await ss.fetchDayCsv(target, 5 * 60 * 1000)).csvText;
  } catch (err) {
    return err instanceof ss.NotPublishedError ? notPublishedText(target) : 'Не удалось получить расписание, попробуй позже.';
  }
  const when = `${D.fmtDM(target)} (${D.weekdayRu(target)}), пара ${pairNo}`;
  if (teacher) {
    const res = ss.searchSchedule(csvText, { teacher }, target);
    const row = res.rows.find((r) => r.pair === pairNo);
    return row
      ? `🔴 ${teacher} на ${when}: занят — ${row.subject}${row.room ? `, ауд. ${row.room}` : ''} (${row.groupsText})`
      : `🟢 ${teacher} на ${when}: свободен`;
  }
  const res = ss.freeRooms(csvText, target, pairNo);
  const norm = (r) => String(r).replace(/\s+/g, '').toLowerCase();
  const busy = res.busy.some((r) => norm(r) === norm(room));
  return busy ? `🔴 Кабинет ${room} на ${when}: занят` : `🟢 Кабинет ${room} на ${when}: свободен`;
}

async function onMenuButton(interaction) {
  const action = interaction.customId.slice('menu:'.length);
  const uid = storage.resolveUid(interaction.user.id);
  const s = effState(uid, interaction.user.id);

  switch (action) {
    case 'setgroup': {
      await interaction.update({ content: '⏳ Загружаю список групп…', embeds: [], components: [] });
      let view;
      try {
        const list = await ss.listAllGroups();
        groupCache.set(uid, list);
        view = list.length
          ? menu.buildGroupPicker(list, 0)
          : menu.buildGroupPicker([], 0, { error: 'Сайт не отдал список групп. Введи название вручную.' });
      } catch (err) {
        log('WARN', `список групп: ${err.message}`);
        view = menu.buildGroupPicker([], 0, { error: 'Не удалось загрузить список групп с сайта. Введи название вручную.' });
      }
      await interaction.editReply(view);
      return;
    }
    case 'schedule':
      if (!s.subj) return void (await interaction.reply({ content: 'Сначала укажи группу или фамилию (👤 Роль).' }));
      await renderSchedule(interaction, uid, D.todayParts());
      return;
    case 'week':
      if (!s.subj) return void (await interaction.reply({ content: 'Сначала укажи группу или фамилию.' }));
      await renderWeek(interaction, uid, D.mondayOf(D.todayParts()));
      return;
    case 'weather':
      await interaction.update({ content: '⏳ Гружу погоду…', embeds: [], components: [] });
      await renderWeatherView(interaction, uid, D.iso(D.todayParts()));
      return;
    case 'role':
      await interaction.update(menu.buildRoleView(s));
      return;
    case 'bell':
      await interaction.update(menu.bellView());
      return;
    case 'now':
      if (!s.subj) return void (await interaction.reply({ content: 'Сначала укажи группу или фамилию.' }));
      await sendScheduleSnapshot(interaction, s.subj, D.tomorrowParts(), s.showGaps, s.format, s.theme, uid);
      return;
    case 'togglesub':
      storage.setSubscribed(uid, !s.subscribed);
      await logToChannel(`🔔 ${tag(uid)} ${!s.subscribed ? 'включил' : 'выключил'} рассылку`);
      await interaction.update(menuView(uid));
      return;
    case 'time':
      await interaction.showModal(menu.timeModal(storage.get(uid).time));
      return;
    case 'days':
      await interaction.update(menu.buildDaysView(s.days));
      return;
    case 'reminder':
      await interaction.update(menu.buildReminderView(s.reminderMinutes));
      return;
    case 'morning':
      await interaction.update(menu.buildMorningView(s));
      return;
    case 'settings':
      await interaction.update(menu.buildSettingsView(s));
      return;
    case 'togglegaps':
      storage.setShowGaps(uid, !s.showGaps);
      await interaction.update(menuView(uid));
      return;
    case 'format':
      storage.setPlatformFormat(interaction.user.id, menu.nextFormat(s.format));
      await interaction.update(menuView(uid));
      return;
    case 'search':
      await interaction.showModal(menu.searchModal());
      return;
    case 'teacher':
      await interaction.showModal(menu.teacherModal());
      return;
    case 'rooms':
      await interaction.showModal(menu.roomsModal());
      return;
    case 'ask':
      await interaction.showModal(menu.askModal());
      return;
    case 'help':
      await interaction.update(menu.buildHelpView({ inMenu: true }));
      return;
    case 'bus': {
      if (!s.away || !s.homePlace) {
        return void (
          await interaction.reply({ content: 'Сначала укажи населённый пункт: ⚙️ Настройки → 🏘 Не из города.' })
        );
      }
      await interaction.update({ content: '⏳ Гружу расписание автобусов…', embeds: [], components: [] });
      await renderBusView(interaction, uid, D.iso(D.todayParts()), true);
      return;
    }
    case 'refresh':
      await interaction.update(menuView(uid));
      return;
    default:
  }
}

async function onGroupButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('grp:'.length);

  if (rest === 'cancel') return void (await interaction.update(menuView(uid)));
  if (rest === 'manual') return void (await interaction.showModal(menu.groupModal(storage.get(uid).group)));
  if (rest.startsWith('page:')) {
    const page = Number(rest.slice('page:'.length)) || 0;
    if (groupCache.has(uid)) return void (await interaction.update(menu.buildGroupPicker(groupCache.get(uid), page)));
    await interaction.update({ content: '⏳ Обновляю список групп…', embeds: [], components: [] });
    try {
      const list = await ss.listAllGroups();
      groupCache.set(uid, list);
      await interaction.editReply(menu.buildGroupPicker(list, page));
    } catch (err) {
      log('WARN', `список групп: ${err.message}`);
      await interaction.editReply(menu.buildGroupPicker([], 0, { error: 'Не удалось загрузить список групп.' }));
    }
  }
}

async function onGroupSelect(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  await applyGroupChange(uid, interaction.values[0]);
  log('INFO', `${uid} выбрал группу "${interaction.values[0]}"`);
  await interaction.update(menuView(uid));
}

async function onScheduleButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('sch:'.length);
  const s = effState(uid, interaction.user.id);

  if (rest === 'menu') return void (await interaction.update(menuView(uid)));

  if (rest.startsWith('report:')) {
    await interaction.showModal(menu.reportModal(rest.slice('report:'.length)));
    return;
  }
  if (rest.startsWith('note:')) {
    await interaction.showModal(menu.noteModal(rest.slice('note:'.length)));
    return;
  }
  if (rest.startsWith('send:')) {
    const t = D.partsFromIso(rest.slice('send:'.length));
    if (!t || !s.subj) return;
    await sendScheduleSnapshot(interaction, s.subj, t, s.showGaps, s.format, s.theme, uid);
    return;
  }
  if (rest.startsWith('share:')) {
    const t = D.partsFromIso(rest.slice('share:'.length));
    if (!t || !s.subj) return;
    await interaction.deferReply();
    const { csvText, humanUrl } = await ss.fetchDayCsv(t, 5 * 60 * 1000).catch(() => ({}));
    if (!csvText) return void (await interaction.editReply({ content: notPublishedText(t) }));
    try {
      const data = buildDayData(csvText, s.subj, t, {});
      const txt = ss.scheduleText(data) + (humanUrl ? `\n\n🔗 ${humanUrl}` : '');
      await interaction.editReply({ content: txt.slice(0, 1990) });
    } catch {
      await interaction.editReply({ content: 'Не удалось собрать текст.' });
    }
    return;
  }
  if (rest.startsWith('img:')) {
    const t = D.partsFromIso(rest.slice('img:'.length));
    if (!t || !s.subj) return;
    await interaction.deferReply();
    const { csvText } = await ss.fetchDayCsv(t, 5 * 60 * 1000).catch(() => ({}));
    if (!csvText) return void (await interaction.editReply({ content: notPublishedText(t) }));
    try {
      const data = buildDayData(csvText, s.subj, t, {});
      const buf = render.renderScheduleImage(data);
      if (buf) await interaction.editReply({ files: [{ attachment: buf, name: `raspisanie-${rest.slice('img:'.length)}.png` }] });
      else await interaction.editReply({ content: ss.scheduleText(data).slice(0, 1990) });
    } catch (err) {
      log('WARN', `картинка: ${err.message}`);
      await interaction.editReply({ content: 'Не удалось сделать картинку.' });
    }
    return;
  }

  let target = null;
  if (rest === 'jump:today') target = D.todayParts();
  else if (rest === 'jump:tomorrow') target = D.tomorrowParts();
  else if (rest.startsWith('prev:') || rest.startsWith('next:')) {
    const b = D.partsFromIso(rest.slice(5));
    if (b) target = D.shiftParts(b, rest.startsWith('prev:') ? -1 : 1);
  }
  if (!target) return;
  if (!s.subj) return void (await interaction.reply({ content: 'Сначала укажи группу или фамилию в меню (/start).' }));
  await renderSchedule(interaction, uid, target);
}

async function onLookupButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('lk:'.length);
  if (rest === 'menu') return void (await interaction.update(menuView(uid)));

  const st = lookupState.get(uid);
  if (!st) {
    await interaction.update({ content: 'Поиск устарел — открой его заново из меню.', embeds: [], components: [] });
    return;
  }

  if (rest === 'pin') {
    if (st.kind !== 'teacher' || !st.params.surname) return;
    const hadTeacherName = storage.get(uid).teacherName;
    storage.setTeacherName(uid, st.params.surname);
    storage.setRole(uid, 'teacher');
    if (!storage.get(uid).subscribed) storage.setSubscribed(uid, true);
    log('INFO', `${uid} закрепил режим преподавателя: ${st.params.surname}`);
    await logToChannel(
      hadTeacherName
        ? `🔄 ${tag(uid)} сменил фамилию преподавателя: **${hadTeacherName}** → **${st.params.surname}** (закреплено через поиск)`
        : `🆕 ${tag(uid)} зарегистрировался — преподаватель **${st.params.surname}** (закреплено через поиск)`,
    );
    await interaction.update(menuView(uid));
    return;
  }

  let target;
  if (rest === 'day:today') target = D.todayParts();
  else if (rest === 'day:tomorrow') target = D.tomorrowParts();
  else if (rest === 'prev' || rest === 'next') {
    const b = D.partsFromIso(st.iso) || D.todayParts();
    target = D.shiftParts(b, rest === 'prev' ? -1 : 1);
  } else return;
  await showLookup(interaction, uid, st.kind, st.params, target);
}

async function onRoleButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('role:'.length);
  if (rest === 'done') return void (await interaction.update(menuView(uid)));
  if (rest === 'setname') {
    await interaction.showModal(menu.setTeacherModal(storage.get(uid).teacherName));
    return;
  }
  if (rest === 'student' || rest === 'teacher') {
    const st = storage.get(uid);
    if (rest === 'teacher' && !st.teacherName) {
      return void (await interaction.reply({ content: 'Сначала укажи фамилию (✏️).' }));
    }
    if (rest === 'student' && !st.group) {
      return void (await interaction.reply({ content: 'Сначала укажи группу.' }));
    }
    storage.setRole(uid, rest);
    await logToChannel(`👤 ${tag(uid)} сменил роль на **${rest === 'teacher' ? 'преподаватель' : 'студент'}**`);
    await interaction.update(menu.buildRoleView(effState(uid)));
  }
}

async function onPauseButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('pause:'.length);

  if (rest === 'back') return void (await interaction.update(menu.buildSettingsView(effState(uid))));
  if (rest === 'date') return void (await interaction.showModal(menu.pauseDateModal()));
  if (rest === 'off') {
    storage.setPausedUntil(uid, null);
    log('INFO', `${uid} снял паузу`);
    return void (await interaction.update(menu.buildPauseView(effState(uid))));
  }
  if (rest.startsWith('days:')) {
    const n = Number(rest.slice('days:'.length));
    if (!(n >= 1 && n <= 180)) return;
    const until = D.iso(D.shiftParts(D.todayParts(), n));
    storage.setPausedUntil(uid, until);
    log('INFO', `${uid} поставил паузу до ${until}`);
    return void (await interaction.update(menu.buildPauseView(effState(uid))));
  }
}

async function onAwayButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('away:'.length);

  if (rest === 'back') return void (await interaction.update(menu.buildSettingsView(effState(uid))));
  if (rest === 'toggle') {
    const s = effState(uid);
    if (!s.away && !s.homePlace) {
      return void (await interaction.reply({ content: 'Сначала укажи населённый пункт (кнопка «🏘 Населённый пункт»).' }));
    }
    storage.setAway(uid, !s.away);
    return void (await interaction.update(menu.buildAwayView(effState(uid))));
  }
  if (rest === 'place') return void (await interaction.showModal(menu.awayPlaceModal(effState(uid).homePlace)));
  if (rest === 'stop') return void (await interaction.showModal(menu.awayStopModal(effState(uid).homeStop)));
}

async function onDaysButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('days:'.length);
  if (rest === 'done') return void (await interaction.update(menu.buildSettingsView(effState(uid))));
  if (rest.startsWith('toggle:')) {
    const isoDay = Number(rest.slice('toggle:'.length));
    if (!(isoDay >= 1 && isoDay <= 7)) return;
    const cur = new Set(effState(uid).days);
    cur.has(isoDay) ? cur.delete(isoDay) : cur.add(isoDay);
    const next = [...cur].sort((a, b) => a - b);
    storage.setDays(uid, next);
    await interaction.update(menu.buildDaysView(next));
  }
}

async function onReminderButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('rem:'.length);
  if (rest === 'done') return void (await interaction.update(menu.buildSettingsView(effState(uid))));
  if (rest.startsWith('set:')) {
    const n = Number(rest.slice('set:'.length));
    if (!menu.REMINDER_OPTS.includes(n)) return;
    storage.setReminder(uid, n);
    await interaction.update(menu.buildReminderView(n));
  }
}

async function onMorningButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('mrn:'.length);
  if (rest === 'done') return void (await interaction.update(menu.buildSettingsView(effState(uid))));
  if (rest === 'time') return void (await interaction.showModal(menu.morningTimeModal(effState(uid).morningTime)));
  if (rest === 'greeting') {
    return void (await interaction.showModal(menu.morningGreetingModal(effState(uid).morningGreeting)));
  }
  if (rest === 'toggle') {
    storage.setMorning(uid, !effState(uid).morning);
    await interaction.update(menu.buildMorningView(effState(uid)));
  }
}

async function onSettingsButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('set:'.length);
  const s = effState(uid, interaction.user.id);
  const back = () => interaction.update(menu.buildSettingsView(effState(uid, interaction.user.id)));

  switch (rest) {
    case 'back':
      return void (await interaction.update(menuView(uid)));
    case 'group': {
      await interaction.update({ content: '⏳ Загружаю список групп…', embeds: [], components: [] });
      let view;
      try {
        const list = await ss.listAllGroups();
        groupCache.set(uid, list);
        view = list.length
          ? menu.buildGroupPicker(list, 0)
          : menu.buildGroupPicker([], 0, { error: 'Сайт не отдал список групп. Введи название вручную.' });
      } catch (err) {
        log('WARN', `список групп: ${err.message}`);
        view = menu.buildGroupPicker([], 0, { error: 'Не удалось загрузить список групп с сайта. Введи название вручную.' });
      }
      return void (await interaction.editReply(view));
    }
    case 'role':
      return void (await interaction.update(menu.buildRoleView(s)));
    case 'pause':
      return void (await interaction.update(menu.buildPauseView(s)));
    case 'away':
      return void (await interaction.update(menu.buildAwayView(s)));
    case 'link':
      return void (await interaction.update(menu.buildLinkView(storage.linkedIds(uid))));
    case 'wthrformat':
      storage.setPlatformWeatherFormat(interaction.user.id, menu.nextFormat(s.weatherFormat));
      return void (await back());
    case 'togglesub':
      storage.setSubscribed(uid, !s.subscribed);
      await logToChannel(`🔔 ${tag(uid)} ${!s.subscribed ? 'включил' : 'выключил'} рассылку`);
      return void (await back());
    case 'togglegaps':
      storage.setShowGaps(uid, !s.showGaps);
      return void (await back());
    case 'format':
      storage.setPlatformFormat(interaction.user.id, menu.nextFormat(s.format));
      return void (await back());
    case 'theme':
      storage.setTheme(uid, menu.nextTheme(s.theme));
      return void (await back());
    case 'time':
      return void (await interaction.showModal(menu.timeModal(storage.get(uid).time)));
    case 'days':
      return void (await interaction.update(menu.buildDaysView(s.days)));
    case 'reminder':
      return void (await interaction.update(menu.buildReminderView(s.reminderMinutes)));
    case 'morning':
      return void (await interaction.update(menu.buildMorningView(s)));
    default:
  }
}

async function onLinkButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('link:'.length);

  if (rest === 'code') {
    const code = storage.createLinkCode(uid);
    return void (await interaction.update(menu.buildLinkView(storage.linkedIds(uid), { code })));
  }
  if (rest === 'enter') {
    return void (await interaction.showModal(menu.linkCodeModal()));
  }
  if (rest.startsWith('unlink:')) {
    const targetId = rest.slice('unlink:'.length);
    storage.unlinkId(interaction.user.id, targetId);
    const freshUid = storage.resolveUid(interaction.user.id);
    return void (await interaction.update(menu.buildLinkView(storage.linkedIds(freshUid))));
  }
}

async function onAnswerButton(interaction) {
  const qid = interaction.customId.slice('ans:'.length);
  if (!storage.isAdmin(storage.resolveUid(interaction.user.id))) return void (await interaction.reply({ content: 'Эта кнопка не для тебя.' }));
  const q = storage.getQuestion(qid);
  if (!q) {
    interaction.message?.unpin?.().catch(() => {});
    return void (await interaction.reply({ content: 'Вопрос не найден или на него уже ответили.' }));
  }
  await interaction.showModal(menu.answerModal(qid, q.topic));
}

// -------- обзор недели --------

const weekState = new Map(); // uid -> mondayIso

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

async function renderWeek(interaction, uid, mondayParts) {
  await interaction.update({ content: '⏳ Загружаю неделю…', embeds: [], components: [] });
  const s = effState(uid, interaction.user.id);
  const days = await loadWeekDays(s.subj, mondayParts);
  weekState.set(uid, D.iso(mondayParts));
  await interaction.editReply(menu.buildWeekView({ days }, s.format));
  const weekText = days
    .map((d) => {
      if (d.error) return `${D.fmtDM(d.parts)}: ${d.error}`;
      try {
        return `${D.fmtDM(d.parts)}:\n${ss.scheduleText(d.data)}`;
      } catch {
        return `${D.fmtDM(d.parts)}: (ошибка текста)`;
      }
    })
    .join('\n\n');
  await logToChannel(`📋 ${tag(uid)} — открыл неделю с ${D.fmtDM(mondayParts)}\n\`\`\`\n${weekText.slice(0, 1400)}\n\`\`\``);
}

async function onWeekButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('wk:'.length);
  if (rest === 'menu') return void (await interaction.update(menuView(uid)));

  if (rest === 'img') {
    const s = effState(uid);
    if (!s.subj) return void (await interaction.reply({ content: 'Сначала укажи группу или фамилию.' }));
    await interaction.deferReply();
    const monday = D.partsFromIso(weekState.get(uid) || '') || D.mondayOf(D.todayParts());
    const days = await loadWeekDays(s.subj, monday);
    const buf = render.available() ? render.renderWeekImage({ days }) : null;
    if (buf) await interaction.editReply({ files: [{ attachment: buf, name: 'nedelya.png' }] });
    else await interaction.editReply({ content: menu.buildWeekView({ days }, 'text').content.slice(0, 1990) });
    return;
  }

  const cur = D.partsFromIso(weekState.get(uid) || '') || D.mondayOf(D.todayParts());
  let monday;
  if (rest === 'this') monday = D.mondayOf(D.todayParts());
  else if (rest === 'prev') monday = D.shiftParts(cur, -7);
  else if (rest === 'next') monday = D.shiftParts(cur, 7);
  else return;
  await renderWeek(interaction, uid, monday);
}

// -------- погода с листанием дат --------

async function renderWeatherView(interaction, uid, targetIso) {
  const s = effState(uid, interaction.user.id);
  try {
    const cityForecast = await weather.dayForecast(cfg.weatherLat, cfg.weatherLon, targetIso);
    let homeInfo = null;
    if (s.away && s.homePlace && s.homeLat != null && s.homeLon != null) {
      const homeForecast = await weather.dayForecast(s.homeLat, s.homeLon, targetIso);
      homeInfo = { place: s.homePlace, forecast: homeForecast };
    }
    const t = D.partsFromIso(targetIso) || D.todayParts();
    const dateLabel = `${D.fmtDM(t)} (${D.weekdayRu(t)})`;
    const cityInfo = { place: cfg.weatherPlace, forecast: cityForecast };
    await interaction.editReply(menu.buildWeatherPanel(homeInfo, cityInfo, s.weatherFormat, targetIso, dateLabel));
  } catch (err) {
    log('WARN', `погода (панель, ${uid}): ${err.message}`);
    await interaction.editReply({ content: 'Не удалось получить погоду, попробуй позже.', embeds: [], components: [] });
  }
}

async function onWeatherButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const rest = interaction.customId.slice('weather:'.length);
  let target = null;
  if (rest === 'jump:today') target = D.todayParts();
  else if (rest === 'jump:tomorrow') target = D.tomorrowParts();
  else if (rest.startsWith('prev:') || rest.startsWith('next:')) {
    const b = D.partsFromIso(rest.slice(5));
    if (b) target = D.shiftParts(b, rest.startsWith('prev:') ? -1 : 1);
  }
  if (!target) return;
  const todayIso = D.iso(D.todayParts());
  const horizonIso = D.iso(D.shiftParts(D.todayParts(), weather.FORECAST_DAYS - 1));
  if (D.iso(target) < todayIso) target = D.todayParts();
  else if (D.iso(target) > horizonIso) target = D.partsFromIso(horizonIso);
  await interaction.update({ content: '⏳ Обновляю…', embeds: [], components: [] });
  await renderWeatherView(interaction, uid, D.iso(target));
}

// -------- админ-панель --------

async function onAdminButton(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  if (!storage.isAdmin(uid)) return void (await interaction.reply({ content: 'Нет доступа.' }));
  const rest = interaction.customId.slice('adm:'.length);

  if (rest === 'menu') return void (await interaction.update(menu.buildAdminMenu()));
  if (rest === 'stats') return void (await interaction.update(menu.buildStatsView(storage.stats())));
  if (rest === 'health') return void (await interaction.update(menu.buildHealthView(ss.health())));
  if (rest === 'log') return void (await interaction.update(menu.buildAdminLogView(storage.getAdminLog(15))));
  if (rest === 'schann') {
    return void (await interaction.update(menu.buildSchedAnnView(storage.listScheduledAnnounces())));
  }
  if (rest === 'schann:add') return void (await interaction.showModal(menu.schedAnnModal()));
  if (rest.startsWith('schann:del:')) {
    const sid = rest.slice('schann:del:'.length);
    if (storage.removeScheduledAnnounce(sid)) {
      storage.addAdminLog(uid, `удалил отложенное объявление ${sid}`);
      await logToChannel(`🛠 ${tag(uid)} удалил отложенное объявление \`${sid}\``);
    }
    return void (await interaction.update(menu.buildSchedAnnView(storage.listScheduledAnnounces())));
  }
  if (rest === 'admins') return void (await interaction.update(menu.buildAdminsView(storage.getAdmins(), uid)));
  if (rest === 'announce') return void (await interaction.showModal(menu.announceModal()));
  if (rest === 'addadmin') return void (await interaction.showModal(menu.addAdminModal()));
  if (rest.startsWith('del:')) {
    const id = rest.slice('del:'.length);
    if (!storage.removeAdmin(id)) {
      await interaction.reply({ content: 'Нельзя удалить (последний админ или не найден).' });
      return;
    }
    log('INFO', `${uid} удалил админа ${id}`);
    storage.addAdminLog(uid, `удалил админа …${String(id).slice(-4)}`);
    await logToChannel(`🛠 ${tag(uid)} удалил админа ${tag(id)}`);
    await interaction.update(menu.buildAdminsView(storage.getAdmins(), uid));
  }
}

async function sendMenu(interaction, uid) {
  const view = menuView(uid);
  if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
  else await interaction.reply(view);
}

/** дд.мм[.гггг] | пусто -> {y,mo,d}. Пусто -> сегодня. Некорректно -> null. */
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
  return ord(cand) < ord(now) - 40
    ? D.partsFromIso(`${now.y + 1}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`)
    : cand;
}

async function onModal(interaction) {
  const uid = storage.resolveUid(interaction.user.id);
  const id = interaction.customId;

  if (id === 'modal:setgroup') {
    const group = interaction.fields.getTextInputValue('group').trim();
    if (!group) return void (await interaction.reply({ content: 'Пустое название группы.' }));
    await applyGroupChange(uid, group);
    log('INFO', `${uid} ввёл группу "${group}"`);
    return void (await sendMenu(interaction, uid));
  }

  if (id === 'modal:setteacher') {
    const surname = interaction.fields.getTextInputValue('surname').trim();
    const hadTeacherName = storage.get(uid).teacherName;
    storage.setTeacherName(uid, surname || null);
    if (surname) storage.setRole(uid, 'teacher');
    else if (storage.get(uid).role === 'teacher') storage.setRole(uid, 'student');
    log('INFO', `${uid} режим преподавателя: "${surname || '—'}"`);
    if (surname && !hadTeacherName) await logToChannel(`🆕 ${tag(uid)} зарегистрировался — преподаватель **${surname}**`);
    else if (surname && hadTeacherName !== surname) await logToChannel(`🔄 ${tag(uid)} сменил фамилию преподавателя: **${hadTeacherName}** → **${surname}**`);
    const view = menu.buildRoleView(effState(uid));
    if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
    else await interaction.reply(view);
    return;
  }

  if (id === 'modal:time') {
    const raw = interaction.fields.getTextInputValue('time').trim();
    if (raw) {
      const hhmm = D.parseHHMM(raw);
      if (!hhmm) return void (await interaction.reply({ content: 'Неверный формат. Нужно ЧЧ:ММ, например 18:30.' }));
      storage.setTime(uid, hhmm);
    } else {
      storage.setTime(uid, null);
    }
    const view = menu.buildSettingsView(effState(uid));
    if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
    else await interaction.reply(view);
    return;
  }

  if (id === 'modal:link') {
    const code = interaction.fields.getTextInputValue('code').trim();
    const r = storage.redeemLinkCode(code, interaction.user.id);
    const view = menu.buildLinkView(storage.linkedIds(storage.resolveUid(interaction.user.id)), r.ok ? {} : { error: r.error });
    if (r.ok) view.content = '✅ Связано! Теперь это один профиль.';
    if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
    else await interaction.reply(view);
    return;
  }

  if (id === 'modal:ask') {
    const topic = interaction.fields.getTextInputValue('topic').trim() || 'Без темы';
    const question = interaction.fields.getTextInputValue('question').trim();
    if (!question) return void (await interaction.reply({ content: 'Пустой вопрос.' }));
    await relayToAdmin(interaction, uid, topic, question);
    return;
  }

  if (id.startsWith('modal:note:')) {
    const iso = id.slice('modal:note:'.length);
    const pair = Number(interaction.fields.getTextInputValue('pair').trim());
    if (!(pair >= 1 && pair <= 7)) return void (await interaction.reply({ content: 'Номер пары — число от 1 до 7.' }));
    const text = interaction.fields.getTextInputValue('text').trim();
    storage.setNote(uid, iso, pair, text || null);
    log('INFO', `${uid} заметка ${iso}|${pair}: ${text ? 'сохранил' : 'убрал'}`);
    const t = D.partsFromIso(iso);
    if (t && interaction.isFromMessage && interaction.isFromMessage()) {
      await renderSchedule(interaction, uid, t);
    } else {
      await interaction.reply({
        content: text ? `📝 Заметка к ${pair}-й паре${t ? ` на ${D.fmtDM(t)}` : ''} сохранена.` : '📝 Заметка удалена.',
      });
    }
    return;
  }

  if (id.startsWith('modal:report:')) {
    const iso = id.slice('modal:report:'.length);
    const text = interaction.fields.getTextInputValue('text').trim();
    if (!text) return void (await interaction.reply({ content: 'Пустое сообщение.' }));
    const t = D.partsFromIso(iso);
    const s = effState(uid);
    const who = s.subj
      ? s.subj.kind === 'teacher'
        ? `преп. ${s.subj.name}`
        : `группа ${s.subj.name}`
      : '—';
    await relayToAdmin(interaction, uid, `Ошибка в расписании: ${t ? D.fmtDM(t) : iso}, ${who}`, text);
    return;
  }

  if (id.startsWith('modal:answer:')) {
    const qid = id.slice('modal:answer:'.length);
    const q = storage.getQuestion(qid);
    if (!q) return void (await interaction.reply({ content: 'Вопрос не найден или на него уже ответили.' }));
    const answer = interaction.fields.getTextInputValue('answer').trim();
    if (!answer) return void (await interaction.reply({ content: 'Пустой ответ.' }));
    // askerTag теперь всегда "сырой" маршрутизируемый адрес (см. relayToAdmin):
    // голый Discord id, или tg:<chatId>, или vk:<peerId> — определяет, куда
    // реально доставлять ответ, независимо от того, откуда админ нажал «Ответить»
    // (личка или один из каналов «Вопросы»).
    const addr = String(q.askerTag || q.askerId);
    try {
      if (addr.startsWith('tg:') || addr.startsWith('vk:')) {
        const platform = addr.startsWith('tg:') ? 'telegram' : 'vk';
        const rawAddr = addr.slice(3);
        const plainText = `💬 Ответ на твой вопрос: ${q.topic}\n\n${q.question}\n\nОтвет: ${answer}`;
        const ok = await bridge.deliver(platform, rawAddr, plainText);
        if (!ok) throw new Error(`площадка ${platform} сейчас недоступна или отправка не удалась`);
      } else {
        const asker = await client.users.fetch(addr);
        await asker.send(menu.answerMessage(q, answer));
      }
      storage.deleteQuestion(qid);
      log('INFO', `ответ на вопрос ${qid} доставлен ${addr}`);
      await interaction.reply({ content: '✅ Ответ отправлен пользователю.' });
      try {
        if (interaction.isFromMessage && interaction.isFromMessage() && interaction.message) {
          interaction.message.edit({ components: [] }).catch(() => {});
          interaction.message.unpin().catch(() => {});
        }
      } catch {
        /* ignore */
      }
    } catch (err) {
      if (err && err.code === 50007) {
        await interaction.reply({ content: 'У пользователя закрыты ЛС — ответ не доставлен. Вопрос остаётся открытым.' });
      } else {
        log('ERROR', `не доставить ответ на ${qid}: ${err.message}`);
        await interaction.reply({ content: 'Не удалось отправить ответ. Попробуй ещё раз.' });
      }
    }
    return;
  }

  if (id === 'modal:pausedate') {
    const target = parseDateField(interaction.fields.getTextInputValue('date'));
    const todayIso = D.iso(D.todayParts());
    if (!target || D.iso(target) <= todayIso) {
      return void (await interaction.reply({ content: 'Нужна будущая дата в формате дд.мм (например 20.09).' }));
    }
    const until = D.iso(target);
    storage.setPausedUntil(uid, until);
    log('INFO', `${uid} поставил паузу до ${until}`);
    const view = menu.buildPauseView(effState(uid));
    if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
    else await interaction.reply(view);
    return;
  }

  if (id === 'modal:awayplace') {
    const place = interaction.fields.getTextInputValue('place').trim();
    busCache.delete(uid);
    if (!place) {
      storage.setHomePlace(uid, null, null, null);
      storage.setAway(uid, false);
      const view = menu.buildAwayView(effState(uid));
      if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
      else await interaction.reply(view);
      return;
    }
    const fromMessage = interaction.isFromMessage && interaction.isFromMessage();
    if (fromMessage) await interaction.update({ content: '⏳ Ищу населённый пункт…', embeds: [], components: [] });
    else await interaction.deferReply();
    let geo = null;
    try {
      geo = await weather.geocode(place);
    } catch (err) {
      log('WARN', `геокодинг "${place}": ${err.message}`);
    }
    if (!geo) {
      await interaction.editReply({ content: `Не нашёл «${place}» на карте. Проверь написание и попробуй ещё раз.` });
      return;
    }
    storage.setHomePlace(uid, place, geo.lat, geo.lon);
    log('INFO', `${uid} задал населённый пункт «${place}» (${geo.lat}, ${geo.lon})`);
    await interaction.editReply(menu.buildAwayView(effState(uid)));
    return;
  }

  if (id === 'modal:awaystop') {
    const stop = interaction.fields.getTextInputValue('stop').trim();
    storage.setHomeStop(uid, stop || null);
    busCache.delete(uid);
    log('INFO', `${uid} остановка: ${stop || 'снял'}`);
    const view = menu.buildAwayView(effState(uid));
    if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
    else await interaction.reply(view);
    return;
  }

  if (id === 'modal:morningtime') {
    const hhmm = D.parseHHMM(interaction.fields.getTextInputValue('time'));
    if (!hhmm) return void (await interaction.reply({ content: 'Неверный формат. Нужно ЧЧ:ММ, например 07:30.' }));
    storage.setMorningTime(uid, hhmm);
    const view = menu.buildMorningView(effState(uid));
    if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
    else await interaction.reply(view);
    return;
  }

  if (id === 'modal:morninggreeting') {
    const text = interaction.fields.getTextInputValue('text').trim();
    storage.setMorningGreeting(uid, text || null);
    const view = menu.buildMorningView(effState(uid));
    if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
    else await interaction.reply(view);
    return;
  }

  if (id === 'modal:rooms') {
    const pair = Number(interaction.fields.getTextInputValue('pair').trim());
    if (!(pair >= 1 && pair <= 7)) {
      return void (await interaction.reply({ content: 'Номер пары — число от 1 до 7.' }));
    }
    const target = parseDateField(interaction.fields.getTextInputValue('date'));
    if (!target) return void (await interaction.reply({ content: 'Не понял дату. Формат: дд.мм.' }));
    await interaction.update({ content: '⏳ Считаю кабинеты…', embeds: [], components: [] });
    try {
      const { csvText } = await ss.fetchDayCsv(target, 5 * 60 * 1000);
      const result = ss.freeRooms(csvText, target, pair);
      await interaction.editReply(menu.buildRoomsView(result, target));
    } catch (err) {
      const msg = err instanceof ss.NotPublishedError ? notPublishedText(target) : 'Не удалось получить данные, попробуй позже.';
      if (!(err instanceof ss.NotPublishedError)) log('WARN', `кабинеты: ${err.message}`);
      await interaction.editReply({ content: msg, embeds: [], components: [] });
    }
    return;
  }

  if (id === 'modal:search' || id === 'modal:teacher') {
    const target = parseDateField(interaction.fields.getTextInputValue('date'));
    if (!target) return void (await interaction.reply({ content: 'Не понял дату. Формат: дд.мм.' }));
    if (id === 'modal:teacher') {
      const surname = interaction.fields.getTextInputValue('surname').trim();
      if (!surname) return void (await interaction.reply({ content: 'Укажи фамилию.' }));
      await showLookup(interaction, uid, 'teacher', { surname }, target);
    } else {
      const room = interaction.fields.getTextInputValue('room').trim();
      const teacher = interaction.fields.getTextInputValue('teacher').trim();
      if (!room && !teacher) return void (await interaction.reply({ content: 'Заполни кабинет или фамилию.' }));
      await showLookup(interaction, uid, 'search', { room, teacher }, target);
    }
    return;
  }

  if (id === 'modal:announce') {
    if (!storage.isAdmin(uid)) return void (await interaction.reply({ content: 'Нет доступа.' }));
    const text = interaction.fields.getTextInputValue('text').trim();
    if (!text) return void (await interaction.reply({ content: 'Пустой текст.' }));
    const group = interaction.fields.getTextInputValue('group').trim();
    await interaction.reply({ content: `Рассылаю объявление${group ? ` группе ${group}` : ' всем подписчикам'}…` });
    const { ok, fail, total } = await broadcastAnnouncement(text, group);
    log('INFO', `объявление от ${uid}${group ? ` (${group})` : ''}: доставлено ${ok}/${total}`);
    storage.addAdminLog(uid, `объявление ${group ? `группе ${group}` : 'всем'} (${ok}/${total})`);
    await logToChannel(
      `📢 ${tag(uid)} разослал объявление${group ? ` группе **${group}**` : ' всем подписчикам'} (доставлено ${ok}/${total})\n\`\`\`\n${text.slice(0, 1200)}\n\`\`\``,
    );
    try {
      await interaction.followUp({ content: `Готово: доставлено ${ok} из ${total}, не доставлено ${fail}.` });
    } catch {
      /* ignore */
    }
    return;
  }

  if (id === 'modal:schann') {
    if (!storage.isAdmin(uid)) return void (await interaction.reply({ content: 'Нет доступа.' }));
    const text = interaction.fields.getTextInputValue('text').trim();
    const whenRaw = interaction.fields.getTextInputValue('when').trim();
    const group = interaction.fields.getTextInputValue('group').trim();
    if (!text) return void (await interaction.reply({ content: 'Пустой текст.' }));
    const m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})$/.exec(whenRaw);
    if (!m) return void (await interaction.reply({ content: 'Когда: «дд.мм ЧЧ:ММ», например 12.09 08:00.' }));
    const dd = +m[1];
    const mm = +m[2];
    const hh = +m[4];
    const mi = +m[5];
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59) {
      return void (await interaction.reply({ content: 'Неверная дата или время.' }));
    }
    const nowY = D.todayParts().y;
    let atParts = D.partsFromIso(`${m[3] ? +m[3] : nowY}-${D.pad(mm)}-${D.pad(dd)}`);
    if (!atParts) return void (await interaction.reply({ content: 'Неверная дата.' }));
    const nowIso = D.iso(D.todayParts());
    if (!m[3] && D.iso(atParts) < nowIso) atParts = D.partsFromIso(`${nowY + 1}-${D.pad(mm)}-${D.pad(dd)}`);
    const atIso = D.iso(atParts);
    const atHHMM = `${D.pad(hh)}:${D.pad(mi)}`;
    const nn = D.tzNow();
    if (atIso < nowIso || (atIso === nowIso && atHHMM <= `${D.pad(nn.h)}:${D.pad(nn.mi)}`)) {
      return void (await interaction.reply({ content: 'Это время уже прошло.' }));
    }
    const sid = storage.addScheduledAnnounce({ text, atIso, atHHMM, group: group || null, by: uid });
    storage.addAdminLog(uid, `запланировал объявление ${sid} на ${atIso} ${atHHMM}${group ? ` (${group})` : ''}`);
    log('INFO', `${uid} запланировал объявление ${sid} на ${atIso} ${atHHMM}`);
    await logToChannel(
      `🕓 ${tag(uid)} запланировал объявление \`${sid}\` на ${atIso} ${atHHMM}${group ? ` (группа ${group})` : ' (всем)'}\n\`\`\`\n${text.slice(0, 1200)}\n\`\`\``,
    );
    const view = menu.buildSchedAnnView(storage.listScheduledAnnounces());
    if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
    else await interaction.reply(view);
    return;
  }

  if (id === 'modal:addadmin') {
    if (!storage.isAdmin(uid)) return void (await interaction.reply({ content: 'Нет доступа.' }));
    const newId = interaction.fields.getTextInputValue('id').trim();
    if (!/^\d{15,20}$/.test(newId)) return void (await interaction.reply({ content: 'Это не похоже на Discord ID.' }));
    const added = storage.addAdmin(newId);
    log('INFO', `${uid} добавил админа ${newId} (${added ? 'ok' : 'уже был'})`);
    if (added) {
      storage.addAdminLog(uid, `добавил админа …${newId.slice(-4)}`);
      await logToChannel(`🛠 ${tag(uid)} добавил админа ${tag(newId)}`);
    }
    const view = menu.buildAdminsView(storage.getAdmins(), uid);
    if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
    else await interaction.reply(view);
    return;
  }
}

/** Разослать объявление подписчикам (всем или одной группе). */
async function broadcastAnnouncement(text, group) {
  const wantG = group ? ss.normGroup(group) : null;
  const subs = storage
    .subscribers()
    .map((u) => ({ ...u, myId: myLinkedId(u) }))
    .filter((u) => {
      if (!u.myId) return false;
      if (!wantG) return true;
      return u.group && u.role !== 'teacher' && ss.normGroup(u.group) === wantG;
    });
  let ok = 0;
  let fail = 0;
  for (const u of subs) {
    try {
      const user = await client.users.fetch(u.myId);
      await user.send({ content: `📢 **Объявление**\n\n${text}` });
      ok += 1;
    } catch {
      fail += 1;
    }
    await new Promise((r) => setTimeout(r, 900));
  }
  return { ok, fail, total: subs.length };
}

async function relayToAdmin(interaction, uid, topic, body) {
  // askerTag — раньше было interaction.user.tag (просто отображаемое имя, не
  // адрес) — теперь это реальный "сырой" Discord id, чтобы ответ на вопрос можно
  // было доставить и когда админ отвечает из Discord-канала «Вопросы» кнопкой,
  // а не только через ЛС (см. onModal -> modal:answer:).
  const qid = storage.addQuestion(uid, interaction.user.id, topic, body);
  await discordLog.sendQuestion('discord', `❓ ${tag(uid)} — ${topic}\n\`\`\`\n${body.slice(0, 1500)}\n\`\`\``, qid);
  const payload = menu.adminQuestionMessage(storage.getQuestion(qid), qid);
  let delivered = 0;
  for (const adminId of storage.getAdmins()) {
    try {
      const admin = await client.users.fetch(adminId);
      const msg = await admin.send(payload);
      msg.pin().catch((e) => log('DEBUG', `не закрепить вопрос ${qid} у ${adminId}: ${e.message}`));
      delivered += 1;
    } catch (err) {
      log('WARN', `вопрос ${qid} -> админу ${adminId}: ${err.message}`);
    }
  }
  if (delivered) {
    log('INFO', `вопрос ${qid} от ${uid} -> ${delivered} админам`);
    await interaction.reply({ content: '✅ Отправлено. Ответ придёт тебе в личные сообщения.' });
  } else {
    storage.deleteQuestion(qid);
    await interaction.reply({ content: 'Не удалось доставить администратору. Попробуй позже.' });
  }
}

// --------------------------------------------------------- планировщики

// u — запись из storage.subscribers() (может быть общим профилем на несколько
// связанных площадок); возвращает "сырой" Discord id ЭТОЙ группы, если он там
// есть (обычные Discord id — просто числа, без префикса tg:/vk:), иначе null.
const isPlatformPrefixed = (id) => String(id).startsWith('tg:') || String(id).startsWith('vk:');
const myLinkedId = (u) => u.linkedIds.find((id) => !isPlatformPrefixed(id)) || null;
let broadcasting = false;

function startSchedulers() {
  log(
    'INFO',
    `рассылка: у каждого своё время; по умолчанию ${cfg.defaultTime} ${cfg.timezone}, дни [${cfg.defaultDays.join(',')}]`,
  );
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

/** «Пауза заканчивается завтра» — раз в час. */
async function pauseReminderTick() {
  const tomIso = D.iso(D.tomorrowParts());
  for (const u of storage.subscribers()) {
    const myId = myLinkedId(u);
    if (!myId || u.pausedUntil !== tomIso || storage.getPlatformPauseNotified(myId) === tomIso) continue;
    try {
      const user = await client.users.fetch(myId);
      await user.send({
        content: `⏸ Пауза заканчивается завтра (${D.fmtDM(D.tomorrowParts())}) — рассылка, утро и напоминания снова включатся.`,
      });
    } catch (err) {
      if (!(err && err.code === 50007)) log('WARN', `пауза-напоминание ${myId}: ${err.message || err}`);
    }
    storage.setPlatformPauseNotified(myId, tomIso);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Отложенные объявления администраторов. */
async function announceTick() {
  const now = D.tzNow();
  const nowIso = D.iso(D.todayParts());
  const nowHHMM = `${D.pad(now.h)}:${D.pad(now.mi)}`;
  const due = storage.dueScheduledAnnounces(nowIso, nowHHMM).filter((a) => !isPlatformPrefixed(a.by || ''));
  if (!due.length) return;
  for (const a of due) {
    storage.removeScheduledAnnounce(a.id);
    const { ok, fail, total } = await broadcastAnnouncement(a.text, a.group);
    log('INFO', `отложенное объявление ${a.id}: доставлено ${ok}/${total}, не доставлено ${fail}`);
    storage.addAdminLog(a.by || 'система', `отложенное объявление ${a.id} отправлено (${ok}/${total})`);
    await logToChannel(
      `🕓✅ Отложенное объявление \`${a.id}\` (запланировал ${a.by ? tag(a.by) : 'система'}) отправлено${a.group ? ` группе **${a.group}**` : ' всем'} (доставлено ${ok}/${total})\n\`\`\`\n${String(a.text).slice(0, 1200)}\n\`\`\``,
    );
    if (a.by) {
      try {
        const admin = await client.users.fetch(a.by);
        await admin.send({ content: `✅ Отложенное объявление ${a.id} отправлено: доставлено ${ok} из ${total}.` });
      } catch {
        /* ignore */
      }
    }
  }
}

/** Держит кэш CSV на сегодня/завтра тёплым — чтобы «следующая пара» в /start была без задержки. */
async function warmTick() {
  const subs = storage.subscribers().filter((u) => myLinkedId(u));
  if (!subs.length) return;
  for (const t of [D.todayParts(), D.tomorrowParts()]) {
    await ss.fetchDayCsv(t, 4 * 60 * 1000).catch(() => {});
  }
}

/** Утреннее «Доброе утро»: сводка на сегодня. */
async function morningTick() {
  const now = D.tzNow();
  const hhmm = `${D.pad(now.h)}:${D.pad(now.mi)}`;
  const today = D.todayParts();
  const todayIso = D.iso(today);
  const dow = D.weekdayIso(today);

  const due = storage
    .subscribers()
    .map((u) => ({ ...u, myId: myLinkedId(u) }))
    .filter((u) => {
      if (!u.myId) return false;
      if (!u.morning || (u.morningTime || '07:30') !== hhmm) return false;
      if (isPaused(u.pausedUntil)) return false;
      const days = Array.isArray(u.days) ? u.days : cfg.defaultDays;
      if (!days.includes(dow)) return false;
      return storage.getPlatformMorningLastSent(u.myId) !== todayIso;
    });
  if (!due.length) return;

  let csvText = null;
  try {
    csvText = (await ss.fetchDayCsv(today, 4 * 60 * 1000)).csvText;
  } catch {
    /* нет данных — всё равно поздороваемся */
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
          const ep = D.epochAt(today, lessons[0].start);
          body = `${greet} Сегодня ${n} ${w}, первая в ${lessons[0].start}${ep ? ` (<t:${ep}:R>)` : ''}, до ${lessons[lessons.length - 1].end}.`;
        } else {
          body = D.weekdayIso(today) >= 6 ? `${greet} Сегодня выходной — пар нет 🎉` : `${greet} Сегодня пар нет.`;
        }
      }
    }
    try {
      const user = await client.users.fetch(u.myId);
      await user.send({ content: body });
      if (cfg.weatherEnabled) {
        const wf = storage.getPlatformWeatherFormat(u.myId);
        if (u.away && u.homePlace && u.homeLat != null && u.homeLon != null) {
          try {
            const homeForecast = await weather.dayForecast(u.homeLat, u.homeLon);
            await user.send(menu.buildWeatherMessage(u.homePlace, homeForecast, wf));
          } catch (err) {
            log('WARN', `погода (дом, ${u.myId}): ${err.message}`);
          }
        }
        if (cityForecast) {
          try {
            await user.send(menu.buildWeatherMessage(cfg.weatherPlace, cityForecast, wf));
          } catch (err) {
            log('WARN', `погода (город, ${u.myId}): ${err.message}`);
          }
        }
      }
      storage.setPlatformMorningLastSent(u.myId, todayIso);
    } catch (err) {
      if (err && err.code === 50007) storage.setPlatformMorningLastSent(u.myId, todayIso);
      else log('WARN', `утро ${u.myId}: ${err.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function broadcastTick() {
  if (broadcasting) return;
  const now = D.tzNow();
  const nowMin = now.h * 60 + now.mi;
  const target = D.tomorrowParts();
  const targetIso = D.iso(target);
  const dow = D.weekdayIso(target);

  // «Просрочен» = наступило время рассылки, а расписание на завтра ещё не отправлено.
  // Если расписания на сайте пока нет — runBroadcast не помечает отправку, и на
  // следующих минутах попытка повторяется, пока расписание не появится.
  storage.purgeExpiredPauses(D.iso(D.todayParts()));
  storage.purgeOldNotes(D.iso(D.todayParts()));

  const due = storage
    .subscribers()
    .map((u) => ({ ...u, myId: myLinkedId(u) }))
    .filter((u) => {
      if (!u.myId) return false;
      if (isPaused(u.pausedUntil)) return false;
      const [th, tm] = String(u.time || cfg.defaultTime).split(':').map(Number);
      if (nowMin < th * 60 + tm) return false;
      const days = Array.isArray(u.days) ? u.days : cfg.defaultDays;
      if (!days.includes(dow)) return false;
      return storage.getPlatformLastSent(u.myId) !== targetIso;
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

  // Ничего не отправляем и НЕ помечаем lastSent — тик через минуту повторит попытку.
  // Как только расписание появится на сайте, оно уйдёт подписчикам.
  if (sourceFailed) {
    log('INFO', 'рассылка отложена: источник временно недоступен, повтор позже');
    return;
  }
  if (notPublished && !weekendTomorrow) {
    log('INFO', `рассылка отложена: расписание на ${targetIso} ещё не опубликовано, повтор позже`);
    return;
  }
  if (!notPublished && !csvText) {
    log('WARN', 'рассылка отложена: пустой ответ источника, повтор позже');
    return;
  }

  const dataCache = new Map(); // groupNorm|showGaps -> scheduleData
  const digestSaved = new Set();
  let sent = 0;
  let skipped = 0;
  let deferredCount = 0;

  for (const u of due) {
    let payload;
    if (notPublished) {
      // сюда попадаем только если завтра выходной — по-доброму сообщаем и закрываем день
      payload = { content: `Завтра ${ss.weekdayRu(target)} — расписания нет, отдыхаем 🎉` };
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
        // разбор не удался — не помечаем отправку, повторим на следующем тике
        deferredCount += 1;
        continue;
      }
      if (data.note === 'no-lessons') {
        payload = {
          content: weekendTomorrow ? '🎉 Завтра выходной — пар нет, отдыхай!' : '📭 Завтра пар нет.',
        };
      } else {
        payload = menu.scheduleMessage(attachNotes(data, u.userId, targetIso), humanUrl, storage.getPlatformFormat(u.myId), u.theme);
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
      const user = await client.users.fetch(u.myId);
      await user.send(payload);
      sent += 1;
      storage.setPlatformLastSent(u.myId, targetIso);
    } catch (err) {
      skipped += 1;
      if (err && err.code === 50007) {
        log('INFO', `ЛС закрыты у ${u.myId} — пропуск`);
        storage.setPlatformLastSent(u.myId, targetIso);
      } else {
        log('WARN', `ЛС ${u.myId}: ${err.message || err}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  log('INFO', `рассылка завершена: отправлено ${sent}, пропущено ${skipped}, отложено ${deferredCount}`);
  await logToChannel(
    `📨 Ежедневная рассылка на ${D.fmtDM(target)} (${D.weekdayRu(target)}): получателей ${due.length}, отправлено ${sent}, пропущено ${skipped}, отложено ${deferredCount}`,
  );
}

// -------- напоминания за N минут до пары (проверка раз в минуту) --------

const remindersSent = new Set(); // `${uid}|${iso}|${startMin}`

async function reminderTick() {
  const users = storage
    .subscribers()
    .map((u) => ({ ...u, myId: myLinkedId(u) }))
    .filter((u) => u.myId && u.reminderMinutes > 0 && !isPaused(u.pausedUntil));
  if (!users.length) return;
  const today = D.todayParts();
  const todayIso = D.iso(today);
  const now = D.tzNow();
  const nowMin = now.h * 60 + now.mi;

  const byKey = new Map(); // subjKey -> scheduleData (canonical) | null
  let csvText = null;
  try {
    csvText = (await ss.fetchDayCsv(today, 10 * 60 * 1000)).csvText;
  } catch (err) {
    log('DEBUG', `напоминания: нет данных на сегодня: ${err.message}`);
    return;
  }

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
      if (startMin == null) continue;
      if (startMin - nowMin !== u.reminderMinutes) continue;
      const dedup = `${u.myId}|${todayIso}|${startMin}`;
      if (remindersSent.has(dedup)) continue;
      remindersSent.add(dedup);
      try {
        const user = await client.users.fetch(u.myId);
        const where = r.room ? `, ауд. ${r.room}` : '';
        const who = subj.kind === 'teacher' && r.groupsText ? ` — ${r.groupsText}` : '';
        const note = r.pair != null ? storage.getNotesForDay(u.userId, todayIso)[r.pair] : null;
        await user.send({
          content: `⏰ Через ${u.reminderMinutes} мин пара: **${r.subject}**${where}${who} (в ${r.start})${note ? `\n📝 ${note}` : ''}`,
        });
      } catch (err) {
        if (!(err && err.code === 50007)) log('WARN', `напоминание ${u.myId}: ${err.message || err}`);
      }
    }
  }
  // чистим вчерашние отметки
  for (const k of remindersSent) if (!k.includes(`|${todayIso}|`)) remindersSent.delete(k);
}

// -------- «расписание обновилось» (проверка раз в 15 минут) --------

async function changeTick() {
  const todayIso = D.iso(D.todayParts());
  storage.purgeDigests(todayIso);
  const entries = storage.digestEntries().filter((e) => e.iso >= todayIso);
  if (!entries.length) return;

  const subs = storage
    .subscribers()
    .map((u) => ({ ...u, myId: myLinkedId(u) }))
    .filter((u) => u.myId);
  for (const { key, group: sk, iso } of entries) {
    const target = D.partsFromIso(iso);
    if (!target) continue;
    const affected = subs.filter((u) => {
      if (isPaused(u.pausedUntil)) return false;
      const subj = subjOf(u);
      return subj && subjKey(subj) === sk && storage.getPlatformLastSent(u.myId) === iso;
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
      if (diff.added.length || diff.removed.length || diff.changed.length) {
        summaryText = menu.changeSummaryText(target, diff);
      }
    }
    storage.setDigest(key, hash, iso, newSnap);
    log('INFO', `расписание изменилось: ${sk} на ${iso}, уведомляю ${affected.length}`);

    const header = summaryText || `⚠️ Расписание на ${D.fmtDM(target)} обновилось:`;
    for (const u of affected) {
      try {
        const data = buildDayData(csvText, subjOf(u), target, { showGaps: u.showGaps });
        const body = menu.scheduleMessage(attachNotes(data, u.userId, iso), humanUrl, storage.getPlatformFormat(u.myId), u.theme);
        const user = await client.users.fetch(u.myId);
        await user.send({ content: header });
        await user.send(body);
      } catch (err) {
        if (!(err && err.code === 50007)) log('WARN', `уведомление об изменении ${u.myId}: ${err.message || err}`);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

// -------- авто-алерт админам: источник расписания не грузится --------

const PROCESS_START = Date.now();
const healthAlert = { notifiedBroken: false, lastNotifiedAt: 0 };

async function notifyAdmins(text) {
  for (const id of storage.getAdmins()) {
    try {
      const admin = await client.users.fetch(id);
      await admin.send({ content: text });
    } catch (err) {
      if (!(err && err.code === 50007)) log('WARN', `health-алерт ${id}: ${err.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function healthTick() {
  if (!cfg.healthAlertEnabled || !storage.getAdmins().length) return;

  const now = D.tzNow();
  const studyTime = now.h >= 7 && now.h < 20 && D.weekdayIso(D.todayParts()) <= 5;

  // Свежая проба, чтобы health отражал текущее состояние даже без подписчиков.
  await ss.fetchDayCsv(D.todayParts(), 5 * 60 * 1000).catch(() => {});
  const h = ss.health();

  const staleMs = Date.now() - (h.lastOkAt || PROCESS_START);
  const broken = staleMs > cfg.healthAlertHours * 60 * 60 * 1000;

  if (broken && studyTime) {
    const COOLDOWN = 6 * 60 * 60 * 1000;
    if (Date.now() - healthAlert.lastNotifiedAt < COOLDOWN) return;
    healthAlert.lastNotifiedAt = Date.now();
    healthAlert.notifiedBroken = true;
    const hoursAgo = h.lastOkAt ? Math.round(staleMs / (60 * 60 * 1000)) : null;
    const text =
      '🔴 **Источник расписания не отвечает**\n' +
      (h.lastOkAt
        ? `Последняя успешная загрузка ~${hoursAgo} ч назад (<t:${Math.floor(h.lastOkAt / 1000)}:R>).\n`
        : 'С момента запуска бота ни одной успешной загрузки.\n') +
      (h.lastErrMsg ? `Ошибка: \`${String(h.lastErrMsg).slice(0, 300)}\`\n` : '') +
      'Проверь koopteh10.ru и доступ к Google-таблицам. Рассылка сама возобновится, как только источник заработает.';
    await notifyAdmins(text);
    log('WARN', `health-алерт отправлен админам (простой ${Math.round(staleMs / 60000)} мин)`);
  } else if (!broken && healthAlert.notifiedBroken && h.lastOkAt) {
    healthAlert.notifiedBroken = false;
    healthAlert.lastNotifiedAt = 0;
    await notifyAdmins(`🟢 **Источник расписания снова доступен.** Загрузка выполнена <t:${Math.floor(h.lastOkAt / 1000)}:R>.`);
    log('INFO', 'health восстановлен — уведомил админов');
  }
}

// --------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.stack ? reason.stack : String(reason);
  log('ERROR', `unhandledRejection: ${msg}`);
  logToChannel(`⚠️ Необработанная ошибка (unhandledRejection):\n\`\`\`\n${msg.slice(0, 1500)}\n\`\`\``).catch(() => {});
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('INFO', `получен ${signal}, останавливаюсь`);
  try {
    await logToChannel(`🛑 Бот останавливается (${signal})`);
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

client.login(cfg.token);
