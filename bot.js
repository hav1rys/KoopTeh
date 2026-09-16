'use strict';

// Единая точка входа: Discord-, Telegram- и VK-боты в одном процессе, на одном
// сервисе BotHost. Каждый бот — обычный CommonJS-модуль (index.js / telegramBot.js /
// vkBot.js), который сам логинится и стартует свои таймеры при требовании (require) —
// здесь он просто подключается. Раз это один процесс, storage.js (и его users.json)
// тоже один и тот же на всех ботов — Node кеширует модуль по пути, так что
// require('./storage') из любого из них возвращает один и тот же объект с
// данными. Именно это и даёт связывание аккаунтов (/связать) работать мгновенно,
// без каких-либо межпроцессных гонок.
//
// Каждый бот включается своим токеном: пусто — не стартует (можно держать любое
// подмножество из трёх сразу).

if (process.env.DISCORD_BOT_TOKEN) {
  require('./index.js');
} else {
  console.log('DISCORD_BOT_TOKEN не задан — Discord-бот не запускается.');
}

if (process.env.TELEGRAM_BOT_TOKEN) {
  require('./telegramBot.js');
} else {
  console.log('TELEGRAM_BOT_TOKEN не задан — Telegram-бот не запускается.');
}

if (process.env.VK_BOT_TOKEN) {
  require('./vkBot.js');
} else {
  console.log('VK_BOT_TOKEN не задан — VK-бот не запускается.');
}
