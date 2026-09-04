'use strict';

// Хранилище в JSON-файле. Формат:
//   { "users": { "<discord_id>": { group, subscribed, time, days, showGaps, lastSent } },
//     "questions": { "<qid>": { askerId, askerTag, topic, question, at } } }
// Поддерживается миграция со старого «плоского» формата { "<id>": {...} }.
// Запись атомарная (temp-файл + rename).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const FILE = path.resolve(cfg.dataFile);
let data = { users: {}, questions: {} };

function backupCorrupt() {
  try {
    fs.renameSync(FILE, `${FILE}.corrupt`);
  } catch {
    /* ignore */
  }
}

function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') backupCorrupt();
    data = { users: {}, questions: {} };
    return;
  }
  if (raw && typeof raw === 'object' && raw.users && typeof raw.users === 'object') {
    data = { users: raw.users, questions: raw.questions && typeof raw.questions === 'object' ? raw.questions : {} };
  } else if (raw && typeof raw === 'object') {
    // старый плоский формат
    data = { users: raw, questions: {} };
  } else {
    data = { users: {}, questions: {} };
  }
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

// ---- пользователи --------------------------------------------------------

function userRec(userId) {
  return data.users[userId] || (data.users[userId] = {});
}

/** @returns {{ group, subscribed, time, days, showGaps, lastSent }} */
function get(userId) {
  const r = data.users[userId] || {};
  return {
    group: r.group || null,
    subscribed: Boolean(r.subscribed),
    time: r.time || null, // null -> использовать cfg.defaultTime
    days: Array.isArray(r.days) ? r.days : null, // null -> cfg.defaultDays
    showGaps: r.showGaps === undefined ? true : Boolean(r.showGaps),
    lastSent: r.lastSent || null,
  };
}

function setGroup(userId, group) {
  const r = userRec(userId);
  r.group = String(group).trim();
  if (r.subscribed === undefined) r.subscribed = true;
  save();
}

function setSubscribed(userId, value) {
  const r = data.users[userId];
  if (!r || !r.group) return false;
  r.subscribed = Boolean(value);
  save();
  return true;
}

function setTime(userId, hhmm) {
  const r = userRec(userId);
  if (hhmm) r.time = hhmm;
  else delete r.time;
  save();
}

function setDays(userId, days) {
  const r = userRec(userId);
  r.days = Array.isArray(days) ? [...new Set(days)].sort((a, b) => a - b) : [];
  save();
}

function setShowGaps(userId, value) {
  userRec(userId).showGaps = Boolean(value);
  save();
}

function setLastSent(userId, iso) {
  userRec(userId).lastSent = iso;
  save();
}

/** @returns {Array<{ userId, group, time, days, showGaps, lastSent }>} */
function subscribers() {
  return Object.entries(data.users)
    .filter(([, r]) => r && r.group && r.subscribed)
    .map(([userId, r]) => ({
      userId,
      group: r.group,
      time: r.time || null,
      days: Array.isArray(r.days) ? r.days : null,
      showGaps: r.showGaps === undefined ? true : Boolean(r.showGaps),
      lastSent: r.lastSent || null,
    }));
}

// ---- вопросы администратору -------------------------------------------

function addQuestion(askerId, askerTag, topic, question) {
  const qid = crypto.randomBytes(5).toString('hex'); // 10 hex-символов
  data.questions[qid] = { askerId, askerTag, topic, question, at: Date.now() };
  save();
  return qid;
}

function getQuestion(qid) {
  return data.questions[qid] || null;
}

function deleteQuestion(qid) {
  if (data.questions[qid]) {
    delete data.questions[qid];
    save();
  }
}

load();

module.exports = {
  get,
  setGroup,
  setSubscribed,
  setTime,
  setDays,
  setShowGaps,
  setLastSent,
  subscribers,
  addQuestion,
  getQuestion,
  deleteQuestion,
  _file: FILE,
};
