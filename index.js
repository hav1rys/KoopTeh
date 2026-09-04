'use strict';

const {
  Client,
  GatewayIntentBits,
  Events,
  ActivityType,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ApplicationIntegrationType,
  InteractionContextType,
} = require('discord.js');

const cfg = require('./config');
const D = require('./dates');
const storage = require('./storage');
const ss = require('./scheduleSource');
const render = require('./render');
const server = require('./server');
const menu = require('./menu');

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

function effState(uid) {
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
    format: s.format,
    reminderMinutes: s.reminderMinutes,
    morning: s.morning,
    morningTime: s.morningTime,
  };
}

/** Меню + виджеты «ближайшая рассылка» и «следующая пара» (из кэша, без сети). */
function menuView(uid) {
  const s = effState(uid);
  const nb = s.subj && s.subscribed ? D.nextBroadcast(s.days, s.time) : null;
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
  return menu.buildMenu(s, { nextBroadcastEpoch: nb, nextPair });
}

const notPublishedText = (t) =>
  `Расписание на ${ss.fmtDM(t)} (${ss.weekdayRu(t)}) ещё не опубликовано на сайте.`;

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
  const s = effState(uid);
  const { data, url, error } = await safeSchedule(s.subj, target, s.showGaps);
  await interaction.editReply(menu.buildScheduleView(data, D.iso(target), url, error, s.format));
}

/** Снимок расписания отдельным сообщением. */
async function sendScheduleSnapshot(interaction, subj, target, showGaps, format) {
  await interaction.deferReply();
  const { data, url, error } = await safeSchedule(subj, target, showGaps);
  if (error) {
    await interaction.editReply({ content: error, embeds: [] });
    return;
  }
  await interaction.editReply(menu.scheduleMessage(data, url, format));
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

/** Показывает экран поиска/преподавателя. fresh:true — из слэш-команды (deferReply), иначе из кнопки/модалки (update). */
async function showLookup(interaction, uid, kind, params, target, { fresh = false } = {}) {
  if (fresh) await interaction.deferReply();
  else await interaction.update({ content: '⏳ Ищу…', embeds: [], components: [] });
  const s = effState(uid);
  lookupState.set(uid, { kind, params, iso: D.iso(target) });
  try {
    const { data, humanUrl } = await runLookup(kind, params, target);
    await interaction.editReply(menu.buildLookupView(data, humanUrl, s.format));
  } catch (err) {
    const msg = err instanceof ss.NotPublishedError ? notPublishedText(target) : 'Не удалось выполнить поиск, попробуй позже.';
    if (!(err instanceof ss.NotPublishedError)) log('WARN', `lookup ${kind}: ${err.message}`);
    await interaction.editReply(menu.buildLookupView(null, null, s.format, msg));
  }
}

// uid -> список групп (для листания)
const groupCache = new Map();

// -------- авто-роль группы на сервере PROVISION_GUILD_ID --------

async function syncGroupRole(userId) {
  if (!cfg.provisionGuildId) return;
  const guild = client.guilds.cache.get(cfg.provisionGuildId);
  if (!guild) return;
  let member;
  try {
    member = await guild.members.fetch(userId);
  } catch {
    return; // не на сервере
  }
  if (!guild.roles.cache.size) await guild.roles.fetch().catch(() => {});

  const s = storage.get(userId);
  const groupName = s.role !== 'teacher' && s.group ? s.group : null;
  const courseM = groupName && /^\s*([1-4])\d/.exec(groupName);
  const courseName = courseM ? `${courseM[1]} курс` : null;
  const teacherName = s.role === 'teacher' && s.teacherName ? 'Преподаватель' : null;
  const guestName = !groupName && !teacherName ? 'Гость' : null;

  let groupNames;
  try {
    groupNames = new Set(await ss.listAllGroups());
  } catch {
    groupNames = new Set();
  }
  if (groupName) groupNames.add(groupName);
  const COURSE = new Set(['1 курс', '2 курс', '3 курс', '4 курс']);

  const want = [groupName, courseName, teacherName, guestName].filter(Boolean);
  const managed = new Set([...want, 'Преподаватель', 'Гость', ...COURSE]);

  try {
    for (const r of member.roles.cache.values()) {
      const isGroupRole = groupNames.has(r.name);
      if ((isGroupRole || managed.has(r.name)) && !want.includes(r.name)) {
        await member.roles.remove(r, 'синхронизация ролей ботом').catch(() => {});
      }
    }
    for (const name of want) {
      if (member.roles.cache.some((r) => r.name === name)) continue;
      const role = guild.roles.cache.find((r) => r.name === name);
      if (role) await member.roles.add(role, 'роль из бота').catch(() => {});
    }
  } catch (err) {
    log('WARN', `роли ${userId}: ${err.message}`);
  }
}

// -------------------------------------------------------------------- клиент

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    ...(cfg.memberIntent ? [GatewayIntentBits.GuildMembers] : []),
  ],
});

