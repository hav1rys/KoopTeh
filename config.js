'use strict';

require('dotenv').config();

function parseHHMM(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) throw new Error(`BROADCAST_TIME должно быть в формате HH:MM, получено: "${raw}"`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error(`BROADCAST_TIME вне диапазона: "${raw}"`);
  return { hh, mm };
}

module.exports = {
  // Токен проверяется в index.js — так scheduleSource.js можно запускать отдельно без него.
  token: process.env.DISCORD_BOT_TOKEN || '',
  calendarUrl: process.env.CALENDAR_URL || 'https://koopteh10.ru/student/lessons/',
  timezone: process.env.TIMEZONE || 'Europe/Moscow',
  broadcast: parseHHMM(process.env.BROADCAST_TIME || '19:00'),
  dataFile: process.env.DATA_FILE || 'data/users.json',
  guildId: (process.env.GUILD_ID || '').trim() || null,
  httpTimeout: Math.max(1, Number(process.env.HTTP_TIMEOUT || 20)) * 1000,
  logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),
};
