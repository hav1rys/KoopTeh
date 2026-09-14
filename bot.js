'use strict';

// Единая точка входа: Discord- и Telegram-боты в одном процессе, на одном
// сервисе BotHost. Каждый бот — обычный CommonJS-модуль (index.js / telegramBot.js),
// который сам логинится и стартует свои таймеры при требовании (require) — здесь
// он просто подключается. Раз это один процесс, storage.js (и его users.json)
// тоже один и тот же на обоих ботов — Node кеширует модуль по пути, так что
// require('./storage') из index.js и из telegramBot.js возвращает один и тот же
// объект с данными. Именно это и даёт связывание аккаунтов (/связать) работать
// мгновенно, без каких-либо межпроцессных гонок.
//
// Каждый бот включается своим токеном: пусто — не стартует (можно держать
// только Discord, только Telegram, или оба сразу).

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
