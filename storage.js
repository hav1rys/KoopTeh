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
let data = { users: {}, questions: {}, digests: {}, admins: [], aliases: {}, linkCodes: {} };

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
    raw = null;
  }
  const isObj = (v) => v && typeof v === 'object';
  if (isObj(raw) && isObj(raw.users)) {
    data = {
      users: raw.users,
      questions: isObj(raw.questions) ? raw.questions : {},
      digests: isObj(raw.digests) ? raw.digests : {},
      admins: Array.isArray(raw.admins) ? raw.admins.map(String) : [],
      scheduledAnnouncements: Array.isArray(raw.scheduledAnnouncements) ? raw.scheduledAnnouncements : [],
      adminLog: Array.isArray(raw.adminLog) ? raw.adminLog : [],
      aliases: isObj(raw.aliases) ? raw.aliases : {},
      linkCodes: isObj(raw.linkCodes) ? raw.linkCodes : {},
    };
  } else if (isObj(raw)) {
    data = { users: raw, questions: {}, digests: {}, admins: [], aliases: {}, linkCodes: {} };
  } else {
    data = { users: {}, questions: {}, digests: {}, admins: [], aliases: {}, linkCodes: {} };
  }
  if (!Array.isArray(data.scheduledAnnouncements)) data.scheduledAnnouncements = [];
  if (!Array.isArray(data.adminLog)) data.adminLog = [];
  if (!isObj(data.aliases)) data.aliases = {};
  if (!isObj(data.linkCodes)) data.linkCodes = {};
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
    format: r.format === 'text' || r.format === 'image' ? r.format : 'embed',
    reminderMinutes: Number.isInteger(r.reminderMinutes) && r.reminderMinutes > 0 ? r.reminderMinutes : 0,
    morning: Boolean(r.morning),
    morningTime: r.morningTime || '07:30',
    morningGreeting: r.morningGreeting || null,
    morningLastSent: r.morningLastSent || null,
    pausedUntil: r.pausedUntil || null,
    pauseEndNotified: r.pauseEndNotified || null,
    theme: r.theme || 'default',
    away: Boolean(r.away),
    homePlace: r.homePlace || null,
    homeStop: r.homeStop || null,
    homeLat: typeof r.homeLat === 'number' ? r.homeLat : null,
    homeLon: typeof r.homeLon === 'number' ? r.homeLon : null,
    weatherFormat: r.weatherFormat === 'text' || r.weatherFormat === 'image' ? r.weatherFormat : 'embed',
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
  rec(userId).format = format === 'text' || format === 'image' ? format : 'embed';
  save();
}

function setReminder(userId, minutes) {
  const n = Number(minutes);
  rec(userId).reminderMinutes = Number.isInteger(n) && n > 0 ? n : 0;
  save();
}

function setMorning(userId, value) {
  rec(userId).morning = Boolean(value);
  save();
}

function setMorningTime(userId, hhmm) {
  rec(userId).morningTime = hhmm || '07:30';
  save();
}

function setMorningLastSent(userId, iso) {
  rec(userId).morningLastSent = iso;
  save();
}

function setMorningGreeting(userId, text) {
  const r = rec(userId);
  if (text) r.morningGreeting = String(text).slice(0, 200);
  else delete r.morningGreeting;
  save();
}

function setTheme(userId, theme) {
  rec(userId).theme = theme || 'default';
  save();
}

function setWeatherFormat(userId, format) {
  rec(userId).weatherFormat = format === 'text' || format === 'image' ? format : 'embed';
  save();
}

// ---- «я не из города» (домашние погода + автобус) ------------------

function setAway(userId, value) {
  rec(userId).away = Boolean(value);
  save();
}

/** Населённый пункт + координаты (геокодинг делается один раз при вводе, снаружи). null — снять. */
function setHomePlace(userId, place, lat, lon) {
  const r = rec(userId);
  if (place) {
    r.homePlace = String(place).slice(0, 80);
    r.homeLat = Number(lat);
    r.homeLon = Number(lon);
  } else {
    delete r.homePlace;
    delete r.homeLat;
    delete r.homeLon;
    delete r.homeStop;
  }
  save();
}

function setHomeStop(userId, stop) {
  const r = rec(userId);
  if (stop) r.homeStop = String(stop).slice(0, 60);
  else delete r.homeStop;
  save();
}

/** Пауза подписки: до дня iso (в этот день рассылка возобновляется). null — снять. */
function setPausedUntil(userId, iso) {
  const r = rec(userId);
  if (iso) r.pausedUntil = iso;
  else delete r.pausedUntil;
  delete r.pauseEndNotified;
  save();
}

