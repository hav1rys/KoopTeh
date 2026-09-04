'use strict';

// Разворачивание структуры сервера под учебные группы:
// роль (с отдельным отображением) + приватная категория + каналы.
// Идемпотентно: повторный запуск не создаёт дубли, а лишь чинит права.

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const campus = require('./campus');

const TEXT_CHANNELS = ['📜расписание', '📘дз', '📢новости', '✏️чат'];
const VOICE_CHANNELS = ['🔉Голосовой 1', '🔉Голосовой 2'];

const COMMON_CATEGORY = 'Общие';
// только чтение для @everyone
const COMMON_READONLY = [
  '📢объявления',
  '🔔звонки',
  '📌правила',
  '📰новости-техникума',
  '❓помощь-по-боту',
  '📚материалы',
  '🎓поступающим',
  '🗺️карта-техникума',
];
const COMMON_TEXT = ['💬общий-чат', '🤖команды-бота', '🎲оффтоп', '🎫поддержка', '📅мероприятия'];
const COMMON_VOICE = ['🔊Общий'];

const COURSE_ROLES = ['1 курс', '2 курс', '3 курс', '4 курс'];
// Бот-управляемые роли (выдаются/снимаются автоматически).
const AUTO_ROLES = ['Преподаватель', 'Гость'];
// Ручные роли — создаём, права/назначение настраивает админ.
const MANUAL_ROLES = ['Администрация', 'Куратор', 'Староста', 'Модератор', 'Выпускник', 'Абитуриент'];
const NO_HOIST = new Set(['Гость']);

// Каналы, доступ к отправке в которые настраивается через /admin → «Доступ к каналам».
const MANAGED_ACCESS = [/новости-техникума/i, /объявлени/i, /поступающим/i, /мероприяти/i, /материал/i];

// Стартовые сообщения (постятся один раз при setup).
const STARTERS = [
  [/новости-техникума/i, '📰 **Новости техникума**\nЗдесь публикуются новости. Писать могут только назначенные роли — настраивается в `/admin` → «Доступ к каналам».'],
  [/объявлени/i, '📢 **Объявления**\nОфициальные объявления. Право писать выдаётся ролям через `/admin` → «Доступ к каналам».'],
  [/поступающим/i, '🎓 **Поступающим**\nИнформация для абитуриентов: специальности, документы, сроки. Вопросы — в `🎫поддержка`.'],
  [/мероприяти/i, '📅 **Мероприятия**\nАнонсы и обсуждение мероприятий техникума.'],
  [/материал/i, '📚 **Материалы**\nПолезные ссылки, методички, шаблоны.'],
  [/правила/i, '📌 **Правила сервера**\n1. Уважайте друг друга. 2. Без спама и рекламы. 3. Мат и токсичность — бан. 4. По группам общаемся в своих каналах.'],
];

const PALETTE = [
  0x5865f2, 0x57f287, 0xfee75c, 0xeb459e, 0xed4245, 0x1abc9c, 0xe67e22, 0x9b59b6, 0x3498db, 0x2ecc71,
  0xe74c3c, 0xf1c40f, 0x11806a, 0x71368a, 0xa84300, 0x992d22,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chanSlug = (n) => n.toLowerCase().replace(/\s+/g, '-');
// «имя без ведущих эмодзи/пробелов», нижним регистром, для сопоставления при повторном запуске
const bareName = (n) =>
  String(n)
    .replace(/^(?:\p{Extended_Pictographic}|[️‍\s])+/u, '')
    .toLowerCase()
    .replace(/\s+/g, '-');

function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

async function ensureRole(guild, name) {
  const existing = guild.roles.cache.find((r) => r.name === name);
  if (existing) return existing;
  return guild.roles.create({
    name,
    hoist: true,
    mentionable: false,
    color: colorFor(name),
    permissions: [],
    reason: `Роль учебной группы ${name}`,
  });
}

async function ensureCategory(guild, name, roleId, botId) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
    {
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.Connect,
      ],
    },
  ];
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === name,
  );
  if (existing) {
    await existing.permissionOverwrites.set(overwrites).catch(() => {});
    return existing;
  }
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
    reason: `Категория учебной группы ${name}`,
  });
}

async function ensureChannel(guild, parent, name, type, sync = true) {
  const want = type === ChannelType.GuildText ? chanSlug(name) : name;
  const bare = bareName(name);
  const existing = guild.channels.cache.find(
    (c) =>
      c.parentId === parent.id &&
      c.type === type &&
      (c.name === want || c.name === name || bareName(c.name) === bare),
  );
  if (existing) {
    if (existing.name !== want) await existing.setName(want).catch(() => {});
    if (sync) await existing.lockPermissions().catch(() => {});
    return existing;
  }
  const ch = await guild.channels.create({
    name,
    type,
    parent: parent.id,
    reason: `Канал в категории ${parent.name}`,
  });
  if (sync) await ch.lockPermissions().catch(() => {});
  return ch;
}

