'use strict';

const path = require('path');

require('dotenv').config();

// Куда класть хранилище пользователей.
// Приоритет: DATA_FILE (полный путь) > DATA_DIR/users.json (BotHost монтирует
// сюда постоянный volume) > ./data/users.json (локально).
function resolveDataFile() {
  if (process.env.DATA_FILE) return process.env.DATA_FILE;
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, 'users.json');
  return 'data/users.json';
}

function parseHHMM(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) throw new Error(`BROADCAST_TIME должно быть в формате HH:MM, получено: "${raw}"`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error(`BROADCAST_TIME вне диапазона: "${raw}"`);
  return { hh, mm };
}

function positiveNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function validateTimezone(tz) {
  try {
    // Бросит RangeError, если пояс неизвестен.
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    throw new Error(`Неизвестный TIMEZONE: "${tz}" (нужен IANA-идентификатор, напр. Europe/Moscow)`);
  }
}

module.exports = {
  // Токен проверяется в index.js — так scheduleSource.js можно запускать отдельно без него.
  token: process.env.DISCORD_BOT_TOKEN || '',
  calendarUrl: process.env.CALENDAR_URL || 'https://koopteh10.ru/student/lessons/',
  timezone: validateTimezone(process.env.TIMEZONE || 'Europe/Moscow'),
  broadcast: parseHHMM(process.env.BROADCAST_TIME || '19:00'),
  dataFile: resolveDataFile(),
  guildId: (process.env.GUILD_ID || '').trim() || null,
  httpTimeout: positiveNumber(process.env.HTTP_TIMEOUT, 20) * 1000,
  logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),
};
