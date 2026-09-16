'use strict';

// Рендер для VK: обычный plain-text (VK не поддерживает HTML/markdown в тексте
// сообщений) + клавиатуры. Внутреннее представление клавиатур — те же массивы
// строк из {text, callback_data} (и изредка {text, url}), что и в telegramMenu.js —
// в реальный VK Keyboard.builder() их собирает vkBot.js (toVkKeyboard). Так
// бизнес-логика экранов 1-в-1 повторяет telegramMenu.js, отличается только
// форматирование текста (без HTML) и то, что URL-кнопок нет — ссылки идут
// прямо в тексте (VK сам делает их кликабельными).

const cfg = require('./config');
const D = require('./dates');
const ss = require('./scheduleSource');
const render = require('./render');

// VK не поддерживает жирный/курсив/код в обычных сообщениях — эти хелперы просто
// возвращают текст как есть (оставлены, чтобы структура экранов совпадала 1-в-1
// с telegramMenu.js и различия были видны только в этом месте).
const esc = (s) => String(s ?? '');
const b = (s) => String(s ?? '');
const code = (s) => String(s ?? '');

const DAYS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const REMINDER_OPTS = [0, 5, 10, 15, 20, 30, 60];
// У VK гораздо более жёсткий лимит на инлайн-клавиатуру, чем у Telegram/Discord
// (сервер VK отдаёт "Code №911 - too much buttons" уже на 6 строках/14 кнопках) —
// поэтому здесь заметно меньше групп на страницу и меньше строк в списках ниже,
// чем в telegramMenu.js/menu.js.
const GROUPS_PER_PAGE = 6;

function daysLabel(days) {
  if (!days || !days.length) return '— (не присылать)';
  if (days.length === 7) return 'каждый день';
  const set = new Set(days);
  return [1, 2, 3, 4, 5, 6, 7].filter((d) => set.has(d)).map((d) => DAYS_RU[d - 1]).join(' ');
}

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};

const stripEmoji = (s) => String(s).replace(/^🔔\s*/, '');
const isoToDM = (iso) => {
  const t = D.partsFromIso(iso);
  return t ? D.fmtDM(t) : iso;
};

/** «через N мин (в HH:MM)» — статично, без авто-обновления (обновляется кнопкой). */
function relTime(target, hhmm) {
  if (!hhmm) return '';
  const ep = D.epochAt(target, hhmm);
  if (!ep) return `в ${hhmm}`;
  const diffMin = Math.round((ep * 1000 - Date.now()) / 60000);
  if (diffMin <= 0 && diffMin > -2) return `сейчас (в ${hhmm})`;
  if (diffMin < 0) return `в ${hhmm} (было ${Math.abs(diffMin)} мин назад)`;
  if (diffMin < 60) return `через ${diffMin} мин (в ${hhmm})`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return `через ${h} ч${m ? ` ${m} мин` : ''} (в ${hhmm})`;
}

// ---- Главное меню ---------------------------------------------------

function buildMenu(s, extras = {}) {
  const noSubj = !s.subj;
  const teacherMode = s.role === 'teacher' && s.teacherName;
  const lines = [b('🎓 Расписание — Кооперативный техникум')];
  lines.push(noSubj ? 'Чтобы начать — открой ⚙️ Настройки и укажи группу (или фамилию в разделе «Роль»).' : 'Расписание пар приходит сюда, в личные сообщения.');
  lines.push('');
  lines.push(`👤 Роль: ${teacherMode ? `👨‍🏫 преподаватель — ${s.teacherName}` : '🎓 студент'}`);
  lines.push(`📚 Группа: ${s.group || 'не указана'}`);
  if (noSubj) {
    lines.push('🔔 Рассылка: нужна группа или фамилия');
  } else if (!s.subscribed) {
    lines.push('🔔 Рассылка: ⛔ выключена');
  } else if (extras.pausedUntil) {
    lines.push(`🔔 Рассылка: ⏸ пауза до ${isoToDM(extras.pausedUntil)}`);
  } else if (extras.nextBroadcastEpoch) {
    const diffMin = Math.round((extras.nextBroadcastEpoch * 1000 - Date.now()) / 60000);
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    lines.push(`🔔 Ближайшая рассылка: через ${h} ч ${m} мин`);
  } else {
    lines.push('🔔 Рассылка: —');
  }
  if (!noSubj && extras.nextPair) lines.push(`\n📌 Следующая пара: ${extras.nextPair}`);
  lines.push('\nПетрозаводск · koopteh10.ru');

  const row1 = [
    { text: '📅 Расписание', callback_data: 'menu:schedule' },
    { text: '📅 Неделя', callback_data: 'menu:week' },
    { text: '📨 На завтра', callback_data: 'menu:now' },
  ];
  const row2 = [
    { text: '⚙️ Настройки', callback_data: 'menu:settings' },
    { text: '🔍 Поиск', callback_data: 'menu:search' },
    { text: '👨‍🏫 Преподаватель', callback_data: 'menu:teacher' },
  ];
  const row3 = [
    { text: '🔔 Звонки', callback_data: 'menu:bell' },
    { text: '🚪 Кабинеты', callback_data: 'menu:rooms' },
  ];
  if (cfg.weatherEnabled) row3.push({ text: '🌤 Погода', callback_data: 'menu:weather' });
  const row4 = [
    { text: '❓ Вопрос', callback_data: 'menu:ask' },
    { text: 'ℹ️ Помощь', callback_data: 'menu:help' },
    { text: '🔄 Обновить', callback_data: 'menu:refresh' },
  ];
  if (extras.showBus) row4.unshift({ text: '🚌 Автобус', callback_data: 'menu:bus' });

  return { text: lines.join('\n'), keyboard: [row1, row2, row3, row4] };
}