// Роль «Гость» сразу при входе (нужен MEMBER_INTENT=1 + включённый Server Members Intent).
client.on(Events.GuildMemberAdd, async (member) => {
  if (!cfg.provisionGuildId || member.guild.id !== cfg.provisionGuildId || member.user.bot) return;
  const role = member.guild.roles.cache.find((r) => r.name === 'Гость');
  if (role) await member.roles.add(role, 'вход на сервер').catch(() => {});
});

client.once(Events.ClientReady, async (c) => {
  log('INFO', `вошёл как ${c.user.tag} (id ${c.user.id})`);
  await registerCommands(c);
  startSchedulers();
  startPresence(c);
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
      .setDescription('Поиск по кабинету и/или преподавателю')
      .addStringOption((o) => o.setName('кабинет').setDescription('Номер кабинета'))
      .addStringOption((o) => o.setName('преподаватель').setDescription('Фамилия').setAutocomplete(true))
      .addStringOption((o) => o.setName('дата').setDescription('дд.мм')),
    new SlashCommandBuilder()
      .setName('преподаватель')
      .setDescription('Пары преподавателя за день')
      .addStringOption((o) => o.setName('фамилия').setDescription('Фамилия').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('дата').setDescription('дд.мм')),
    new SlashCommandBuilder().setName('звонки').setDescription('Расписание звонков и текущий статус'),
    new SlashCommandBuilder().setName('admin').setDescription('Панель администратора'),
    new SlashCommandBuilder()
      .setName('setup-server')
      .setDescription('Создать роли/категории/каналы под группы (только админ, на сервере)')
      .addStringOption((o) =>
        o.setName('группа').setDescription('Только одна группа (иначе — все)').setAutocomplete(true),
      ),
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
      if (id.startsWith('days:')) return await onDaysButton(interaction);
      if (id.startsWith('rem:')) return await onReminderButton(interaction);
      if (id.startsWith('mrn:')) return await onMorningButton(interaction);
      if (id.startsWith('ans:')) return await onAnswerButton(interaction);
      if (id.startsWith('adm:')) return await onAdminButton(interaction);
      if (id.startsWith('chac:')) return await onChanAccessButton(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'grp:pick') return await onGroupSelect(interaction);
    if (interaction.isStringSelectMenu() && interaction.customId === 'chac:pick') return await onChanAccessPick(interaction);
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('chac:roles:')) {
      return await onChanAccessRoles(interaction);
    }
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

async function onSetupServer(interaction, uid) {
  if (!storage.isAdmin(uid)) return void (await interaction.reply({ content: 'Нет доступа.' }));
  if (!interaction.inGuild() || !interaction.guild) {
    return void (await interaction.reply({ content: 'Запусти команду на сервере.' }));
  }
  if (cfg.provisionGuildId && interaction.guildId !== cfg.provisionGuildId) {
    return void (await interaction.reply({ content: 'Эта команда разрешена только на заданном сервере.' }));
  }
  const me = interaction.guild.members.me || (await interaction.guild.members.fetchMe().catch(() => null));
  if (!me || !me.permissions.has([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels])) {
    return void (await interaction.reply({
      content: 'Боту нужны права **Управление ролями** и **Управление каналами** на сервере.',
    }));
  }

  const one = (interaction.options.getString('группа') || '').trim();
  let groups;
  try {
    groups = one ? [one] : await ss.listAllGroups();
  } catch (err) {
    return void (await interaction.reply({ content: `Не удалось получить список групп: ${err.message}` }));
  }
  if (!groups.length) return void (await interaction.reply({ content: 'Список групп пуст.' }));

  const perGroup = server.TEXT_CHANNELS.length + server.VOICE_CHANNELS.length + 1; // +категория
  const limitWarn =
    groups.length * perGroup > 480
      ? `\n⚠️ У Discord лимит 500 каналов на сервер, а нужно ~${groups.length * perGroup}. Часть не создастся — запускай по одной группе (параметр «группа») или уменьши список.`
      : '';
  await interaction.reply({
    content:
      `Начинаю: ${groups.length} ${groups.length === 1 ? 'группа' : 'групп'}. ` +
      `На группу: 1 роль, 1 категория, ${server.TEXT_CHANNELS.length + server.VOICE_CHANNELS.length} каналов. ` +
      'Займёт несколько минут.' +
      limitWarn,
  });

  const started = Date.now();
  const onProgress = async (done, total, errors) => {
    await interaction
      .editReply({ content: `⏳ ${done}/${total}${errors.length ? ` · ошибок: ${errors.length}` : ''}` })
      .catch(() => {});
  };

  let result;
  try {
    result = await server.provision(interaction.guild, interaction.client.user.id, groups, onProgress, {
      common: !one,
    });
  } catch (err) {
    log('ERROR', `setup-server: ${err.stack || err}`);
    return void (await interaction.editReply({ content: `Сбой: ${err.message}` }).catch(() => {}));
  }

  const secs = Math.round((Date.now() - started) / 1000);
  let msg = `✅ Готово: ${result.done}/${groups.length} за ${secs} с.`;
  if (result.errors.length) msg += `\n⚠️ Ошибки (${result.errors.length}):\n` + result.errors.slice(0, 15).join('\n');
  log('INFO', `setup-server от ${uid}: ${result.done} групп, ошибок ${result.errors.length}`);
  await interaction.editReply({ content: msg.slice(0, 1990) }).catch(() => {});
}

async function onAutocomplete(interaction) {
  const f = interaction.options.getFocused(true); // { name, value }
  const q = String(f.value || '').toLowerCase().trim();
  let list = [];
  try {
    if (f.name === 'группа') list = await ss.listAllGroups();
    else if (f.name === 'преподаватель' || f.name === 'фамилия') list = await ss.listAllTeachers();
  } catch {
    /* ignore */
  }
  const filtered = q ? list.filter((v) => v.toLowerCase().includes(q)) : list;
  await interaction.respond(filtered.slice(0, 25).map(CHOICE));
}

async function onSlash(interaction) {
  const uid = interaction.user.id;
  const name = interaction.commandName;

  if (name === 'start') {
    await interaction.reply(menuView(uid));
    syncGroupRole(uid).catch(() => {});
    return;
  }

  if (name === 'admin') {
    if (!storage.isAdmin(uid)) return void (await interaction.reply({ content: 'Нет доступа.' }));
    await interaction.reply(menu.buildAdminMenu());
    return;
  }

  if (name === 'setup-server') {
    await onSetupServer(interaction, uid);
    return;
  }

  if (name === 'звонки') {
    await interaction.reply(menu.bellView());
    return;
  }

  const s = effState(uid);

  if (name === 'расписание') {
    const grpParam = (interaction.options.getString('группа') || '').trim();
    const subj = grpParam ? { kind: 'group', name: grpParam } : s.subj;
    if (!subj) {
      return void (await interaction.reply({ content: 'Укажи группу параметром или сохрани её через /start.' }));
    }
    const target = parseDateField(interaction.options.getString('дата'));
    if (!target) return void (await interaction.reply({ content: 'Не понял дату. Формат: дд.мм.' }));
    await interaction.deferReply();
    const { data, url, error } = await safeSchedule(subj, target, s.showGaps);
    if (error) return void (await interaction.editReply({ content: error, embeds: [] }));
    await interaction.editReply(menu.scheduleMessage(data, url, s.format));
    return;
  }

  if (name === 'поиск') {
    const room = (interaction.options.getString('кабинет') || '').trim();
    const teacher = (interaction.options.getString('преподаватель') || '').trim();
    if (!room && !teacher) return void (await interaction.reply({ content: 'Укажи кабинет или преподавателя.' }));
    const target = parseDateField(interaction.options.getString('дата'));
    if (!target) return void (await interaction.reply({ content: 'Не понял дату. Формат: дд.мм.' }));
    await showLookup(interaction, uid, 'search', { room, teacher }, target, { fresh: true });
    return;
  }

  if (name === 'преподаватель') {
    const surname = interaction.options.getString('фамилия').trim();
    const target = parseDateField(interaction.options.getString('дата'));
    if (!target) return void (await interaction.reply({ content: 'Не понял дату. Формат: дд.мм.' }));
    await showLookup(interaction, uid, 'teacher', { surname }, target, { fresh: true });
  }
}

async function onMenuButton(interaction) {
  const action = interaction.customId.slice('menu:'.length);
  const uid = interaction.user.id;
  const s = effState(uid);

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
    case 'role':
      await interaction.update(menu.buildRoleView(s));
      return;
    case 'bell':
      await interaction.update(menu.bellView());
      return;
    case 'now':
      if (!s.subj) return void (await interaction.reply({ content: 'Сначала укажи группу или фамилию.' }));
      await sendScheduleSnapshot(interaction, s.subj, D.tomorrowParts(), s.showGaps, s.format);
      return;
    case 'togglesub':
      storage.setSubscribed(uid, !s.subscribed);
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
      storage.setFormat(uid, s.format === 'text' ? 'embed' : 'text');
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
    case 'refresh':
      await interaction.update(menuView(uid));
      return;
    default:
  }
}