function setPauseEndNotified(userId, iso) {
  const r = rec(userId);
  if (iso) r.pauseEndNotified = iso;
  else delete r.pauseEndNotified;
  save();
}

/** Убрать истёкшие паузы (день возвращения наступил). */
function purgeExpiredPauses(todayIso) {
  let changed = false;
  for (const r of Object.values(data.users)) {
    if (r && r.pausedUntil && r.pausedUntil <= todayIso) {
      delete r.pausedUntil;
      delete r.pauseEndNotified;
      changed = true;
    }
  }
  if (changed) save();
}

// ---- заметки к парам ({ "<iso>|<pair>": "текст" }) --------------

function getNotesForDay(userId, iso) {
  const all = (data.users[userId] || {}).notes || {};
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    const [d, p] = k.split('|');
    if (d === iso && v) out[p] = v;
  }
  return out;
}

function setNote(userId, iso, pair, text) {
  const r = rec(userId);
  if (!r.notes || typeof r.notes !== 'object') r.notes = {};
  const key = `${iso}|${pair}`;
  if (text) r.notes[key] = String(text).slice(0, 200);
  else delete r.notes[key];
  if (!Object.keys(r.notes).length) delete r.notes;
  save();
}

function purgeOldNotes(todayIso) {
  let changed = false;
  for (const r of Object.values(data.users)) {
    if (!r || !r.notes) continue;
    for (const k of Object.keys(r.notes)) {
      if ((k.split('|')[0] || '') < todayIso) {
        delete r.notes[k];
        changed = true;
      }
    }
    if (!Object.keys(r.notes).length) {
      delete r.notes;
      changed = true;
    }
  }
  if (changed) save();
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
      format: r.format === 'text' || r.format === 'image' ? r.format : 'embed',
      reminderMinutes: Number.isInteger(r.reminderMinutes) && r.reminderMinutes > 0 ? r.reminderMinutes : 0,
      morning: Boolean(r.morning),
      morningTime: r.morningTime || '07:30',
      morningGreeting: r.morningGreeting || null,
      morningLastSent: r.morningLastSent || null,
      pausedUntil: r.pausedUntil || null,
      pauseEndNotified: r.pauseEndNotified || null,
      theme: r.theme || 'default',
      away: Boolean(r.away),
      homePlace: r.homePlace || null,
      homeStop: r.homeStop || null,
      homeLat: typeof r.homeLat === 'number' ? r.homeLat : null,
      homeLon: typeof r.homeLon === 'number' ? r.homeLon : null,
      weatherFormat: r.weatherFormat === 'text' || r.weatherFormat === 'image' ? r.weatherFormat : 'embed',
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
const getDigestSnapshot = (key) =>
  data.digests[key] && Array.isArray(data.digests[key].snapshot) ? data.digests[key].snapshot : null;

function setDigest(key, hash, iso, snapshot) {
  const prev = data.digests[key] || {};
  data.digests[key] = {
    hash,
    iso,
    snapshot: Array.isArray(snapshot) ? snapshot : prev.snapshot || null,
  };
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

// ---- журнал действий администраторов ---------------------------

function addAdminLog(adminId, action) {
  data.adminLog.unshift({ at: Date.now(), adminId: String(adminId), action: String(action).slice(0, 200) });
  if (data.adminLog.length > 60) data.adminLog.length = 60;
  save();
}

const getAdminLog = (n = 15) => data.adminLog.slice(0, n);

// ---- отложенные объявления -----------------------------------

function addScheduledAnnounce({ text, atIso, atHHMM, group, by }) {
  const id = crypto.randomBytes(4).toString('hex');
  data.scheduledAnnouncements.push({
    id,
    text,
    atIso,
    atHHMM,
    group: group || null,
    by: String(by || ''),
    createdAt: Date.now(),
  });
  save();
  return id;
}

const listScheduledAnnounces = () =>
  [...data.scheduledAnnouncements].sort((a, b) =>
    `${a.atIso} ${a.atHHMM}`.localeCompare(`${b.atIso} ${b.atHHMM}`),
  );

function removeScheduledAnnounce(id) {
  const i = data.scheduledAnnouncements.findIndex((x) => x.id === id);
  if (i < 0) return false;
  data.scheduledAnnouncements.splice(i, 1);
  save();
  return true;
}

/** Объявления, чьё время наступило (atIso/atHHMM <= сейчас). Не удаляет — это делает вызывающий. */
function dueScheduledAnnounces(nowIso, nowHHMM) {
  return data.scheduledAnnouncements.filter(
    (x) => x.atIso < nowIso || (x.atIso === nowIso && x.atHHMM <= nowHHMM),
  );
}

// ---- связывание аккаунтов между площадками (Discord/Telegram/VK) ----
//
// Идентификатор пользователя ("сырой" id) у каждой площадки свой формат
// (число у Discord, "tg:<chatId>" у Telegram, позже "vk:<id>" у VK). Чтобы
// один человек мог пользоваться одним профилем из разных мессенджеров, тут
// хранится alias-карта "сырой id -> канонический id" (id, под которым живёт
// сам профиль в data.users). Привязка подтверждается одноразовым кодом,
// чтобы нельзя было угнать чужой профиль, просто вписав чужой тег.

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без 0/O/1/I — легче диктовать и вводить

/** "Сырой" id площадки -> канонический id профиля (сам себя, если не привязан). */
function resolveUid(rawUid) {
  const id = String(rawUid);
  const target = data.aliases[id];
  return target ? String(target) : id;
}

function purgeExpiredLinkCodes() {
  const now = Date.now();
  let changed = false;
  for (const [code, v] of Object.entries(data.linkCodes)) {
    if (!v || now - v.createdAt > LINK_CODE_TTL_MS) {
      delete data.linkCodes[code];
      changed = true;
    }
  }
  if (changed) save();
}

/** Код на 10 минут для привязки другого мессенджера к тому же профилю, что и rawUid. */
function createLinkCode(rawUid) {
  purgeExpiredLinkCodes();
  const canonicalUid = resolveUid(rawUid);
  let code;
  do {
    code = Array.from({ length: 6 }, () => LINK_CODE_ALPHABET[crypto.randomInt(LINK_CODE_ALPHABET.length)]).join('');
  } while (data.linkCodes[code]);
  data.linkCodes[code] = { canonicalUid, createdAt: Date.now() };
  save();
  return code;
}

/**
 * Подтвердить код, введённый с другого мессенджера. rawUid — "сырой" id
 * аккаунта, который вводит код (сам ещё ни к чему не привязан).
 * Возвращает {ok:true, canonicalUid} либо {ok:false, error}, где error —
 * 'not-found' (код не найден/истёк), 'same' (это и так один профиль) или
 * 'has-profile' (у этого аккаунта уже есть своя группа/фамилия — привязка
 * молча стёрла бы её, поэтому отказываем и просим сначала сбросить профиль).
 */
function redeemLinkCode(code, rawUid) {
  purgeExpiredLinkCodes();
  const key = String(code || '').trim().toUpperCase();
  const entry = data.linkCodes[key];
  if (!entry) return { ok: false, error: 'not-found' };
  const id = String(rawUid);
  if (resolveUid(id) === entry.canonicalUid) return { ok: false, error: 'same' };
  const existing = data.users[id];
  if (existing && (existing.group || existing.teacherName)) return { ok: false, error: 'has-profile' };
  data.aliases[id] = entry.canonicalUid;
  delete data.linkCodes[key];
  save();
  return { ok: true, canonicalUid: entry.canonicalUid };
}

/** Все "сырые" id (включая сам канонический), привязанные к тому же профилю, что и rawUid. */
function linkedIds(rawUid) {
  const canonical = resolveUid(rawUid);
  const others = Object.entries(data.aliases)
    .filter(([, target]) => String(target) === canonical)
    .map(([id]) => id);
  return [...new Set([canonical, ...others])];
}

/** Отвязать rawUid от его канонического профиля (снова становится своим собственным). */
function unlinkPlatform(rawUid) {
  const id = String(rawUid);
  if (!data.aliases[id]) return false;
  delete data.aliases[id];
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
    imageFormat: subscribed.filter((u) => u.format === 'image').length,
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
  setMorning,
  setMorningTime,
  setMorningLastSent,
  setMorningGreeting,
  setTheme,
  setWeatherFormat,
  setAway,
  setHomePlace,
  setHomeStop,
  setPausedUntil,
  setPauseEndNotified,
  purgeExpiredPauses,
  getNotesForDay,
  setNote,
  purgeOldNotes,
  setLastSent,
  subscribers,
  addQuestion,
  getQuestion,
  deleteQuestion,
  getDigest,
  getDigestSnapshot,
  setDigest,
  digestEntries,
  purgeDigests,
  getAdmins,
  isAdmin,
  addAdmin,
  removeAdmin,
  addAdminLog,
  getAdminLog,
  resolveUid,
  createLinkCode,
  redeemLinkCode,
  linkedIds,
  unlinkPlatform,
  addScheduledAnnounce,
  listScheduledAnnounces,
  removeScheduledAnnounce,
  dueScheduledAnnounces,
  stats,
  _file: FILE,
};