/** Постоянная клавиатура снизу (не inline) — та же основная навигация текстовыми
 * кнопками. Не зависит от per-user состояния (кроме cfg.weatherEnabled). */
function mainReplyKeyboard() {
  const row3 = ['🔔 Звонки', '🚪 Кабинеты'];
  if (cfg.weatherEnabled) row3.push('🌤 Погода');
  return [
    ['📅 Расписание', '📅 Неделя', '📨 На завтра'],
    ['⚙️ Настройки', '🔍 Поиск', '👨‍🏫 Преподаватель'],
    row3,
    ['🚌 Автобус', '❓ Вопрос', 'ℹ️ Помощь'],
  ];
}

// ---- Помощь -----------------------------------------------------------

function buildHelpView() {
  const text = [
    b('ℹ️ Как пользоваться ботом'),
    'Всё приходит в личные сообщения. Настройка — через «Начать» → ⚙️ Настройки.',
    '',
    b('Команды'),
    'начать — меню и все настройки',
    'расписание — расписание на сегодня (или пришли «дд.мм»)',
    'сейчас — текущая и следующая пара',
    'поиск — кабинет / преподаватель / предмет / группа',
    'звонки — расписание звонков',
    'помощь — эта справка',
    '',
    b('⚙️ Настройки'),
    'Группа и роль · рассылка (время/дни) · пауза · напоминания · утро (+ своё приветствие) · формат текст/картинка · 🏘 не из города (погода дома + автобус)',
  ].join('\n');
  return { text, keyboard: [[{ text: '← В меню', callback_data: 'menu:refresh' }]] };
}

// ---- Формат (текст / картинка) --------------------------------------

const fmtLabel = (f) => (f === 'image' ? 'картинка' : 'текст');
function nextFormat(cur) {
  if (!render.available()) return 'text';
  return cur === 'image' ? 'text' : 'image';
}

// ---- Настройки --------------------------------------------------------

// VK живьём режет инлайн-клавиатуру уже на 14 кнопках ("Code №911 - too much
// buttons"), при этом 12 кнопок (как в buildMenu) проходят нормально — реальный
// потолок явно намного строже документированных где-либо чисел. Поэтому
// настройки в VK разбиты на два экрана вместо одного (как в Telegram/Discord).
function buildSettingsView(s) {
  const noSubj = !s.subj;
  const teacherMode = s.role === 'teacher' && s.teacherName;
  const paused = s.pausedUntil && s.pausedUntil > D.iso(D.todayParts());
  const lines = [
    b('⚙️ Настройки'),
    `📚 Группа: ${s.group || 'не указана'}`,
    `👤 Роль: ${teacherMode ? `👨‍🏫 преподаватель — ${s.teacherName}` : '🎓 студент'}`,
    `🔔 Рассылка: ${noSubj ? 'нужна группа/фамилия' : paused ? `⏸ пауза до ${isoToDM(s.pausedUntil)}` : s.subscribed ? '✅ включена' : '⛔ выключена'}`,
    `🕘 Время: ${s.time}${s.customTime ? '' : ' (по умолч.)'}`,
    `📆 Дни: ${daysLabel(s.days)}`,
  ];
  const kb = [
    [
      { text: s.group ? '📚 Сменить группу' : '📚 Указать группу', callback_data: 'set:group' },
      { text: '👤 Роль', callback_data: 'set:role' },
      { text: paused ? '⏸ Пауза (вкл)' : '⏸ Пауза', callback_data: 'set:pause' },
    ],
    [
      { text: s.subscribed ? 'Откл. рассылку' : 'Вкл. рассылку', callback_data: 'set:togglesub' },
      { text: `🕘 ${s.time}`, callback_data: 'set:time' },
      { text: '📆 Дни', callback_data: 'set:days' },
    ],
    [
      { text: '⚙️ Ещё настройки →', callback_data: 'set:more' },
      { text: '← В меню', callback_data: 'set:back' },
    ],
  ];
  return { text: lines.join('\n'), keyboard: kb };
}

/** Вторая страница настроек (только VK — из-за лимита на кнопки в одной клавиатуре). */
function buildSettingsMoreView(s) {
  const lines = [
    b('⚙️ Ещё настройки'),
    `⏰ Напоминания: ${s.reminderMinutes ? `за ${s.reminderMinutes} мин` : 'выкл'}`,
    `☀️ Утро: ${s.morning ? s.morningTime : 'выкл'}`,
    `🏘 Не из города: ${s.away && s.homePlace ? s.homePlace : '—'}`,
    `🖼 Формат: ${fmtLabel(s.format)}`,
    `🌤 Формат погоды: ${fmtLabel(s.weatherFormat)}`,
    `🚪 Окна «пар нет»: ${s.showGaps ? 'показывать' : 'скрывать'}`,
  ];
  const kb = [
    [
      { text: '⏰ Напоминания', callback_data: 'set:reminder' },
      { text: '☀️ Утро', callback_data: 'set:morning' },
      { text: '🏘 Не из города', callback_data: 'set:away' },
    ],
    [
      { text: s.showGaps ? 'Окна: скрыть' : 'Окна: показать', callback_data: 'set:togglegaps' },
      { text: `Формат: ${fmtLabel(s.format)}`, callback_data: 'set:format' },
      { text: `Погода: ${fmtLabel(s.weatherFormat)}`, callback_data: 'set:wthrformat' },
    ],
    [
      { text: '🔗 Связать', callback_data: 'set:link' },
      { text: '← Назад', callback_data: 'set:moreback' },
    ],
  ];
  return { text: lines.join('\n'), keyboard: kb };
}

