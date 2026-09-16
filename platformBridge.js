'use strict';

// Маленький реестр "как доставить текст на площадку X", без прямых require
// между index.js/telegramBot.js/vkBot.js. Нужен для одного конкретного случая:
// админ отвечает на вопрос ИЗ Discord-канала «Вопросы», а вопрос пришёл из
// Telegram или VK — ответ нужно доставить обратно в ТОТ чат, а не в Discord.
//
// Если index.js напрямую require('./telegramBot') / require('./vkBot'), это
// либо стартует эти боты преждевременно, либо (если TELEGRAM_BOT_TOKEN/
// VK_BOT_TOKEN не заданы) убьёт весь процесс их же стартовым guard'ом — они
// рассчитаны на то, что require их либо не будет вовсе, либо будет ровно один
// раз из bot.js. Поэтому вместо require — регистрация: каждый бот при своём
// старте сам кладёт сюда функцию отправки, index.js её просто зовёт (или не
// находит — тогда ответ недоставим, например бот той площадки сейчас выключен).

const senders = {};

/** platform: 'telegram' | 'vk'. fn(addr, text) -> Promise. */
function register(platform, fn) {
  senders[platform] = fn;
}

/** Возвращает true, если функция для площадки зарегистрирована (бот запущен). */
function has(platform) {
  return Boolean(senders[platform]);
}

/** Возвращает true при успешной отправке, false — если площадка не подключена или отправка не удалась. */
async function deliver(platform, addr, text) {
  const fn = senders[platform];
  if (!fn) return false;
  try {
    await fn(addr, text);
    return true;
  } catch {
    return false;
  }
}

module.exports = { register, has, deliver };
