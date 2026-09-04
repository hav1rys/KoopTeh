'use strict';

// Простое хранилище "discord_user_id -> { group, subscribed }" в JSON-файле.
// Запись атомарная (пишем во временный файл и переименовываем).

const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FILE = path.resolve(cfg.dataFile);
let data = {};

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    data = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err.code === 'ENOENT') {
      data = {};
      return;
    }
    // Битый файл — отложим в сторону, начнём заново, но не потеряем.
    try {
      fs.renameSync(FILE, `${FILE}.corrupt`);
    } catch {
      /* ignore */
    }
    data = {};
  }
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

/** @returns {{ group: string|null, subscribed: boolean }} */
function get(userId) {
  const rec = data[userId] || {};
  return { group: rec.group || null, subscribed: Boolean(rec.subscribed) };
}

function setGroup(userId, group) {
  const rec = data[userId] || (data[userId] = {});
  rec.group = String(group).trim();
  if (rec.subscribed === undefined) rec.subscribed = true; // новый пользователь — сразу подписан
  save();
}

/** @returns {boolean} удалось ли (false, если группа не сохранена) */
function setSubscribed(userId, value) {
  const rec = data[userId];
  if (!rec || !rec.group) return false;
  rec.subscribed = Boolean(value);
  save();
  return true;
}

/** @returns {Array<{ userId: string, group: string }>} */
function subscribers() {
  return Object.entries(data)
    .filter(([, rec]) => rec && rec.group && rec.subscribed)
    .map(([userId, rec]) => ({ userId, group: rec.group }));
}

load();

module.exports = { get, setGroup, setSubscribed, subscribers, _file: FILE };
