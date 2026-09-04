'use strict';

// Все переменные окружения задаются в панели BotHost (Startup / Variables).
// Файла .env нет и не предполагается.

const path = require('path');

const pad = (n) => String(n).padStart(2, '0');

// Куда класть хранилище пользователей.
// Приоритет: DATA_FILE > DATA_DIR/users.json (постоянный volume BotHost) > ./data/users.json.
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
  return `${pad(hh)}:${pad(mm)}`;
}

// "1,2,3,4,5,6" -> [1,2,3,4,5,6]; мусор -> null (тогда берётся значение по умолчанию)
function parseDays(raw) {
  if (!raw) return null;
  const arr = String(raw)
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  const uniq = [...new Set(arr)].sort((a, b) => a - b);
  return uniq.length ? uniq : null;
}

function positiveNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function validateTimezone(tz) {
  try {
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

  // Значения по умолчанию для персональных настроек пользователя.
  defaultTime: parseHHMM(process.env.BROADCAST_TIME || '19:00'),
  defaultDays: parseDays(process.env.BROADCAST_DAYS) || [1, 2, 3, 4, 5, 6], // Пн–Сб

  // Кому уходят вопросы из кнопки «Задать вопрос».
  adminId: (process.env.ADMIN_ID || '652927337016328212').trim(),

  // gid листа расписания внутри Google-таблицы дня (все дни сделаны из одного
  // шаблона, поэтому gid одинаковый). Пусто -> фолбэк по этому gid отключён.
  scheduleGid:
    process.env.SCHEDULE_GID === undefined ? '1566598279' : String(process.env.SCHEDULE_GID).trim(),

  // Статус бота. BOT_ACTIVITY пусто -> встроенная ротация (расписание / /start / N подписчиков).
  activity: (process.env.BOT_ACTIVITY || '').trim() || null,
  activityType: (process.env.BOT_ACTIVITY_TYPE || 'watching').trim().toLowerCase(),

  dataFile: resolveDataFile(),
  guildId: (process.env.GUILD_ID || '').trim() || null,
  // секунды -> мс, но не больше 60 с на запрос (защита от опечаток вроде "300000")
  httpTimeout: Math.min(positiveNumber(process.env.HTTP_TIMEOUT, 20), 60) * 1000,
  logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),
};
