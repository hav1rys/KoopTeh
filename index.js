'use strict';

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');

const cfg = require('./config');
const storage = require('./storage');
const ss = require('./scheduleSource');
const { buildMenu, groupModal, dateModal } = require('./menu');

if (!cfg.token) {
  console.error('DISCORD_BOT_TOKEN не задан. Скопируй .env.example в .env и впиши токен.');
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
// Даты в целевом часовом поясе
// --------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

function tzNow(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return {
    y: +p.year,
    mo: +p.month,
    d: +p.day,
    h: +(p.hour === '24' ? 0 : p.hour),
    mi: +p.minute,
  };
}

function tomorrow() {
  const n = tzNow(cfg.timezone);
  const dt = new Date(Date.UTC(n.y, n.mo - 1, n.d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function normDate(y, mo, d) {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, mo, d };
}

/** "дд.мм" или "дд.мм.гггг" -> {y,mo,d} | null. Для "дд.мм" год подбирается. */
function parseDateInput(raw) {
  const s = String(raw).trim();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return normDate(+m[3], +m[2], +m[1]);

  m = /^(\d{1,2})\.(\d{1,2})$/.exec(s);
  if (m) {
    const now = tzNow(cfg.timezone);
    const cand = normDate(now.y, +m[2], +m[1]);
    if (!cand) return null;
    const ord = (o) => o.y * 400 + o.mo * 31 + o.d;
    if (ord(cand) < ord(now) - 40) return normDate(now.y + 1, +m[2], +m[1]);
    return cand;
  }
  return null;
}

const notPublishedText = (t) =>
  `Расписание на ${ss.fmtDM(t)} (${ss.weekdayRu(t)}) ещё не опубликовано на сайте.`;

/** Достаёт текст расписания и мягко обрабатывает ошибки источника. */
async function safeSchedule(group, target) {
  try {
    return await ss.getScheduleText(group, target);
  } catch (err) {
    if (err instanceof ss.NotPublishedError) return notPublishedText(target);
    log('WARN', `не удалось получить расписание (${group}, ${ss.fmtDMY(target)}): ${err.message}`);
    return 'Не удалось получить расписание, попробуй позже.';
  }
}

// --------------------------------------------------------------------------
// Discord client
// --------------------------------------------------------------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
});

client.once(Events.ClientReady, async (c) => {
  log('INFO', `вошёл как ${c.user.tag} (id ${c.user.id})`);

  const command = new SlashCommandBuilder()
    .setName('start')
    .setDescription('Меню расписания: группа, рассылка, расписание по требованию')
    .toJSON();

  try {
    if (cfg.guildId) {
      await c.application.commands.set([command], cfg.guildId);
      log('INFO', `команда /start зарегистрирована на сервере ${cfg.guildId}`);
    } else {
      await c.application.commands.set([command]);
      log('INFO', 'команда /start зарегистрирована глобально (появится в течение ~1 часа)');
    }
  } catch (err) {
    log('ERROR', `не удалось зарегистрировать команду: ${err.message}`);
  }

  startScheduler();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'start') {
      await interaction.reply({
        ...buildMenu(storage.get(interaction.user.id)),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('menu:')) {
      await onButton(interaction);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal:')) {
      await onModal(interaction);
      return;
    }
  } catch (err) {
    log('ERROR', `ошибка обработки взаимодействия: ${err.stack || err}`);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'Что-то пошло не так, попробуй ещё раз.',
          flags: MessageFlags.Ephemeral,
        });
      } else if (interaction.deferred) {
        await interaction.editReply('Что-то пошло не так, попробуй ещё раз.');
      }
    } catch {
      /* ignore */
    }
  }
});

