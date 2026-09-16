'use strict';

// Общий отправщик логов в Discord-каналы — используется ОБОИМИ ботами (Discord
// и Telegram, потом и VK), поэтому реализован через голый REST-запрос к Discord
// API (Authorization: Bot <токен>), а не через discord.js Client: так это
// работает независимо от того, поднят ли в этом процессе именно Discord-клиент.
//
// Категория канала определяется по эмодзи в начале текста — та же идея, что
// раньше была в LOG_COLOR_BY_EMOJI (эмодзи -> цвет эмбеда), только теперь эмодзи
// определяет ещё и КАКОЙ из 4 каналов категории получит сообщение:
//   действия (actions)     — регистрация, смена группы/роли, подписка, админ-действия,
//                             запросы расписания, запуск/остановка
//   отправки (broadcasts)  — итоговая статистика по ежедневной рассылке расписаний
//   ошибки (errors)        — WARN/ERROR, необработанные исключения, health-алерты
//   вопросы (questions)    — вопрос из «❓ Задать вопрос», С КНОПКОЙ «Ответить»:
//                             клик обрабатывает Discord-бот (index.js, тот же
//                             ans:<qid> / answerModal, что и для его собственных
//                             вопросов) — работает независимо от того, откуда
//                             сообщение с кнопкой было отправлено (REST здесь
//                             или client.send в index.js), т.к. кнопки Discord
//                             привязаны к приложению-боту, а не к отправителю
//                             сообщения. Ответ доставляется обратно через
//                             platformBridge.js, если вопрос пришёл не с Discord.

const cfg = require('./config');

const LOG_META_BY_EMOJI = [
  ['🆕', 0x2f9e44, 'actions'], // регистрация
  ['🔄', 0x2b6cb0, 'actions'], // смена группы/фамилии
  ['👤', 0x2b6cb0, 'actions'], // роль
  ['🔔', 0x1098ad, 'actions'], // подписка
  ['📢', 0xd9a441, 'actions'], // объявление
  ['🕓', 0xd9a441, 'actions'], // отложенное объявление (создание и отправка — "🕓✅" тоже сюда)
  ['🛠', 0xd9a441, 'actions'], // админ
  ['📨', 0x7048e8, 'broadcasts'], // ежедневная рассылка
  ['📋', 0x495057, 'actions'], // запросы расписания
  ['🚀', 0x5865f2, 'actions'], // запуск
  ['🛑', 0xe03131, 'actions'], // остановка
  ['⚠️', 0xe03131, 'errors'], // ошибки/алерты
  ['❓', 0x1098ad, 'questions'], // вопрос администратору
];

function metaFor(text) {
  const firstLine = String(text).split('\n')[0] || '';
  const found = LOG_META_BY_EMOJI.find(([emoji]) => firstLine.startsWith(emoji));
  return { color: found ? found[1] : 0x5865f2, category: found ? found[2] : 'actions' };
}

/** platform: 'discord' | 'telegram' | 'vk'. Категория и цвет — по эмодзи в начале текста. */
async function send(platform, text) {
  const { color, category } = metaFor(text);
  const channelId = cfg.logChannels[category] && cfg.logChannels[category][platform];
  if (!channelId || !cfg.token) return;
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{ description: String(text).slice(0, 4000), color, timestamp: new Date().toISOString() }],
      }),
    });
    if (!res.ok) console.error(`лог (${category}/${platform}): HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  } catch (err) {
    console.error(`лог (${category}/${platform}): ${err.message}`);
  }
}

/** Как send(), но добавляет кнопку «Ответить» (custom_id: ans:<qid>) — для канала «вопросы». */
async function sendQuestion(platform, text, qid) {
  const channelId = cfg.logChannels.questions && cfg.logChannels.questions[platform];
  if (!channelId || !cfg.token) return;
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{ description: String(text).slice(0, 4000), color: 0x1098ad, timestamp: new Date().toISOString() }],
        components: [
          {
            type: 1,
            components: [{ type: 2, style: 1, label: 'Ответить', custom_id: `ans:${qid}` }],
          },
        ],
      }),
    });
    if (!res.ok) console.error(`лог (questions/${platform}): HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  } catch (err) {
    console.error(`лог (questions/${platform}): ${err.message}`);
  }
}

module.exports = { send, sendQuestion };
