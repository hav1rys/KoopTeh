'use strict';

const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  ApplicationIntegrationType,
  InteractionContextType,
} = require('discord.js');

const cfg = require('./config');
const D = require('./dates');
const storage = require('./storage');
const ss = require('./scheduleSource');
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
  };
}

/** Меню с виджетом «ближайшая рассылка». */
function menuView(uid) {
  const s = effState(uid);
  const nb = s.subj && s.subscribed ? D.nextBroadcast(s.days, s.time) : null;
  return menu.buildMenu(s, { nextBroadcastEpoch: nb });
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

// -------------------------------------------------------------------- клиент

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

client.once(Events.ClientReady, async (c) => {
  log('INFO', `вошёл как ${c.user.tag} (id ${c.user.id})`);
  await registerCommands(c);
  startSchedulers();
});

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
    // запасной вариант: если кириллические имена отклонены — оставляем базовые
    ['/start и /admin', () => commandDefs().filter((b) => /^(start|admin)$/.test(b.name)).map((b) => ctx(b).toJSON())],
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
      if (id.startsWith('days:')) return await onDaysButton(interaction);
      if (id.startsWith('rem:')) return await onReminderButton(interaction);
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
    return;
  }

  if (name === 'admin') {
    if (!storage.isAdmin(uid)) return void (await interaction.reply({ content: 'Нет доступа.' }));
    await interaction.reply(menu.buildAdminMenu());
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
  }
}

async function onDaysButton(interaction) {
  const uid = interaction.user.id;
  const rest = interaction.customId.slice('days:'.length);
  if (rest === 'done') return void (await interaction.update(menuView(uid)));
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
  if (rest === 'done') return void (await interaction.update(menuView(uid)));
  if (rest.startsWith('set:')) {
    const n = Number(rest.slice('set:'.length));
    if (!menu.REMINDER_OPTS.includes(n)) return;
    storage.setReminder(uid, n);
    await interaction.update(menu.buildReminderView(n));
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
    return void (await sendMenu(interaction, uid));
  }

  if (id === 'modal:setteacher') {
    const surname = interaction.fields.getTextInputValue('surname').trim();
    storage.setTeacherName(uid, surname || null);
    if (surname) storage.setRole(uid, 'teacher');
    else if (storage.get(uid).role === 'teacher') storage.setRole(uid, 'student');
    log('INFO', `${uid} режим преподавателя: "${surname || '—'}"`);
    const view = menu.buildRoleView(effState(uid));
    if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
    else await interaction.reply(view);
    return;
  }

  if (id === 'modal:time') {
    const raw = interaction.fields.getTextInputValue('time').trim();
    if (!raw) {
      storage.setTime(uid, null);
      return void (await sendMenu(interaction, uid));
    }
    const hhmm = D.parseHHMM(raw);
    if (!hhmm) return void (await interaction.reply({ content: 'Неверный формат. Нужно ЧЧ:ММ, например 18:30.' }));
    storage.setTime(uid, hhmm);
    return void (await sendMenu(interaction, uid));
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
  setInterval(reminderTick, 60 * 1000);
  setInterval(changeTick, 15 * 60 * 1000);
  broadcastTick();
}

async function broadcastTick() {
  if (broadcasting) return;
  const now = D.tzNow();
  const hhmm = `${D.pad(now.h)}:${D.pad(now.mi)}`;
  const target = D.tomorrowParts();
  const targetIso = D.iso(target);
  const dow = D.weekdayIso(target);

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
      else {
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
