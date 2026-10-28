'use strict';

// Общая часть уведомлений «опубликовано расписание на новый день»: какие дни на
// странице календаря появились с прошлой проверки. Отправкой занимается каждый бот сам.
// Учёт «уже виденных» дней — отдельный у каждой площадки (ns: 'ds' | 'tg' | 'vk').

const D = require('./dates');
const storage = require('./storage');
const ss = require('./scheduleSource');

/**
 * Новые опубликованные дни (сегодня и позже), которых эта площадка ещё не видела.
 * Первый запуск только запоминает текущее состояние и ничего не возвращает —
 * иначе после деплоя все получили бы разом уведомления про уже известные дни.
 */
async function detectNewDays(ns) {
  const todayIso = D.iso(D.todayParts());
  const published = (await ss.listPublishedDays()).filter((iso) => iso >= todayIso);
  const seen = storage.getNewDaySeen(ns);
  if (seen === null) {
    storage.setNewDaySeen(ns, published);
    return [];
  }
  const seenSet = new Set(seen);
  return published.filter((iso) => !seenSet.has(iso));
}

/** Отмечает день как обработанный (и заодно забывает прошедшие дни). */
function markSeen(ns, iso) {
  const todayIso = D.iso(D.todayParts());
  const seen = (storage.getNewDaySeen(ns) || []).filter((i) => i >= todayIso);
  storage.setNewDaySeen(ns, [...seen, iso]);
}

module.exports = { detectNewDays, markSeen };