async function onGroupButton(interaction) {
  const uid = interaction.user.id;
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
  const uid = interaction.user.id;
  storage.setGroup(uid, interaction.values[0]);
  log('INFO', `${uid} выбрал группу "${interaction.values[0]}"`);
  await interaction.update(menuView(uid));
  syncGroupRole(uid).catch(() => {});
}

async function onScheduleButton(interaction) {
  const uid = interaction.user.id;
  const rest = interaction.customId.slice('sch:'.length);
  const s = effState(uid);

  if (rest === 'menu') return void (await interaction.update(menuView(uid)));

  if (rest.startsWith('report:')) {
    await interaction.showModal(menu.reportModal(rest.slice('report:'.length)));
    return;
  }
  if (rest.startsWith('send:')) {
    const t = D.partsFromIso(rest.slice('send:'.length));
    if (!t || !s.subj) return;
    await sendScheduleSnapshot(interaction, s.subj, t, s.showGaps, s.format);
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
  const uid = interaction.user.id;
  const rest = interaction.customId.slice('lk:'.length);
  if (rest === 'menu') return void (await interaction.update(menuView(uid)));

  const st = lookupState.get(uid);
  if (!st) {
    await interaction.update({ content: 'Поиск устарел — открой его заново из меню.', embeds: [], components: [] });
    return;
  }

  if (rest === 'pin') {
    if (st.kind !== 'teacher' || !st.params.surname) return;
    storage.setTeacherName(uid, st.params.surname);
    storage.setRole(uid, 'teacher');
    if (!storage.get(uid).subscribed) storage.setSubscribed(uid, true);
    log('INFO', `${uid} закрепил режим преподавателя: ${st.params.surname}`);
    syncGroupRole(uid).catch(() => {});
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
  const uid = interaction.user.id;
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
    await interaction.update(menu.buildRoleView(effState(uid)));
    syncGroupRole(uid).catch(() => {});
  }
}

async function onDaysButton(interaction) {
  const uid = interaction.user.id;
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
  const uid = interaction.user.id;
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
  const uid = interaction.user.id;
  const rest = interaction.customId.slice('mrn:'.length);
  if (rest === 'done') return void (await interaction.update(menu.buildSettingsView(effState(uid))));
  if (rest === 'time') return void (await interaction.showModal(menu.morningTimeModal(effState(uid).morningTime)));
  if (rest === 'toggle') {
    storage.setMorning(uid, !effState(uid).morning);
    await interaction.update(menu.buildMorningView(effState(uid)));
  }
}

async function onSettingsButton(interaction) {
  const uid = interaction.user.id;
  const rest = interaction.customId.slice('set:'.length);
  const s = effState(uid);
  const back = () => interaction.update(menu.buildSettingsView(effState(uid)));

  switch (rest) {
    case 'back':
      return void (await interaction.update(menuView(uid)));
    case 'togglesub':
      storage.setSubscribed(uid, !s.subscribed);
      return void (await back());
    case 'togglegaps':
      storage.setShowGaps(uid, !s.showGaps);
      return void (await back());
    case 'format':
      storage.setFormat(uid, s.format === 'text' ? 'embed' : 'text');
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

async function onAnswerButton(interaction) {
  const qid = interaction.customId.slice('ans:'.length);
  if (!storage.isAdmin(interaction.user.id)) return void (await interaction.reply({ content: 'Эта кнопка не для тебя.' }));
  const q = storage.getQuestion(qid);
  if (!q) {
    interaction.message?.unpin?.().catch(() => {});
    return void (await interaction.reply({ content: 'Вопрос не найден или на него уже ответили.' }));
  }
  await interaction.showModal(menu.answerModal(qid, q.topic));
}

// -------- обзор недели --------

const weekState = new Map(); // uid -> mondayIso

async function renderWeek(interaction, uid, mondayParts) {
  await interaction.update({ content: '⏳ Загружаю неделю…', embeds: [], components: [] });
  const s = effState(uid);
  const days = [];
  for (let i = 0; i < 6; i++) {
    const parts = D.shiftParts(mondayParts, i);
    try {
      const { csvText } = await ss.fetchDayCsv(parts, 5 * 60 * 1000);
      days.push({ parts, data: buildDayData(csvText, s.subj, parts, { showGaps: false }) });
    } catch (err) {
      days.push({ parts, error: err instanceof ss.NotPublishedError ? 'не опубликовано' : 'ошибка' });
    }
  }
  weekState.set(uid, D.iso(mondayParts));
  await interaction.editReply(menu.buildWeekView({ days }, s.format));
}

async function onWeekButton(interaction) {
  const uid = interaction.user.id;
  const rest = interaction.customId.slice('wk:'.length);
  if (rest === 'menu') return void (await interaction.update(menuView(uid)));
  const cur = D.partsFromIso(weekState.get(uid) || '') || D.mondayOf(D.todayParts());
  let monday;
  if (rest === 'this') monday = D.mondayOf(D.todayParts());
  else if (rest === 'prev') monday = D.shiftParts(cur, -7);
  else if (rest === 'next') monday = D.shiftParts(cur, 7);
  else return;
  await renderWeek(interaction, uid, monday);
}

// -------- админ-панель --------

async function onAdminButton(interaction) {
  const uid = interaction.user.id;
  if (!storage.isAdmin(uid)) return void (await interaction.reply({ content: 'Нет доступа.' }));
  const rest = interaction.customId.slice('adm:'.length);

  if (rest === 'menu') return void (await interaction.update(menu.buildAdminMenu()));
  if (rest === 'stats') return void (await interaction.update(menu.buildStatsView(storage.stats())));
  if (rest === 'admins') return void (await interaction.update(menu.buildAdminsView(storage.getAdmins(), uid)));
  if (rest === 'announce') return void (await interaction.showModal(menu.announceModal()));
  if (rest === 'addadmin') return void (await interaction.showModal(menu.addAdminModal()));
  if (rest === 'chanaccess') {
    const guild = provisionGuild();
    if (!guild) {
      return void (await interaction.update(
        menu.buildChannelAccessPick([], 'Не задан PROVISION_GUILD_ID или бот не на сервере.'),
      ));
    }
    await guild.channels.fetch().catch(() => {});
    return void (await interaction.update(menu.buildChannelAccessPick(server.managedChannels(guild))));
  }
  if (rest.startsWith('del:')) {
    const id = rest.slice('del:'.length);
    if (!storage.removeAdmin(id)) {
      await interaction.reply({ content: 'Нельзя удалить (последний админ или не найден).' });
      return;
    }
    log('INFO', `${uid} удалил админа ${id}`);
    await interaction.update(menu.buildAdminsView(storage.getAdmins(), uid));
  }
}

function provisionGuild() {
  return cfg.provisionGuildId ? client.guilds.cache.get(cfg.provisionGuildId) || null : null;
}

async function onChanAccessButton(interaction) {
  if (!storage.isAdmin(interaction.user.id)) return void (await interaction.reply({ content: 'Нет доступа.' }));
  const rest = interaction.customId.slice('chac:'.length);
  if (rest === 'back') {
    const guild = provisionGuild();
    await guild?.channels.fetch().catch(() => {});
    await interaction.update(menu.buildChannelAccessPick(guild ? server.managedChannels(guild) : []));
  }
}

async function onChanAccessPick(interaction) {
  if (!storage.isAdmin(interaction.user.id)) return void (await interaction.reply({ content: 'Нет доступа.' }));
  const guild = provisionGuild();
  const ch = guild && guild.channels.cache.get(interaction.values[0]);
  if (!ch) return void (await interaction.update(menu.buildChannelAccessPick([], 'Канал не найден, обнови список.')));
  await interaction.update(menu.buildChannelAccessRoles(ch.id, ch.name, server.currentPosters(ch)));
}

async function onChanAccessRoles(interaction) {
  if (!storage.isAdmin(interaction.user.id)) return void (await interaction.reply({ content: 'Нет доступа.' }));
  const channelId = interaction.customId.slice('chac:roles:'.length);
  const guild = provisionGuild();
  const ch = guild && guild.channels.cache.get(channelId);
  if (!ch) return void (await interaction.update(menu.buildChannelAccessPick([], 'Канал не найден.')));
  const roleIds = [...interaction.roles.keys()];
  try {
    await server.setChannelPosters(ch, roleIds);
    log('INFO', `${interaction.user.id}: доступ к #${ch.name} -> роли [${roleIds.join(', ') || '—'}]`);
    await interaction.update(
      menu.buildChannelAccessPick(
        server.managedChannels(guild),
        `✅ #${ch.name}: писать могут ${roleIds.length ? roleIds.map((r) => `<@&${r}>`).join(', ') : 'только админы'}.`,
      ),
    );
  } catch (err) {
    log('WARN', `chan access: ${err.message}`);
    await interaction.update(menu.buildChannelAccessPick(server.managedChannels(guild), `Ошибка: ${err.message}`));
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
  const uid = interaction.user.id;
  const id = interaction.customId;

  if (id === 'modal:setgroup') {
    const group = interaction.fields.getTextInputValue('group').trim();
    if (!group) return void (await interaction.reply({ content: 'Пустое название группы.' }));
    storage.setGroup(uid, group);
    log('INFO', `${uid} ввёл группу "${group}"`);
    syncGroupRole(uid).catch(() => {});
    return void (await sendMenu(interaction, uid));
  }

  if (id === 'modal:setteacher') {
    const surname = interaction.fields.getTextInputValue('surname').trim();
    storage.setTeacherName(uid, surname || null);
    if (surname) storage.setRole(uid, 'teacher');
    else if (storage.get(uid).role === 'teacher') storage.setRole(uid, 'student');
    log('INFO', `${uid} режим преподавателя: "${surname || '—'}"`);
    syncGroupRole(uid).catch(() => {});
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

  if (id === 'modal:ask') {
    const topic = interaction.fields.getTextInputValue('topic').trim() || 'Без темы';
    const question = interaction.fields.getTextInputValue('question').trim();
    if (!question) return void (await interaction.reply({ content: 'Пустой вопрос.' }));
    await relayToAdmin(interaction, uid, topic, question);
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
    try {
      const asker = await client.users.fetch(q.askerId);
      await asker.send(menu.answerMessage(q, answer));
      storage.deleteQuestion(qid);
      log('INFO', `ответ на вопрос ${qid} доставлен ${q.askerId}`);
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

  if (id === 'modal:morningtime') {
    const hhmm = D.parseHHMM(interaction.fields.getTextInputValue('time'));
    if (!hhmm) return void (await interaction.reply({ content: 'Неверный формат. Нужно ЧЧ:ММ, например 07:30.' }));
    storage.setMorningTime(uid, hhmm);
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
    const subs = storage.subscribers();
    await interaction.reply({ content: `Рассылаю объявление ${subs.length} подписчикам…` });
    let ok = 0;
    let fail = 0;
    for (const u of subs) {
      try {
        const user = await client.users.fetch(u.userId);
        await user.send({ content: `📢 **Объявление**\n\n${text}` });
        ok += 1;
      } catch {
        fail += 1;
      }
      await new Promise((r) => setTimeout(r, 900));
    }
    log('INFO', `объявление от ${uid}: доставлено ${ok}, не доставлено ${fail}`);
    try {
      await interaction.followUp({ content: `Готово: доставлено ${ok}, не доставлено ${fail}.` });
    } catch {
      /* ignore */
    }
    return;
  }

  if (id === 'modal:addadmin') {
    if (!storage.isAdmin(uid)) return void (await interaction.reply({ content: 'Нет доступа.' }));
    const newId = interaction.fields.getTextInputValue('id').trim();
    if (!/^\d{15,20}$/.test(newId)) return void (await interaction.reply({ content: 'Это не похоже на Discord ID.' }));
    const added = storage.addAdmin(newId);
    log('INFO', `${uid} добавил админа ${newId} (${added ? 'ok' : 'уже был'})`);
    const view = menu.buildAdminsView(storage.getAdmins(), uid);
    if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
    else await interaction.reply(view);
    return;
  }
}

async function relayToAdmin(interaction, uid, topic, body) {
  const qid = storage.addQuestion(uid, interaction.user.tag, topic, body);
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

let broadcasting = false;

function startSchedulers() {
  log(
    'INFO',
    `рассылка: у каждого своё время; по умолчанию ${cfg.defaultTime} ${cfg.timezone}, дни [${cfg.defaultDays.join(',')}]`,
  );
  setInterval(broadcastTick, 60 * 1000);
  setInterval(morningTick, 60 * 1000);
  setInterval(reminderTick, 60 * 1000);
  setInterval(changeTick, 15 * 60 * 1000);
  setInterval(warmTick, 5 * 60 * 1000);
  broadcastTick();
  warmTick();
}

/** Держит кэш CSV на сегодня/завтра тёплым — чтобы «следующая пара» в /start была без задержки. */
async function warmTick() {
  const subs = storage.subscribers();
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

  const due = storage.subscribers().filter((u) => {
    if (!u.morning || (u.morningTime || '07:30') !== hhmm) return false;
    const days = Array.isArray(u.days) ? u.days : cfg.defaultDays;
    if (!days.includes(dow)) return false;
    return u.morningLastSent !== todayIso;
  });
  if (!due.length) return;

  let csvText = null;
  try {
    csvText = (await ss.fetchDayCsv(today, 4 * 60 * 1000)).csvText;
  } catch {
    /* нет данных — всё равно поздороваемся */
  }

  const cache = new Map();
  for (const u of due) {
    const subj = subjOf(u);
    let body = '☀️ Доброе утро!';
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
          body = `☀️ Доброе утро! Сегодня ${n} ${w}, первая в ${lessons[0].start}${ep ? ` (<t:${ep}:R>)` : ''}, до ${lessons[lessons.length - 1].end}.`;
        } else {
          body = D.weekdayIso(today) >= 6 ? '☀️ Доброе утро! Сегодня выходной — пар нет 🎉' : '☀️ Доброе утро! Сегодня пар нет.';
        }
      }
    }
    try {
      const user = await client.users.fetch(u.userId);
      await user.send({ content: body });
      storage.setMorningLastSent(u.userId, todayIso);
    } catch (err) {
      if (err && err.code === 50007) storage.setMorningLastSent(u.userId, todayIso);
      else log('WARN', `утро ${u.userId}: ${err.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function broadcastTick() {
  if (broadcasting) return;
  const now = D.tzNow();
  const hhmm = `${D.pad(now.h)}:${D.pad(now.mi)}`;
  const target = D.tomorrowParts();
  const targetIso = D.iso(target);
  const dow = D.weekdayIso(target);

  // Отправка в каналы #расписание — по общему времени/дням (BROADCAST_TIME / BROADCAST_DAYS).
  if (hhmm === cfg.defaultTime && cfg.defaultDays.includes(dow)) {
    channelBroadcast(target).catch((e) => log('ERROR', `каналы: ${e.stack || e}`));
  }

  const due = storage.subscribers().filter((u) => {
    if ((u.time || cfg.defaultTime) !== hhmm) return false;
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

const channelPosted = new Map(); // channelId -> iso

/** Постит расписание на завтра в каждый канал #расписание (категория = группа). */
async function channelBroadcast(target) {
  if (!cfg.provisionGuildId) return;
  const guild = client.guilds.cache.get(cfg.provisionGuildId);
  if (!guild) return;
  const targetIso = D.iso(target);
  await guild.channels.fetch().catch(() => {});

  const chans = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildText && c.parent && /расписан/i.test(c.name),
  );
  if (!chans.size) return;

  let csvText = null;
  let humanUrl = null;
  let notPub = false;
  try {
    const r = await ss.fetchDayCsv(target, 0);
    csvText = r.csvText;
    humanUrl = r.humanUrl;
  } catch (err) {
    if (err instanceof ss.NotPublishedError) notPub = true;
    else return void log('WARN', `каналы: источник недоступен: ${err.message}`);
  }

  const weekend = D.weekdayIso(target) >= 6;
  const cache = new Map();
  let posted = 0;
  for (const ch of chans.values()) {
    if (channelPosted.get(ch.id) === targetIso) continue;
    const group = ch.parent.name;
    let payload;
    if (notPub) {
      payload = { content: `Расписание на ${D.fmtDM(target)} ещё не опубликовано.` };
    } else {
      const gk = ss.normGroup(group);
      if (!cache.has(gk)) {
        try {
          cache.set(gk, ss.buildScheduleData(csvText, group, target, { showGaps: true }));
        } catch {
          cache.set(gk, null);
        }
      }
      const data = cache.get(gk);
      if (!data) continue;
      if (data.note === 'not-found') {
        channelPosted.set(ch.id, targetIso); // категория не совпала с группой — не спамим
        continue;
      }
      if (data.note === 'no-lessons') {
        payload = { content: weekend ? '🎉 Завтра выходной — пар нет.' : '📭 Завтра пар нет.' };
      } else {
        payload = menu.scheduleEmbed(data, humanUrl);
      }
    }
    try {
      await ch.send(payload);
      channelPosted.set(ch.id, targetIso);
      posted += 1;
    } catch (err) {
      log('WARN', `канал ${ch.id} (${group}): ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  for (const [k, v] of channelPosted) if (v !== targetIso) channelPosted.delete(k);
  if (posted) log('INFO', `каналы: расписание отправлено в ${posted}`);
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

  const dataCache = new Map(); // groupNorm|showGaps -> scheduleData
  const digestSaved = new Set();
  let sent = 0;
  let skipped = 0;

  const weekendTomorrow = D.weekdayIso(target) >= 6;

  for (const u of due) {
    let payload;
    if (notPublished) {
      payload = {
        content: weekendTomorrow
          ? `Завтра ${ss.weekdayRu(target)} — расписания нет, отдыхаем 🎉`
          : notPublishedText(target),
      };
    } else if (sourceFailed || !csvText) payload = { content: 'Не удалось получить расписание, попробую позже.' };
    else {
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
      if (!data) payload = { content: 'Не удалось получить расписание, попробую позже.' };
      else if (data.note === 'no-lessons') {
        payload = {
          content: weekendTomorrow
            ? '🎉 Завтра выходной — пар нет, отдыхай!'
            : '📭 Завтра пар нет.',
        };
      } else {
        payload = menu.scheduleMessage(data, humanUrl, u.format);
        if (!digestSaved.has(sk)) {
          try {
            const canon = buildDayData(csvText, subj, target, {});
            storage.setDigest(`${sk}|${targetIso}`, ss.scheduleHash(canon), targetIso);
          } catch {
            /* ignore */
          }
          digestSaved.add(sk);
        }
      }
    }

    try {
      const user = await client.users.fetch(u.userId);
      await user.send(payload);
      sent += 1;
      storage.setLastSent(u.userId, targetIso);
    } catch (err) {
      skipped += 1;
      if (err && err.code === 50007) {
        log('INFO', `ЛС закрыты у ${u.userId} — пропуск`);
        storage.setLastSent(u.userId, targetIso);
      } else {
        log('WARN', `ЛС ${u.userId}: ${err.message || err}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  log('INFO', `рассылка завершена: отправлено ${sent}, пропущено ${skipped}`);
}

// -------- напоминания за N минут до пары (проверка раз в минуту) --------

const remindersSent = new Set(); // `${uid}|${iso}|${startMin}`

async function reminderTick() {
  const users = storage.subscribers().filter((u) => u.reminderMinutes > 0);
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
      const dedup = `${u.userId}|${todayIso}|${startMin}`;
      if (remindersSent.has(dedup)) continue;
      remindersSent.add(dedup);
      try {
        const user = await client.users.fetch(u.userId);
        const where = r.room ? `, ауд. ${r.room}` : '';
        const who = subj.kind === 'teacher' && r.groupsText ? ` — ${r.groupsText}` : '';
        await user.send({
          content: `⏰ Через ${u.reminderMinutes} мин пара: **${r.subject}**${where}${who} (в ${r.start})`,
        });
      } catch (err) {
        if (!(err && err.code === 50007)) log('WARN', `напоминание ${u.userId}: ${err.message || err}`);
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

  const subs = storage.subscribers();
  for (const { key, group: sk, iso } of entries) {
    const target = D.partsFromIso(iso);
    if (!target) continue;
    const affected = subs.filter((u) => {
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
    storage.setDigest(key, hash, iso);
    log('INFO', `расписание изменилось: ${sk} на ${iso}, уведомляю ${affected.length}`);

    for (const u of affected) {
      try {
        const data = buildDayData(csvText, subjOf(u), target, { showGaps: u.showGaps });
        const body = menu.scheduleMessage(data, humanUrl, u.format);
        const user = await client.users.fetch(u.userId);
        await user.send({ content: `⚠️ Расписание на ${D.fmtDM(target)} обновилось:` });
        await user.send(body);
      } catch (err) {
        if (!(err && err.code === 50007)) log('WARN', `уведомление об изменении ${u.userId}: ${err.message || err}`);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

// --------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  log('ERROR', `unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});

client.login(cfg.token);