async function onButton(interaction) {
  const action = interaction.customId.slice('menu:'.length);
  const uid = interaction.user.id;
  const state = storage.get(uid);

  if (action === 'setgroup') {
    await interaction.showModal(groupModal(state.group));
    return;
  }

  if (action === 'refresh') {
    await interaction.update(buildMenu(storage.get(uid)));
    return;
  }

  if (action === 'togglesub') {
    if (!state.group) {
      await interaction.reply({ content: 'Сначала укажи группу.', flags: MessageFlags.Ephemeral });
      return;
    }
    storage.setSubscribed(uid, !state.subscribed);
    log('INFO', `пользователь ${uid}: рассылка -> ${!state.subscribed ? 'вкл' : 'выкл'}`);
    await interaction.update(buildMenu(storage.get(uid)));
    return;
  }

  if (action === 'date') {
    if (!state.group) {
      await interaction.reply({ content: 'Сначала укажи группу.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(dateModal());
    return;
  }

  if (action === 'tomorrow') {
    if (!state.group) {
      await interaction.reply({ content: 'Сначала укажи группу.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await safeSchedule(state.group, tomorrow()));
  }
}

async function onModal(interaction) {
  const uid = interaction.user.id;

  if (interaction.customId === 'modal:setgroup') {
    const group = interaction.fields.getTextInputValue('group').trim();
    if (!group) {
      await interaction.reply({ content: 'Пустое название группы.', flags: MessageFlags.Ephemeral });
      return;
    }
    storage.setGroup(uid, group);
    log('INFO', `пользователь ${uid} сохранил группу "${group}"`);
    const view = buildMenu(storage.get(uid));
    if (interaction.isFromMessage()) await interaction.update(view);
    else await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.customId === 'modal:date') {
    const target = parseDateInput(interaction.fields.getTextInputValue('date'));
    if (!target) {
      await interaction.reply({
        content: 'Не понял дату. Формат: дд.мм или дд.мм.гггг.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await safeSchedule(storage.get(uid).group, target));
  }
}

// --------------------------------------------------------------------------
// Ежедневная рассылка
// --------------------------------------------------------------------------

let lastRunKey = null;

function startScheduler() {
  log('INFO', `ежедневная рассылка в ${pad(cfg.broadcast.hh)}:${pad(cfg.broadcast.mm)} ${cfg.timezone}`);
  setInterval(tick, 60 * 1000);
  tick();
}

async function tick() {
  const n = tzNow(cfg.timezone);
  if (n.h !== cfg.broadcast.hh || n.mi !== cfg.broadcast.mm) return;
  const key = `${n.y}-${n.mo}-${n.d}`;
  if (lastRunKey === key) return;
  lastRunKey = key;
  try {
    await runDailyBroadcast();
  } catch (err) {
    log('ERROR', `рассылка упала: ${err.stack || err}`);
  }
}

async function runDailyBroadcast() {
  const subs = storage.subscribers();
  if (!subs.length) {
    log('INFO', 'рассылка: подписчиков нет');
    return;
  }
  const target = tomorrow();
  log('INFO', `рассылка: подписчиков ${subs.length}, дата ${ss.fmtDMY(target)}`);

  // Один свежий запрос на весь прогон: календарь + CSV дня.
  let csvText = null;
  let notPublished = false;
  let sourceFailed = false;
  try {
    const url = await ss.resolveSheetUrl(cfg.calendarUrl, target);
    csvText = await ss.downloadCsv(url);
  } catch (err) {
    if (err instanceof ss.NotPublishedError) notPublished = true;
    else {
      sourceFailed = true;
      log('WARN', `рассылка: источник недоступен: ${err.message}`);
    }
  }

  const perGroup = new Map();
  let sent = 0;
  let skipped = 0;

  for (const { userId, group } of subs) {
    let body;
    if (notPublished) {
      body = notPublishedText(target);
    } else if (sourceFailed || !csvText) {
      body = 'Не удалось получить расписание, попробую позже.';
    } else {
      const key = group.replace(/\s+/g, '').toLowerCase();
      if (perGroup.has(key)) {
        body = perGroup.get(key);
      } else {
        try {
          body = ss.buildScheduleFromCsv(csvText, group, target);
        } catch (err) {
          log('WARN', `рассылка: не разобрать расписание для "${group}": ${err.message}`);
          body = 'Не удалось получить расписание, попробую позже.';
        }
        perGroup.set(key, body);
      }
    }

    try {
      const user = await client.users.fetch(userId);
      await user.send(body);
      sent += 1;
    } catch (err) {
      skipped += 1;
      if (err && err.code === 50007) log('INFO', `ЛС закрыты у ${userId} — пропуск`);
      else log('WARN', `не удалось отправить ЛС ${userId}: ${err.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 1200)); // бережный лимит
  }

  log('INFO', `рассылка завершена: отправлено ${sent}, пропущено ${skipped}`);
}

// --------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  log('ERROR', `unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});

client.login(cfg.token);
