'use strict';

// Хранилище в JSON-файле:
//   { "users":     { "<id>": { group, subscribed, time, days, showGaps, format, reminderMinutes, lastSent } },
//     "questions": { "<qid>": { askerId, askerTag, topic, question, at } },
//     "digests":   { "<groupNorm>|<iso>": { hash, iso } } }
// Поддерживается миграция со старого «плоского» формата { "<id>": {...} }.
// Запись атомарная (temp-файл + rename).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const FILE = path.resolve(cfg.dataFile);
let data = { users: {}, questions: {}, digests: {}, admins: [] };

function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      try {
        fs.renameSync(FILE, `${FILE}.corrupt`);
      } catch {
        /* ignore */
      }
    }
    data = { users: {}, questions: {}, digests: {} };
    return;
  }
  const isObj = (v) => v && typeof v === 'object';
  if (isObj(raw) && isObj(raw.users)) {
    data = {
      users: raw.users,
      questions: isObj(raw.questions) ? raw.questions : {},
      digests: isObj(raw.digests) ? raw.digests : {},
      admins: Array.isArray(raw.admins) ? raw.admins.map(String) : [],
    };
  } else if (isObj(raw)) {
    data = { users: raw, questions: {}, digests: {}, admins: [] };
  } else {
    data = { users: {}, questions: {}, digests: {}, admins: [] };
  }
  if (!data.admins.length && cfg.adminId) data.admins = [String(cfg.adminId)];
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

const rec = (userId) => data.users[userId] || (data.users[userId] = {});

// ---- пользователи --------------------------------------------------

function get(userId) {
  const r = data.users[userId] || {};
  return {
    group: r.group || null,
    teacherName: r.teacherName || null,
    role: r.role === 'teacher' ? 'teacher' : 'student',
    subscribed: Boolean(r.subscribed),
    time: r.time || null,
    days: Array.isArray(r.days) ? r.days : null,
    showGaps: r.showGaps === undefined ? true : Boolean(r.showGaps),
    format: r.format === 'text' ? 'text' : 'embed',
    reminderMinutes: Number.isInteger(r.reminderMinutes) && r.reminderMinutes > 0 ? r.reminderMinutes : 0,
    lastSent: r.lastSent || null,
  };
}

function setGroup(userId, group) {
  const r = rec(userId);
  r.group = String(group).trim();
  if (r.subscribed === undefined) r.subscribed = true;
  save();
}

function setTeacherName(userId, name) {
  const r = rec(userId);
  if (name) r.teacherName = String(name).trim();
  else delete r.teacherName;
  if (r.subscribed === undefined && r.teacherName) r.subscribed = true;
  save();
}

function setRole(userId, role) {
  rec(userId).role = role === 'teacher' ? 'teacher' : 'student';
  save();
}

function setSubscribed(userId, value) {
  const r = data.users[userId];
  if (!r || !(r.group || r.teacherName)) return false;
  r.subscribed = Boolean(value);
  save();
  return true;
}

function setTime(userId, hhmm) {
  const r = rec(userId);
  if (hhmm) r.time = hhmm;
  else delete r.time;
  save();
}

function setDays(userId, days) {
  rec(userId).days = Array.isArray(days) ? [...new Set(days)].sort((a, b) => a - b) : [];
  save();
}

function setShowGaps(userId, value) {
  rec(userId).showGaps = Boolean(value);
  save();
}

function setFormat(userId, format) {
  rec(userId).format = format === 'text' ? 'text' : 'embed';
  save();
}

function setReminder(userId, minutes) {
  const n = Number(minutes);
  rec(userId).reminderMinutes = Number.isInteger(n) && n > 0 ? n : 0;
  save();
}

function setLastSent(userId, iso) {
  rec(userId).lastSent = iso;
  save();
}

function subscribers() {
  return Object.entries(data.users)
    .filter(([, r]) => r && (r.group || r.teacherName) && r.subscribed)
    .map(([userId, r]) => ({
      userId,
      group: r.group || null,
      teacherName: r.teacherName || null,
      role: r.role === 'teacher' ? 'teacher' : 'student',
      time: r.time || null,
      days: Array.isArray(r.days) ? r.days : null,
      showGaps: r.showGaps === undefined ? true : Boolean(r.showGaps),
      format: r.format === 'text' ? 'text' : 'embed',
      reminderMinutes: Number.isInteger(r.reminderMinutes) && r.reminderMinutes > 0 ? r.reminderMinutes : 0,
      lastSent: r.lastSent || null,
    }));
}

// ---- вопросы администратору --------------------------------------

function addQuestion(askerId, askerTag, topic, question) {
  const qid = crypto.randomBytes(5).toString('hex');
  data.questions[qid] = { askerId, askerTag, topic, question, at: Date.now() };
  save();
  return qid;
}

const getQuestion = (qid) => data.questions[qid] || null;

function deleteQuestion(qid) {
  if (data.questions[qid]) {
    delete data.questions[qid];
    save();
  }
}

// ---- отпечатки расписания (отслеживание изменений) --------------

const getDigest = (key) => (data.digests[key] ? data.digests[key].hash : null);

function setDigest(key, hash, iso) {
  data.digests[key] = { hash, iso };
  save();
}

const digestEntries = () =>
  Object.entries(data.digests).map(([key, v]) => {
    const bar = key.lastIndexOf('|');
    return { key, group: key.slice(0, bar), iso: v.iso || key.slice(bar + 1), hash: v.hash };
  });

function purgeDigests(minIso) {
  let changed = false;
  for (const [key, v] of Object.entries(data.digests)) {
    if ((v.iso || '') < minIso) {
      delete data.digests[key];
      changed = true;
    }
  }
  if (changed) save();
}

// ---- админы ------------------------------------------------------

const getAdmins = () => [...new Set((data.admins || []).map(String))].filter(Boolean);
const isAdmin = (id) => getAdmins().includes(String(id));

function addAdmin(id) {
  const a = getAdmins();
  if (a.includes(String(id))) return false;
  data.admins = [...a, String(id)];
  save();
  return true;
}

function removeAdmin(id) {
  const a = getAdmins();
  if (a.length <= 1 || !a.includes(String(id))) return false;
  data.admins = a.filter((x) => x !== String(id));
  save();
  return true;
}

// ---- статистика -------------------------------------------------

function stats() {
  const users = Object.values(data.users);
  const withSubj = users.filter((u) => u && (u.group || u.teacherName));
  const subscribed = withSubj.filter((u) => u.subscribed);
  const byGroup = {};
  for (const u of subscribed) {
    if (u.role === 'teacher' && u.teacherName) continue;
    if (u.group) byGroup[u.group] = (byGroup[u.group] || 0) + 1;
  }
  return {
    total: users.length,
    withGroup: withSubj.length,
    subscribed: subscribed.length,
    teachers: subscribed.filter((u) => u.role === 'teacher' && u.teacherName).length,
    reminders: subscribed.filter((u) => Number(u.reminderMinutes) > 0).length,
    textFormat: subscribed.filter((u) => u.format === 'text').length,
    openQuestions: Object.keys(data.questions).length,
    byGroup,
  };
}

load();

module.exports = {
  get,
  setGroup,
  setTeacherName,
  setRole,
  setSubscribed,
  setTime,
  setDays,
  setShowGaps,
  setFormat,
  setReminder,
  setLastSent,
  subscribers,
  addQuestion,
  getQuestion,
  deleteQuestion,
  getDigest,
  setDigest,
  digestEntries,
  purgeDigests,
  getAdmins,
  isAdmin,
  addAdmin,
  removeAdmin,
  stats,
  _file: FILE,
};
