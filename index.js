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

// --------------------------------------------------------------------------
// Логи
// --------------------------------------------------------------------------

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const MIN_LEVEL = LEVELS[cfg.logLevel] ?? 20;

function log(level, msg) {
  if ((LEVELS[level] ?? 20) < MIN_LEVEL) return;
  const line = `${new Date().toISOString()} ${level} ${msg}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

// --------------------------------------------------------------------------
// Вспомогательное
// --------------------------------------------------------------------------

/** Эффективные настройки пользователя (с подстановкой значений по умолчанию). */
function effState(uid) {
  const s = storage.get(uid);
  return {
    group: s.group,
    subscribed: s.subscribed,
    time: s.time || cfg.defaultTime,
    customTime: Boolean(s.time),
    days: Array.isArray(s.days) ? s.days : cfg.defaultDays,
    showGaps: s.showGaps,
  };
}

const notPublishedText = (t) =>
  `Расписание на ${ss.fmtDM(t)} (${ss.weekdayRu(t)}) ещё не опубликовано на сайте.`;

/** @returns {{ data: object|null, url: string|null, error: string|null }} */
async function safeSchedule(group, target, showGaps) {
  try {
    const r = await ss.getSchedule(group, target, { showGaps });
    return { data: r.data, url: r.humanUrl, error: null };
  } catch (err) {
    if (err instanceof ss.NotPublishedError) return { data: null, url: null, error: notPublishedText(target) };
    log('WARN', `расписание (${group}, ${ss.fmtDMY(target)}): ${err.message}`);
    return { data: null, url: null, error: 'Не удалось получить расписание, попробуй позже.' };
  }
}

/** Отправляет расписание отдельным сообщением-эмбедом (снимок, без навигации). */
async function sendScheduleSnapshot(interaction, group, target, showGaps) {
  await interaction.deferReply();
  const { data, url, error } = await safeSchedule(group, target, showGaps);
  if (error) {
    await interaction.editReply({ content: error, embeds: [] });
    return;
  }
  await interaction.editReply(menu.scheduleEmbed(data, url));
}

// uid -> список групп (для листания без повторной загрузки)
const groupCache = new Map();

async function groupsFor(uid) {
  if (groupCache.has(uid)) return groupCache.get(uid);
  const list = await ss.listAllGroups();
  groupCache.set(uid, list);
  return list;
}

// --------------------------------------------------------------------------
// Discord client
// --------------------------------------------------------------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
});

client.once(Events.ClientReady, async (c) => {
  log('INFO', `вошёл как ${c.user.tag} (id ${c.user.id})`);
  await registerCommands(c);
  startScheduler();
});

async function registerCommands(c) {
  const base = () =>
    new SlashCommandBuilder().setName('start').setDescription('Меню расписания и настроек');

  if (cfg.guildId) {
    try {
      await c.application.commands.set([base().toJSON()], cfg.guildId);
      log('INFO', `команда /start зарегистрирована на сервере ${cfg.guildId} (режим отладки)`);
    } catch (err) {
      log('ERROR', `не удалось зарегистрировать /start на сервере ${cfg.guildId}: ${err.message}`);
    }
    return;
  }

  try {
    const command = base()
      .setContexts([
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel,
        InteractionContextType.Guild,
      ])
      .setIntegrationTypes([
        ApplicationIntegrationType.UserInstall,
        ApplicationIntegrationType.GuildInstall,
      ])
      .toJSON();
    await c.application.commands.set([command]);
    log('INFO', 'команда /start зарегистрирована глобально (ЛС + User Install; прогрузка до ~1 часа)');
  } catch (err) {
    log('WARN', `регистрация с User Install не удалась (${err.message}); пробую обычную глобальную`);
    try {
      await c.application.commands.set([base().toJSON()]);
      log('INFO', 'команда /start зарегистрирована глобально (обычная; прогрузка до ~1 часа)');
    } catch (err2) {
      log('ERROR', `не удалось зарегистрировать /start: ${err2.message}`);
    }
  }
}

// --------------------------------------------------------------------------
// Роутинг взаимодействий
// --------------------------------------------------------------------------

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'start') {
      await interaction.reply(menu.buildMenu(effState(interaction.user.id)));
      return;
    }
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('menu:')) return await onMenuButton(interaction);
      if (id.startsWith('grp:')) return await onGroupButton(interaction);
      if (id.startsWith('sch:')) return await onScheduleButton(interaction);
      if (id.startsWith('days:')) return await onDaysButton(interaction);
      if (id.startsWith('ans:')) return await onAnswerButton(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'grp:pick') {
      return await onGroupSelect(interaction);
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

async function onMenuButton(interaction) {
  const action = interaction.customId.slice('menu:'.length);
  const uid = interaction.user.id;
  const s = effState(uid);

  switch (action) {
    case 'setgroup': {
      await interaction.deferUpdate();
      let view;
      try {
        const list = await ss.listAllGroups();
        groupCache.set(uid, list);
        view = list.length
          ? menu.buildGroupPicker(list, 0)
          : menu.buildGroupPicker([], 0, { error: 'Сайт не отдал список групп. Введи название вручную.' });
      } catch (err) {
        log('WARN', `список групп: ${err.message}`);
        view = menu.buildGroupPicker([], 0, {
          error: 'Не удалось загрузить список групп с сайта. Введи название вручную.',
        });
      }
      await interaction.editReply(view);
      return;
    }
    case 'schedule': {
      await interaction.deferUpdate();
      const isoStr = D.iso(D.tomorrowParts());
      const { data, url, error } = await safeSchedule(s.group, D.partsFromIso(isoStr), s.showGaps);
      await interaction.editReply(menu.buildScheduleView(data, isoStr, url, error));
      return;
    }
    case 'now':
      if (!s.group) {
        await interaction.reply({ content: 'Сначала укажи группу.' });
        return;
      }
      await sendScheduleSnapshot(interaction, s.group, D.tomorrowParts(), s.showGaps);
      return;
    case 'togglesub': {
      storage.setSubscribed(uid, !s.subscribed);
      log('INFO', `${uid}: рассылка -> ${!s.subscribed ? 'вкл' : 'выкл'}`);
      await interaction.update(menu.buildMenu(effState(uid)));
      return;
    }
    case 'time':
      await interaction.showModal(menu.timeModal(storage.get(uid).time));
      return;
    case 'days':
      await interaction.update(menu.buildDaysView(s.days));
      return;
    case 'togglegaps':
      storage.setShowGaps(uid, !s.showGaps);
      await interaction.update(menu.buildMenu(effState(uid)));
      return;
    case 'ask':
      await interaction.showModal(menu.askModal());
      return;
    case 'refresh':
      await interaction.update(menu.buildMenu(effState(uid)));
      return;
    default:
      return;
  }
}

async function onGroupButton(interaction) {
  const uid = interaction.user.id;
  const rest = interaction.customId.slice('grp:'.length);

  if (rest === 'cancel') {
    await interaction.update(menu.buildMenu(effState(uid)));
    return;
  }
  if (rest === 'manual') {
    await interaction.showModal(menu.groupModal(storage.get(uid).group));
    return;
  }
  if (rest.startsWith('page:')) {
    const page = Number(rest.slice('page:'.length)) || 0;
    await interaction.deferUpdate();
    let list;
    try {
      list = await groupsFor(uid);
    } catch (err) {
      log('WARN', `список групп: ${err.message}`);
      await interaction.editReply(menu.buildGroupPicker([], 0, { error: 'Не удалось загрузить список групп.' }));
      return;
    }
    await interaction.editReply(menu.buildGroupPicker(list, page));
  }
}

async function onGroupSelect(interaction) {
  const uid = interaction.user.id;
  const group = interaction.values[0];
  storage.setGroup(uid, group);
  log('INFO', `${uid} выбрал группу "${group}"`);
  await interaction.update(menu.buildMenu(effState(uid)));
}

async function onScheduleButton(interaction) {
  const uid = interaction.user.id;
  const rest = interaction.customId.slice('sch:'.length);
  const s = effState(uid);

  if (rest === 'menu') {
    await interaction.update(menu.buildMenu(s));
    return;
  }

  // Снимок отдельным сообщением
  if (rest.startsWith('send:')) {
    const t = D.partsFromIso(rest.slice('send:'.length));
    if (!t || !s.group) return;
    await sendScheduleSnapshot(interaction, s.group, t, s.showGaps);
    return;
  }

  // Определяем целевую дату
  let target = null;
  if (rest === 'jump:today') target = D.todayParts();
  else if (rest === 'jump:tomorrow') target = D.tomorrowParts();
  else if (rest.startsWith('prev:') || rest.startsWith('next:')) {
    const base = D.partsFromIso(rest.slice(5));
    if (base) target = D.shiftParts(base, rest.startsWith('prev:') ? -1 : 1);
  }
  if (!target) return;

  if (!s.group) {
    await interaction.reply({ content: 'Сначала укажи группу в меню (/start).' });
    return;
  }
  await interaction.deferUpdate();
  const { data, url, error } = await safeSchedule(s.group, target, s.showGaps);
  await interaction.editReply(menu.buildScheduleView(data, D.iso(target), url, error));
}

async function onDaysButton(interaction) {
  const uid = interaction.user.id;
  const rest = interaction.customId.slice('days:'.length);

  if (rest === 'done') {
    await interaction.update(menu.buildMenu(effState(uid)));
    return;
  }
  if (rest.startsWith('toggle:')) {
    const isoDay = Number(rest.slice('toggle:'.length));
    if (!(isoDay >= 1 && isoDay <= 7)) return;
    const cur = new Set(effState(uid).days);
    if (cur.has(isoDay)) cur.delete(isoDay);
    else cur.add(isoDay);
    const next = [...cur].sort((a, b) => a - b);
    storage.setDays(uid, next);
    await interaction.update(menu.buildDaysView(next));
  }
}

async function onAnswerButton(interaction) {
  const qid = interaction.customId.slice('ans:'.length);
  if (interaction.user.id !== cfg.adminId) {
    await interaction.reply({ content: 'Эта кнопка не для тебя.' });
    return;
  }
  const q = storage.getQuestion(qid);
  if (!q) {
    await interaction.reply({ content: 'Вопрос не найден или на него уже ответили.' });
    return;
  }
  await interaction.showModal(menu.answerModal(qid, q.topic));
}

async function onModal(interaction) {
  const uid = interaction.user.id;
  const id = interaction.customId;

  if (id === 'modal:setgroup') {
    const group = interaction.fields.getTextInputValue('group').trim();
    if (!group) {
      await interaction.reply({ content: 'Пустое название группы.' });
      return;
    }
    storage.setGroup(uid, group);
    log('INFO', `${uid} ввёл группу "${group}"`);
    await sendMenu(interaction, uid);
    return;
  }

  if (id === 'modal:time') {
    const raw = interaction.fields.getTextInputValue('time').trim();
    if (!raw) {
      storage.setTime(uid, null);
      await sendMenu(interaction, uid);
      return;
    }
    const hhmm = D.parseHHMM(raw);
    if (!hhmm) {
      await interaction.reply({ content: 'Неверный формат времени. Нужно ЧЧ:ММ, например 18:30.' });
      return;
    }
    storage.setTime(uid, hhmm);
    log('INFO', `${uid} время рассылки -> ${hhmm}`);
    await sendMenu(interaction, uid);
    return;
  }

  if (id === 'modal:ask') {
    const topic = interaction.fields.getTextInputValue('topic').trim() || 'Без темы';
    const question = interaction.fields.getTextInputValue('question').trim();
    if (!question) {
      await interaction.reply({ content: 'Пустой вопрос.' });
      return;
    }
    const qid = storage.addQuestion(uid, interaction.user.tag, topic, question);
    try {
      const admin = await client.users.fetch(cfg.adminId);
      await admin.send(menu.adminQuestionMessage(storage.getQuestion(qid), qid));
      log('INFO', `вопрос ${qid} от ${uid} отправлен администратору`);
      await interaction.reply({
        content: '✅ Вопрос отправлен. Ответ придёт тебе сюда, в личные сообщения.',
      });
    } catch (err) {
      storage.deleteQuestion(qid);
      log('ERROR', `не доставить вопрос администратору: ${err.message}`);
      await interaction.reply({
        content: 'Не удалось доставить вопрос администратору. Попробуй позже.',
      });
    }
    return;
  }

  if (id.startsWith('modal:answer:')) {
    const qid = id.slice('modal:answer:'.length);
    const q = storage.getQuestion(qid);
    if (!q) {
      await interaction.reply({ content: 'Вопрос не найден или на него уже ответили.' });
      return;
    }
    const answer = interaction.fields.getTextInputValue('answer').trim();
    if (!answer) {
      await interaction.reply({ content: 'Пустой ответ.' });
      return;
    }
    try {
      const asker = await client.users.fetch(q.askerId);
      await asker.send(menu.answerMessage(q, answer));
      storage.deleteQuestion(qid);
      log('INFO', `ответ на вопрос ${qid} доставлен пользователю ${q.askerId}`);
      await interaction.reply({ content: '✅ Ответ отправлен пользователю.' });
      tryDisableButton(interaction);
    } catch (err) {
      if (err && err.code === 50007) {
        await interaction.reply({
          content: 'У пользователя закрыты личные сообщения — ответ не доставлен. Вопрос остаётся открытым.',
        });
      } else {
        log('ERROR', `не доставить ответ на ${qid}: ${err.message}`);
        await interaction.reply({ content: 'Не удалось отправить ответ. Попробуй ещё раз.' });
      }
    }
    return;
  }
}

/** После модалки: обновить меню на месте, если модалка была вызвана из сообщения. */
async function sendMenu(interaction, uid) {
  const view = menu.buildMenu(effState(uid));
  if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(view);
  else await interaction.reply(view);
}

function tryDisableButton(interaction) {
  try {
    if (interaction.isFromMessage && interaction.isFromMessage() && interaction.message) {
      interaction.message.edit({ components: [] }).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

// --------------------------------------------------------------------------
// Ежедневная рассылка (у каждого своё время и свои дни)
// --------------------------------------------------------------------------

let broadcasting = false;

function startScheduler() {
  log(
    'INFO',
    `рассылка: у каждого своё время; по умолчанию ${cfg.defaultTime} ${cfg.timezone}, ` +
      `дни по умолчанию [${cfg.defaultDays.join(',')}]`,
  );
  setInterval(tick, 60 * 1000);
  tick();
}

async function tick() {
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
    if (u.lastSent === targetIso) return false;
    return true;
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
    const url = await ss.resolveSheetUrl(cfg.calendarUrl, target);
    csvText = await ss.downloadCsv(url);
    humanUrl = ss.humanSheetUrl(url);
  } catch (err) {
    if (err instanceof ss.NotPublishedError) notPublished = true;
    else {
      sourceFailed = true;
      log('WARN', `рассылка: источник недоступен: ${err.message}`);
    }
  }

  const cache = new Map();
  let sent = 0;
  let skipped = 0;

  for (const u of due) {
    let payload;
    if (notPublished) payload = { content: notPublishedText(target) };
    else if (sourceFailed || !csvText) payload = { content: 'Не удалось получить расписание, попробую позже.' };
    else {
      const key = `${ss.normGroup(u.group)}|${u.showGaps ? 1 : 0}`;
      if (!cache.has(key)) {
        try {
          const data = ss.buildScheduleData(csvText, u.group, target, { showGaps: u.showGaps });
          cache.set(key, menu.scheduleEmbed(data, humanUrl));
        } catch (err) {
          log('WARN', `рассылка: разбор для "${u.group}": ${err.message}`);
          cache.set(key, { content: 'Не удалось получить расписание, попробую позже.' });
        }
      }
      payload = cache.get(key);
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

// --------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  log('ERROR', `unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});

client.login(cfg.token);