async function postOnce(channel, marker, text) {
  try {
    const recent = await channel.messages.fetch({ limit: 10 });
    const mine = recent.find((m) => m.author.id === channel.client.user.id && m.content.includes(marker));
    if (mine) return;
    await channel.send({ content: text });
  } catch {
    /* нет прав на чтение истории — пропускаем */
  }
}

async function ensureCommonCategory(guild) {
  let cat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === COMMON_CATEGORY,
  );
  if (!cat) {
    cat = await guild.channels.create({
      name: COMMON_CATEGORY,
      type: ChannelType.GuildCategory,
      reason: 'Общая категория',
    });
    await sleep(350);
  }
  const everyone = guild.roles.everyone.id;
  for (const n of [...COMMON_READONLY, ...COMMON_TEXT]) {
    const ch = await ensureChannel(guild, cat, n, ChannelType.GuildText, false);
    await ch.permissionOverwrites
      .edit(everyone, {
        ViewChannel: true,
        SendMessages: COMMON_READONLY.includes(n) ? false : null,
        AddReactions: COMMON_READONLY.includes(n) ? false : null,
      })
      .catch(() => {});
    if (/карта/i.test(ch.name)) {
      await postOnce(ch, 'Карта техникума', campus.MAP_TEXT);
    } else {
      const st = STARTERS.find(([re]) => re.test(ch.name));
      if (st) await postOnce(ch, st[1].slice(0, 24), st[1]);
    }
    await sleep(350);
  }
  for (const n of COMMON_VOICE) {
    await ensureChannel(guild, cat, n, ChannelType.GuildVoice, false);
    await sleep(350);
  }
  return cat;
}

async function ensureBaseRoles(guild) {
  for (const name of [...COURSE_ROLES, ...AUTO_ROLES, ...MANUAL_ROLES]) {
    if (guild.roles.cache.some((r) => r.name === name)) continue;
    await guild.roles.create({
      name,
      hoist: !NO_HOIST.has(name),
      mentionable: true,
      permissions: [],
      reason: 'Базовая роль сервера',
    });
    await sleep(350);
  }
}

async function provisionGroup(guild, botId, group) {
  const role = await ensureRole(guild, group);
  await sleep(350);
  const cat = await ensureCategory(guild, group, role.id, botId);
  await sleep(350);
  for (const n of TEXT_CHANNELS) {
    await ensureChannel(guild, cat, n, ChannelType.GuildText);
    await sleep(350);
  }
  for (const n of VOICE_CHANNELS) {
    await ensureChannel(guild, cat, n, ChannelType.GuildVoice);
    await sleep(350);
  }
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {string} botId
 * @param {string[]} groups
 * @param {(done:number,total:number,errors:string[])=>Promise<void>} [onProgress]
 */
async function provision(guild, botId, groups, onProgress, { common = true } = {}) {
  await guild.roles.fetch().catch(() => {});
  await guild.channels.fetch().catch(() => {});

  const errors = [];
  if (common) {
    try {
      await ensureBaseRoles(guild);
      await ensureCommonCategory(guild);
    } catch (e) {
      errors.push(`Общие: ${e.message || e}`);
    }
  }

  let done = 0;
  for (const g of groups) {
    try {
      await provisionGroup(guild, botId, g);
    } catch (e) {
      errors.push(`${g}: ${e.message || e}`);
    }
    done += 1;
    if (onProgress && (done % 3 === 0 || done === groups.length)) {
      await onProgress(done, groups.length, errors).catch(() => {});
    }
  }
  return { done, errors };
}

// ---- Доступ к отправке в каналы (для /admin) --------------------

/** Каналы категории «Общие», доступ к которым настраивается. */
function managedChannels(guild) {
  return [...guild.channels.cache.values()].filter(
    (c) => c.type === ChannelType.GuildText && MANAGED_ACCESS.some((re) => re.test(c.name)),
  );
}

/** ID ролей, которым сейчас явно разрешено писать в канал. */
function currentPosters(channel) {
  const everyone = channel.guild.roles.everyone.id;
  return [...channel.permissionOverwrites.cache.values()]
    .filter((ow) => ow.id !== everyone && ow.type === 0 && ow.allow.has(PermissionFlagsBits.SendMessages))
    .map((ow) => ow.id);
}

/** Выдать право писать перечисленным ролям, снять у остальных (кроме @everyone). */
async function setChannelPosters(channel, roleIds) {
  const wanted = new Set(roleIds.map(String));
  for (const rid of wanted) {
    await channel.permissionOverwrites
      .edit(rid, { ViewChannel: true, SendMessages: true, AddReactions: true })
      .catch(() => {});
  }
  for (const [id, ow] of channel.permissionOverwrites.cache) {
    if (id === channel.guild.roles.everyone.id || ow.type !== 0 || wanted.has(id)) continue;
    if (ow.allow.has(PermissionFlagsBits.SendMessages)) {
      await channel.permissionOverwrites.edit(id, { SendMessages: null, AddReactions: null }).catch(() => {});
    }
  }
}

module.exports = {
  provision,
  managedChannels,
  currentPosters,
  setChannelPosters,
  TEXT_CHANNELS,
  VOICE_CHANNELS,
};