// ---- Связывание аккаунтов ------------------------------------------------

const PLATFORM_LABEL = (id) => (id.startsWith('tg:') ? 'Telegram' : id.startsWith('vk:') ? 'VK' : 'Discord');

function buildLinkView(linkedIds, extras = {}) {
  const lines = [b('🔗 Связь с другими мессенджерами')];
  lines.push('Один и тот же профиль (группа, рассылка, настройки) можно открыть из Discord, Telegram и VK — если их связать.');
  lines.push('');
  lines.push(
    linkedIds.length > 1
      ? `Сейчас привязаны: ${linkedIds.map(PLATFORM_LABEL).join(', ')}.`
      : 'Пока ничего не привязано — это отдельный профиль.',
  );
  if (extras.code) lines.push(`\n📎 Код: ${extras.code}\nВведи его в другом мессенджере (там тоже есть кнопка «Связать») в течение 10 минут.`);
  if (extras.error === 'not-found') lines.push('\n⚠️ Код не найден или уже истёк (действует 10 минут).');
  else if (extras.error === 'same') lines.push('\n⚠️ Это и так один и тот же профиль.');
  const kb = [
    [{ text: '📎 Получить код', callback_data: 'link:code' }],
    [{ text: '⌨️ Ввести код', callback_data: 'link:enter' }],
  ];
  // Отвязать можно любой конкретный мессенджер из группы, находясь на любом из
  // них — включая сам корень (группа тогда просто перекорениться на оставшихся).
  if (linkedIds.length > 1) {
    for (const id of linkedIds) kb.push([{ text: `✂️ Отвязать ${PLATFORM_LABEL(id)}`, callback_data: `link:unlink:${id}` }]);
  }
  kb.push([{ text: '← Назад', callback_data: 'set:back' }]);
  return { text: lines.join('\n'), keyboard: kb };
}

// ---- Пауза -------------------------------------------------------------

function buildPauseView(s) {
  const active = s.pausedUntil && s.pausedUntil > D.iso(D.todayParts());
  const text = [
    b('⏸ Пауза подписки'),
    active
      ? `Сейчас на паузе. Рассылка, утро и напоминания вернутся ${isoToDM(s.pausedUntil)}.`
      : 'Заглушить рассылку, утро и напоминания на время (практика, отпуск, каникулы). Ручной просмотр продолжает работать.',
    '',
    'Выбери, до какого дня молчать (в этот день всё включится само):',
  ].join('\n');
  const kb = [
    [
      { text: 'на неделю', callback_data: 'pause:days:7' },
      { text: 'на 2 недели', callback_data: 'pause:days:14' },
      { text: 'на месяц', callback_data: 'pause:days:30' },
    ],
    [{ text: '📅 До даты…', callback_data: 'pause:date' }],
    [
      { text: 'Снять паузу', callback_data: 'pause:off' },
      { text: '← Назад', callback_data: 'pause:back' },
    ],
  ];
  return { text, keyboard: kb };
}

// ---- «Я не из города» --------------------------------------------------

function buildAwayView(s) {
  const text = [
    b('🏘 Я не из города'),
    'Если включено — присылаю ещё и погоду по месту жительства (отдельным сообщением), и расписание автобуса до техникума и обратно (кнопка «Автобус» в меню).',
    '',
    `Статус: ${s.away ? '✅ включено' : '⛔ выключено'}`,
    `Населённый пункт: ${s.homePlace || 'не указан'}`,
    `Остановка: ${s.homeStop || 'не указана — время будет примерным'}`,
    '',
    'Остановку можно указать просто цифрой (2), если у села пронумерованные остановки, или полным названием («кладбище»), если это другая точка.',
  ].join('\n');
  const kb = [
    [
      { text: s.away ? 'Выключить' : 'Включить', callback_data: 'away:toggle' },
      { text: '🏘 Населённый пункт', callback_data: 'away:place' },
      { text: '🚏 Остановка', callback_data: 'away:stop' },
    ],
    [{ text: '← Назад', callback_data: 'away:back' }],
  ];
  return { text, keyboard: kb };
}

// ---- Роль ---------------------------------------------------------------

function buildRoleView(s) {
  const text = [
    b('👤 Роль'),
    `Сейчас: ${s.role === 'teacher' ? 'преподаватель' : 'студент'}`,
    `Группа: ${s.group || '—'}`,
    `Фамилия: ${s.teacherName || '—'}`,
    '',
    'В режиме преподавателя ежедневная рассылка, расписание, неделя и напоминания — по твоим парам во всех группах.',
  ].join('\n');
  const kb = [
    [
      { text: `🎓 Студент${s.role === 'student' ? ' ✓' : ''}`, callback_data: 'role:student' },
      { text: `👨‍🏫 Препод.${s.role === 'teacher' ? ' ✓' : ''}`, callback_data: 'role:teacher' },
    ],
    [
      { text: '✏️ Указать фамилию', callback_data: 'role:setname' },
      { text: 'Готово', callback_data: 'role:done' },
    ],
  ];
  return { text, keyboard: kb };
}

// ---- Выбор группы ---------------------------------------------------------

function buildGroupPicker(groups, page, { error } = {}) {
  const pages = Math.max(1, Math.ceil(groups.length / GROUPS_PER_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = groups.slice(p * GROUPS_PER_PAGE, p * GROUPS_PER_PAGE + GROUPS_PER_PAGE);

  const lines = [b('Выбор группы')];
  if (slice.length) lines.push(`Всего групп: ${groups.length}. Страница ${p + 1}/${pages}. Нет твоей — пролистай или введи вручную.`);
  else lines.push(error || 'Список групп получить не удалось. Введи название вручную.');

  const kb = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [{ text: slice[i], callback_data: `grp:pick:${p}:${i}` }];
    if (slice[i + 1] != null) row.push({ text: slice[i + 1], callback_data: `grp:pick:${p}:${i + 1}` });
    kb.push(row);
  }
  kb.push([
    { text: '◀', callback_data: `grp:page:${p - 1}` },
    { text: '▶', callback_data: `grp:page:${p + 1}` },
  ]);
  kb.push([
    { text: 'Ввести вручную', callback_data: 'grp:manual' },
    { text: 'Назад', callback_data: 'grp:cancel' },
  ]);
  return { text: lines.join('\n'), keyboard: kb };
}

// ---- Дни недели ---------------------------------------------------------

function buildDaysView(days) {
  const set = new Set(days);
  const btn = (isoDay) => ({ text: `${set.has(isoDay) ? '✅ ' : ''}${DAYS_RU[isoDay - 1]}`, callback_data: `days:toggle:${isoDay}` });
  const text = [b('Дни рассылки'), `Зелёная галка — расписание на этот день придёт накануне.\nСейчас: ${daysLabel(days)}`].join('\n');
  const kb = [
    [btn(1), btn(2), btn(3), btn(4)],
    [btn(5), btn(6), btn(7)],
    [{ text: 'Готово', callback_data: 'days:done' }],
  ];
  return { text, keyboard: kb };
}

// ---- Напоминания ---------------------------------------------------------

function buildReminderView(current) {
  const btn = (n) => ({ text: `${n === current ? '✅ ' : ''}${n === 0 ? 'Выкл' : `${n} мин`}`, callback_data: `rem:set:${n}` });
  const text = [
    b('Напоминания о парах'),
    `За сколько минут до начала пары присылать напоминание (только по сегодняшнему дню).\nСейчас: ${current ? `за ${current} мин` : 'выкл'}`,
  ].join('\n');
  const kb = [
    [btn(0), btn(5), btn(10), btn(15)],
    [btn(20), btn(30), btn(60)],
    [{ text: 'Готово', callback_data: 'rem:done' }],
  ];
  return { text, keyboard: kb };
}

// ---- Утро -----------------------------------------------------------------

function buildMorningView(s) {
  const text = [
    b('☀️ Утреннее сообщение'),
    `Короткая сводка утром: сколько пар и во сколько первая${cfg.weatherEnabled ? `, плюс погода в ${cfg.weatherPlace}` : ''}.`,
    `Сейчас: ${s.morning ? `вкл, ${s.morningTime}` : 'выкл'}. Учитывает выбранные дни недели.`,
    `Приветствие: ${s.morningGreeting ? `«${s.morningGreeting}»` : '☀️ Доброе утро! (по умолчанию)'}`,
  ].join('\n');
  const kb = [
    [
      { text: s.morning ? 'Выключить' : 'Включить', callback_data: 'mrn:toggle' },
      { text: `🕗 ${s.morningTime}`, callback_data: 'mrn:time' },
      { text: '✍️ Приветствие', callback_data: 'mrn:greeting' },
    ],
    [{ text: 'Готово', callback_data: 'mrn:done' }],
  ];
  return { text, keyboard: kb };
}

// ---- Расписание: рендер данных --------------------------------------------

const noLessonsMsg = (data) => ((data.mode || 'group') === 'search' ? 'Ничего не найдено' : data.weekend ? 'Выходной, пар нет' : 'Пар нет');

function summaryLine(data) {
  if ((data.mode || 'group') !== 'group') return null;
  const lessons = data.rows.filter((r) => r.kind === 'lesson' && r.start);
  if (!lessons.length) return null;
  const n = lessons.length;
  const first = lessons[0];
  const last = lessons[lessons.length - 1];
  const when =
    D.iso(data.target) === D.iso(D.todayParts())
      ? 'Сегодня'
      : D.iso(data.target) === D.iso(D.tomorrowParts())
        ? 'Завтра'
        : D.fmtDM(data.target);
  return `${when}: ${n} ${plural(n, 'пара', 'пары', 'пар')}, первая ${first.start}, до ${last.end}`;
}

function nextPairLine(data) {
  if (!data || data.note || !Array.isArray(data.rows) || !data.rows.length) return null;
  const lessons = data.rows.filter((r) => r.kind === 'lesson' && r.start);
  if (!lessons.length) return null;
  const T = data.target;
  const isToday = D.iso(T) === D.iso(D.todayParts());
  const now = D.tzNow();
  const nowMin = now.h * 60 + now.mi;
  const desc = (r) => `${r.pair ? `${r.pair}. ` : ''}${stripEmoji(r.subject)}${r.room ? `, ауд. ${r.room}` : ''}`;
  if (!isToday) {
    const f = lessons[0];
    return `${desc(f)} — ${relTime(T, f.start)}`;
  }
  const cur = lessons.find((r) => {
    const s2 = D.toMinutes(r.start);
    const e2 = D.toMinutes(r.end);
    return s2 != null && e2 != null && s2 <= nowMin && nowMin < e2;
  });
  if (cur) return `сейчас ${desc(cur)} — до ${relTime(T, cur.end)}`;
  const nx = lessons.find((r) => (D.toMinutes(r.start) ?? 1e9) > nowMin);
  if (!nx) return 'на сегодня всё';
  return `${desc(nx)} — ${relTime(T, nx.start)}`;
}

/** Текстовое расписание (plain-text). Единственный текстовый формат в VK. */
function scheduleText(data, humanUrl) {
  const mode = data.mode || 'group';
  let head;
  if (mode === 'teacher') head = `Преподаватель ${data.teacher} — ${D.fmtDM(data.target)} (${data.weekday})`;
  else if (mode === 'search') head = `Поиск: ${data.title} — ${D.fmtDM(data.target)} (${data.weekday})`;
  else head = `Расписание на ${D.fmtDM(data.target)} (${data.weekday})\nГруппа: ${data.group}`;

  const lines = [head];
  if (humanUrl && /^https?:\/\//.test(humanUrl)) lines.push(`🔗 Проверить: ${humanUrl}`);

  if (data.note === 'not-found') {
    lines.push('', 'Группа не найдена в расписании на эту дату.');
    return lines.join('\n');
  }
  if (data.note === 'no-lessons' || !data.rows.length) {
    lines.push('', noLessonsMsg(data));
    return lines.join('\n');
  }

  const summary = summaryLine(data);
  if (summary) lines.push('', `📋 ${summary}`);
  if (mode === 'group' && D.iso(data.target) !== D.iso(D.todayParts())) {
    const first = data.rows.find((r) => r.kind === 'lesson' && r.start);
    if (first) lines.push(`До первой пары: ${relTime(data.target, first.start)}`);
  }

  for (const r of data.rows) {
    const range = r.start && r.end ? `${r.start}–${r.end}` : r.start || '';
    const num = r.pair != null ? `${r.pair}.` : '';
    lines.push('', `${num} 🕓 ${range}`);
    if (r.kind === 'free') {
      lines.push('Предмет: пар нет');
      continue;
    }
    lines.push(`Предмет: ${r.subject}`);
    if (r.room) lines.push(`Кабинет: ${r.room}`);
    if (r.note) lines.push(`📝 Заметка: ${r.note}`);
    if (r.combinedWith && r.combinedWith.length) lines.push(`Совмещённая группа: ${r.combinedWith.join(', ')}`);
    if (mode === 'teacher') lines.push(`Группы: ${r.groupsText || '—'}`);
    else {
      if (r.teacher) lines.push(`Преподаватель: ${r.teacher}`);
      if (mode === 'search') lines.push(`Группа: ${r.groupsText || '—'}`);
    }
  }

  if (mode === 'group' && D.iso(data.target) === D.iso(D.todayParts())) {
    const npl = nextPairLine(data);
    if (npl) lines.push('', `📌 Сейчас: ${npl}`);
  }
  return lines.join('\n');
}

/** Единый payload расписания: {text} или {photo: Buffer, caption} (photo грузится в vkBot.js). */
function scheduleMessage(data, humanUrl, format) {
  if (format === 'image' && render.available() && (data.mode || 'group') === 'group' && !data.note && data.rows.length) {
    const buf = render.renderScheduleImage(data);
    if (buf) return { photo: buf, caption: `Расписание на ${D.fmtDM(data.target)} (${data.weekday}), группа ${data.group}`.slice(0, 900) };
  }
  return { text: scheduleText(data, humanUrl).slice(0, 4000) };
}

function scheduleKeyboard(isoStr, humanUrl, data) {
  const todayIso = D.iso(D.todayParts());
  const tomIso = D.iso(D.tomorrowParts());
  const nav = [
    { text: '◀', callback_data: `sch:prev:${isoStr}` },
    { text: isoStr === todayIso ? '· Сегодня ·' : 'Сегодня', callback_data: 'sch:jump:today' },
    { text: isoStr === tomIso ? '· Завтра ·' : 'Завтра', callback_data: 'sch:jump:tomorrow' },
    { text: '▶', callback_data: `sch:next:${isoStr}` },
  ];
  const actions = [
    { text: '📋 Текстом', callback_data: `sch:share:${isoStr}` },
    { text: '⚠️ Ошибка', callback_data: `sch:report:${isoStr}` },
  ];
  if ((data.mode || 'group') === 'group' && !data.note) actions.push({ text: '📝 Заметка', callback_data: `sch:note:${isoStr}` });
  const rows = [nav, actions];
  rows.push([{ text: '← В меню', callback_data: 'menu:refresh' }]);
  return rows;
}

function lookupKeyboard(data) {
  const nav = [
    { text: '◀', callback_data: 'lk:prev' },
    { text: 'Сегодня', callback_data: 'lk:day:today' },
    { text: 'Завтра', callback_data: 'lk:day:tomorrow' },
    { text: '▶', callback_data: 'lk:next' },
  ];
  const rows = [nav];
  if (data && data.mode === 'teacher') rows.push([{ text: '📌 Сделать моим расписанием', callback_data: 'lk:pin' }]);
  rows.push([{ text: '← В меню', callback_data: 'menu:refresh' }]);
  return rows;
}

function buildNowMessage(data, label) {
  const t = D.todayParts();
  const lines = [`🎓 ${label} — ${D.fmtDM(t)} (${D.weekdayRu(t)})`];
  const npl = data && !data.note ? nextPairLine(data) : null;
  if (!data || data.note === 'not-found') lines.push('расписание на сегодня не найдено');
  else if (data.note === 'no-lessons' || !npl) lines.push(data.weekend ? 'сегодня выходной 🎉' : 'на сегодня пар нет');
  else lines.push(npl);
  return { text: lines.join('\n') };
}

function changeSummaryText(target, diff) {
  const label = (r) => {
    const bits = [r.subject || '—'];
    if (r.who) bits.push(r.who);
    if (r.room) bits.push(`ауд. ${r.room}`);
    const range = r.start && r.end ? ` (${r.start}–${r.end})` : '';
    return bits.join(', ') + range;
  };
  const num = (r) => (r.pair != null ? `${r.pair} пара` : r.start || 'пара');
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  if (total > 8) return `⚠️ Расписание на ${D.fmtDM(target)} сильно изменилось (${total} изменений), актуальная версия ниже:`;
  const lines = [`📝 Что изменилось на ${D.fmtDM(target)}:`];
  for (const c of diff.changed) lines.push(`• ${num(c.to)}: ${label(c.from)} → ${label(c.to)}`);
  for (const r of diff.added) lines.push(`• добавилась ${num(r)}: ${label(r)}`);
  for (const r of diff.removed) lines.push(`• убрали ${num(r)}: ${label(r)}`);
  return lines.join('\n').slice(0, 3500);
}

// ---- Неделя -----------------------------------------------------------

const trunc = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function dayCell(d) {
  if (d.error) return d.error;
  const data = d.data;
  if (!data || data.note === 'not-found') return 'нет группы';
  if (data.note === 'no-lessons' || !data.rows.length) return data.weekend ? 'выходной' : 'пар нет';
  return (
    data.rows
      .filter((r) => r.kind !== 'free')
      .slice(0, 8)
      .map((r) => `${r.pair ?? '·'}·${(r.start || '—').slice(0, 5)} ${trunc(r.subject, 20)}`)
      .join('\n') || 'пар нет'
  );
}

const weekLabel = (week) => week.days.map((d) => d.data && (d.data.group || d.data.teacher)).find(Boolean) || '';

function buildWeekView(week) {
  const mon = week.days[0].parts;
  const sat = week.days[week.days.length - 1].parts;
  const grp = weekLabel(week);
  const out = [`Неделя ${D.fmtDM(mon)} – ${D.fmtDM(sat)}${grp ? `, ${grp}` : ''}`];
  for (const d of week.days) {
    out.push('', `${DAYS_RU[D.weekdayIso(d.parts) - 1]} ${D.fmtDM(d.parts)}`, dayCell(d));
  }
  const kb = [
    [
      { text: '◀ неделя', callback_data: 'wk:prev' },
      { text: 'Эта неделя', callback_data: 'wk:this' },
      { text: 'неделя ▶', callback_data: 'wk:next' },
    ],
    [{ text: '← В меню', callback_data: 'menu:refresh' }],
  ];
  return { text: out.join('\n').slice(0, 4000), keyboard: kb };
}

// ---- Звонки -------------------------------------------------------------

function bellStatus(t) {
  const weekend = D.weekdayIso(t) >= 6;
  const tbl = weekend ? ss.BELL_WEEKEND : ss.BELL_WEEKDAY;
  const now = D.tzNow();
  const nowMin = now.h * 60 + now.mi;
  const pairs = [1, 2, 3, 4, 5, 6, 7].map((p) => ({ p, s: D.toMinutes(tbl[p][0]), e: D.toMinutes(tbl[p][1]), start: tbl[p][0], end: tbl[p][1] }));
  const cur = pairs.find((x) => x.s <= nowMin && nowMin < x.e);
  if (cur) return `🔔 идёт ${cur.p}-я пара — звонок ${relTime(t, cur.end)}`;
  const next = pairs.find((x) => x.s > nowMin);
  if (!next) return '🔔 пары закончились';
  if (nowMin < pairs[0].s) return `🔔 до ${next.p}-й пары — звонок ${relTime(t, next.start)}`;
  return `☕ перемена — звонок на ${next.p}-ю ${relTime(t, next.start)}`;
}

function bellView() {
  const t = D.todayParts();
  const fmt = (tbl) => [1, 2, 3, 4, 5, 6, 7].map((p) => `${p}. ${tbl[p][0]}–${tbl[p][1]}`).join('\n');
  const text = [
    b('🔔 Расписание звонков'),
    bellStatus(t),
    '',
    'Будни (Пн–Пт)',
    fmt(ss.BELL_WEEKDAY),
    '',
    'Выходные (Сб–Вс)',
    fmt(ss.BELL_WEEKEND),
  ].join('\n');
  const kb = [[
    { text: '🔄 Обновить', callback_data: 'menu:bell' },
    { text: '← В меню', callback_data: 'menu:refresh' },
  ]];
  return { text, keyboard: kb };
}

// ---- Свободные кабинеты --------------------------------------------------

function buildRoomsView(result, target) {
  const text = [
    `🚪 Кабинеты — ${D.fmtDM(target)} (${D.weekdayRu(target)}), пара ${result.pair}`,
    '',
    `Свободно (${result.free.length})\n${result.free.join(', ') || '—'}`,
    '',
    `Занято (${result.busy.length})\n${result.busy.join(', ') || '—'}`,
  ].join('\n');
  const kb = [[
    { text: '🔁 Другая пара/дата', callback_data: 'menu:rooms' },
    { text: '← В меню', callback_data: 'menu:refresh' },
  ]];
  return { text, keyboard: kb };
}

// ---- Погода -------------------------------------------------------------

function weatherText(place, forecast, dateLabel) {
  const advice = forecast.advice || [];
  const body = (forecast.ranges || []).map((r) => `${r.label} — ${r.icon} ${r.temp > 0 ? '+' : ''}${r.temp}°`).join('\n');
  const lines = [`🌤 Погода — ${place}${dateLabel ? ` · ${dateLabel}` : ''}`];
  if (advice.length) lines.push(advice.join('\n'));
  lines.push('', body || 'нет данных');
  return lines.join('\n');
}

function buildWeatherPanel(homeInfo, cityInfo, isoStr, dateLabel) {
  const todayIso = D.iso(D.todayParts());
  const tomIso = D.iso(D.tomorrowParts());
  const horizonIso = D.iso(D.shiftParts(D.todayParts(), 6));
  void todayIso;
  void tomIso;
  const parts = [];
  if (homeInfo) parts.push(weatherText(homeInfo.place, homeInfo.forecast, dateLabel));
  parts.push(weatherText(cityInfo.place, cityInfo.forecast, dateLabel));
  const nav = [
    { text: '◀', callback_data: `weather:prev:${isoStr}` },
    { text: 'Сегодня', callback_data: 'weather:jump:today' },
    { text: 'Завтра', callback_data: 'weather:jump:tomorrow' },
    { text: isoStr >= horizonIso ? ' ' : '▶', callback_data: isoStr >= horizonIso ? 'noop' : `weather:next:${isoStr}` },
  ];
  const kb = [nav, [
    { text: '🔄 Обновить', callback_data: 'menu:weather' },
    { text: '← В меню', callback_data: 'menu:refresh' },
  ]];
  return { text: parts.join('\n\n').slice(0, 4000), keyboard: kb };
}

// ---- Автобус --------------------------------------------------------------

function busLine(rows, direction, target) {
  const isToday = D.iso(target) === D.iso(D.todayParts());
  const dated = (rows || []).map((r) => ({ ...r, epoch: r.depHHMM ? D.epochAt(target, r.depHHMM) : null }));
  if (!dated.length) return 'нет данных';
  const now = Date.now();
  const next = isToday ? dated.find((r) => r.epoch && r.epoch * 1000 > now) : dated[0];
  if (!next) return 'рейсов на этот день больше нет';
  const head = [next.number, next.title].filter(Boolean).join(' ');
  const dep = next.depHHMM ? `отправление ${next.depHHMM}` : '';
  const arr = next.arrHHMM ? `прибытие ${next.arrHHMM}` : '';
  const late = ' (±10 мин)';
  const detail =
    direction === 'toHome'
      ? [dep, arr && `${arr}${late}`].filter(Boolean).join(', ')
      : [dep && `${dep}${late}`, arr].filter(Boolean).join(', ');
  const rel = next.epoch ? relTime(target, next.depHHMM) : next.depHHMM;
  return `${head ? `${head} — ` : ''}${rel}${detail ? `\n${detail}` : ''}`;
}

function buildBusView(place, toHomeRows, toCityRows, toHomeUrl, toCityUrl, isoStr) {
  const target = D.partsFromIso(isoStr) || D.todayParts();
  const list = (rows) => (rows || []).map((r) => `${r.depHHMM} → ${r.arrHHMM}`).join('\n') || '—';
  const withLink = (line, url) => (url ? `${line}\n🔗 Проверить: ${url}` : line);
  const text = [
    `🚌 Автобус — ${place} · ${D.fmtDM(target)} (${D.weekdayRu(target)})`,
    '',
    'Ближайший из города (домой)',
    withLink(busLine(toHomeRows, 'toHome', target), toHomeUrl),
    '',
    'Ближайший из дома (в город)',
    withLink(busLine(toCityRows, 'toCity', target), toCityUrl),
    '',
    `Все рейсы из города\n${list(toHomeRows)}`,
    '',
    `Все рейсы из дома\n${list(toCityRows)}`,
  ].join('\n');
  const kb = [
    [
      { text: '◀', callback_data: `bus:prev:${isoStr}` },
      { text: 'Сегодня', callback_data: 'bus:jump:today' },
      { text: 'Завтра', callback_data: 'bus:jump:tomorrow' },
      { text: '▶', callback_data: `bus:next:${isoStr}` },
    ],
    [
      { text: '🔄 Обновить', callback_data: 'menu:bus' },
      { text: '← В меню', callback_data: 'menu:refresh' },
    ],
  ];
  return { text: text.slice(0, 4000), keyboard: kb };
}

// ---- Админ-панель ---------------------------------------------------------

function buildAdminMenu() {
  const text = ['🛠 Панель администратора', 'Объявления (в т.ч. отложенные и по группе), статистика, состояние источника, журнал, админы.'].join('\n');
  const kb = [
    [
      { text: '📢 Объявление', callback_data: 'adm:announce' },
      { text: '🕓 Отложенные', callback_data: 'adm:schann' },
      { text: '📊 Статистика', callback_data: 'adm:stats' },
    ],
    [
      { text: '🩺 Источник', callback_data: 'adm:health' },
      { text: '🧾 Журнал', callback_data: 'adm:log' },
      { text: '👥 Админы', callback_data: 'adm:admins' },
    ],
  ];
  return { text, keyboard: kb };
}

function buildAdminLogView(entries) {
  const body = entries.map((e) => `• ${new Date(e.at).toLocaleString('ru-RU')} · …${String(e.adminId).slice(-4)} — ${e.action}`).join('\n') || 'пусто';
  return { text: `🧾 Журнал действий\n${body}`.slice(0, 4000), keyboard: [[{ text: '← Назад', callback_data: 'adm:menu' }]] };
}

function buildSchedAnnView(list) {
  const body =
    list.map((x) => `• ${x.id} — ${isoToDM(x.atIso)} ${x.atHHMM} · ${x.group || 'всем'}\n  ${String(x.text).replace(/\n/g, ' ').slice(0, 80)}`).join('\n') ||
    'Запланированных объявлений нет.';
  const kb = [[{ text: '➕ Запланировать', callback_data: 'adm:schann:add' }, { text: '← Назад', callback_data: 'adm:menu' }]];
  for (let i = 0; i < list.length && kb.length < 4; i += 3) {
    kb.push(list.slice(i, i + 3).map((x) => ({ text: `✖ ${x.id}`, callback_data: `adm:schann:del:${x.id}` })));
  }
  return { text: `🕓 Отложенные объявления\n${body}`.slice(0, 4000), keyboard: kb };
}

function buildHealthView(h) {
  const rel = (ms) => (ms ? new Date(ms).toLocaleString('ru-RU') : '—');
  const okAge = h.lastOkAt ? Date.now() - h.lastOkAt : null;
  const dot = okAge == null ? '⚪' : okAge < 20 * 60 * 1000 ? '🟢' : okAge < 60 * 60 * 1000 ? '🟡' : '🔴';
  const text = [
    `${dot} Состояние источника`,
    `Последняя успешная загрузка: ${h.lastOkAt ? `${rel(h.lastOkAt)}${h.lastOkIso ? ` · расписание на ${h.lastOkIso}` : ''}` : 'ещё не было'}`,
    `Последняя попытка: ${rel(h.lastTryAt)}`,
    `Последняя ошибка: ${h.lastErrAt ? `${rel(h.lastErrAt)} · ${h.lastErrKind === 'not-published' ? 'нет ссылки на дату' : 'источник недоступен'}\n${String(h.lastErrMsg || '—').slice(0, 200)}` : '—'}`,
  ].join('\n');
  return { text, keyboard: [[{ text: '← Назад', callback_data: 'adm:menu' }]] };
}

function buildStatsView(s) {
  const top = Object.entries(s.byGroup).sort((a, b2) => b2[1] - a[1]).slice(0, 15).map(([g, n]) => `${g} — ${n}`).join('\n') || '—';
  const text = [
    '📊 Статистика',
    `Пользователей: ${s.total}`,
    `С группой/фамилией: ${s.withGroup}`,
    `Подписано: ${s.subscribed}`,
    `Преподавателей: ${s.teachers || 0}`,
    `Напоминания вкл: ${s.reminders}`,
    `Формат-картинка: ${s.imageFormat || 0}`,
    `Открытых вопросов: ${s.openQuestions}`,
    '',
    'Подписки по группам',
    top,
  ].join('\n');
  return { text: text.slice(0, 4000), keyboard: [[{ text: '← Назад', callback_data: 'adm:menu' }]] };
}

function buildAdminsView(adminIds, selfId) {
  const text = ['👥 Администраторы', adminIds.map((id) => `• ${id}${id === String(selfId) ? ' (ты)' : ''}`).join('\n') || '—'].join('\n');
  const kb = [[{ text: '➕ Добавить', callback_data: 'adm:addadmin' }, { text: '← Назад', callback_data: 'adm:menu' }]];
  for (let i = 0; i < adminIds.length && kb.length < 4; i += 3) {
    kb.push(adminIds.slice(i, i + 3).map((id) => ({ text: `✖ …${String(id).slice(-4)}`, callback_data: `adm:del:${id}` })));
  }
  return { text, keyboard: kb };
}

module.exports = {
  esc,
  b,
  code,
  relTime,
  buildMenu,
  mainReplyKeyboard,
  buildHelpView,
  fmtLabel,
  nextFormat,
  buildSettingsView,
  buildSettingsMoreView,
  buildLinkView,
  buildPauseView,
  buildAwayView,
  buildRoleView,
  buildGroupPicker,
  buildDaysView,
  buildReminderView,
  buildMorningView,
  scheduleText,
  scheduleMessage,
  scheduleKeyboard,
  lookupKeyboard,
  buildNowMessage,
  changeSummaryText,
  buildWeekView,
  bellStatus,
  bellView,
  buildRoomsView,
  weatherText,
  buildWeatherPanel,
  buildBusView,
  buildAdminMenu,
  buildAdminLogView,
  buildSchedAnnView,
  buildHealthView,
  buildStatsView,
  buildAdminsView,
  REMINDER_OPTS,
  GROUPS_PER_PAGE,
};
