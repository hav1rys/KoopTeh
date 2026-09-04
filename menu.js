'use strict';

// Все экраны и формы бота.

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const cfg = require('./config');
const D = require('./dates');
const ss = require('./scheduleSource');

const C = {
  weekday: 0x2b6cb0, // будни
  weekend: 0x868e96, // сб/вс, «группа не найдена»
  none: 0x2f9e44, // пар нет
  error: 0xe03131, // ошибка
  teacher: 0x7048e8, // режим преподавателя
  search: 0x1098ad, // поиск
};
const DAYS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const GROUPS_PER_PAGE = 25;
const REMINDER_OPTS = [0, 5, 10, 15, 20, 30, 60];

const clip = (s) => (s.length > 1024 ? `${s.slice(0, 1021)}…` : s);
const timeCol = (r) => {
  const range = r.start && r.end ? `${r.start}–${r.end}` : r.start || '';
  return r.pair ? `${r.pair} · ${range}` : range;
};

function daysLabel(days) {
  if (!days || !days.length) return '— (не присылать)';
  if (days.length === 7) return 'каждый день';
  const set = new Set(days);
  return [1, 2, 3, 4, 5, 6, 7].filter((d) => set.has(d)).map((d) => DAYS_RU[d - 1]).join(' ');
}

// ---- Главное меню ----------------------------------------------------

function buildMenu(s, extras = {}) {
  const noSubj = !s.subj;
  const teacherMode = s.role === 'teacher' && s.teacherName;
  const nb = extras.nextBroadcastEpoch;
  const fields = [
    {
      name: 'Роль',
      value: teacherMode ? `👨‍🏫 преподаватель — **${s.teacherName}**` : '🎓 студент',
      inline: true,
    },
    { name: 'Группа', value: s.group ? `**${s.group}**` : '_не указана_', inline: true },
    {
      name: 'Рассылка',
      value: noSubj ? '_нужна группа или фамилия_' : s.subscribed ? '✅ включена' : '⛔ выключена',
      inline: true,
    },
    { name: 'Время', value: `🕘 ${s.time}${s.customTime ? '' : ' (по умолч.)'}`, inline: true },
    { name: 'Дни', value: `📆 ${daysLabel(s.days)}`, inline: true },
    { name: 'Напоминания', value: s.reminderMinutes ? `⏰ за ${s.reminderMinutes} мин` : '⏰ выкл', inline: true },
    { name: 'Формат', value: s.format === 'text' ? '📄 текст' : '📊 эмбед', inline: true },
    { name: 'Окна «пар нет»', value: s.showGaps ? 'показывать' : 'скрывать', inline: true },
  ];
  if (!noSubj && s.subscribed) {
    fields.push({
      name: 'Ближайшая рассылка',
      value: nb ? `📬 <t:${nb}:R> (<t:${nb}:t>)` : '—',
      inline: true,
    });
  }
  const embed = new EmbedBuilder()
    .setColor(teacherMode ? C.teacher : C.weekday)
    .setTitle('🎓 Расписание — Кооперативный техникум')
    .setDescription('Расписание пар приходит в личные сообщения. Настрой всё кнопками ниже.')
    .addFields(fields)
    .setFooter({ text: 'Петрозаводск • koopteh10.ru' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('menu:setgroup')
      .setLabel(s.group ? 'Сменить группу' : 'Указать группу')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('menu:role').setLabel('👤 Роль').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('menu:schedule')
      .setLabel('📅 Расписание')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(noSubj),
    new ButtonBuilder()
      .setCustomId('menu:week')
      .setLabel('📅 Неделя')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(noSubj),
    new ButtonBuilder()
      .setCustomId('menu:now')
      .setLabel('📨 На завтра')
      .setStyle(ButtonStyle.Success)
      .setDisabled(noSubj),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('menu:togglesub')
      .setLabel(s.subscribed ? 'Отключить рассылку' : 'Включить рассылку')
      .setStyle(s.subscribed ? ButtonStyle.Danger : ButtonStyle.Success)
      .setDisabled(noSubj),
    new ButtonBuilder().setCustomId('menu:time').setLabel(`🕘 ${s.time}`).setStyle(ButtonStyle.Secondary).setDisabled(noSubj),
    new ButtonBuilder().setCustomId('menu:days').setLabel('📆 Дни').setStyle(ButtonStyle.Secondary).setDisabled(noSubj),
    new ButtonBuilder()
      .setCustomId('menu:reminder')
      .setLabel('⏰ Напоминания')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(noSubj),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('menu:togglegaps')
      .setLabel(s.showGaps ? 'Окна: скрыть' : 'Окна: показать')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(noSubj),
    new ButtonBuilder()
      .setCustomId('menu:format')
      .setLabel(s.format === 'text' ? 'Формат: текст' : 'Формат: эмбед')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('menu:search').setLabel('🔍 Поиск').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('menu:teacher').setLabel('👨‍🏫 Преподаватель').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('menu:bell').setLabel('🔔 Звонки').setStyle(ButtonStyle.Secondary),
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('menu:rooms').setLabel('🚪 Свободные кабинеты').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('menu:ask').setLabel('❓ Задать вопрос').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('menu:refresh').setLabel('🔄 Обновить').setStyle(ButtonStyle.Secondary),
  );

  return { content: '', embeds: [embed], components: [row1, row2, row3, row4] };
}

// ---- Эмбед расписания (режимы group / teacher / search) --------------

const FIELD_NAMES = {
  group: ['Время', 'Предмет | Кабинет', 'Преподаватель'],
  teacher: ['Время', 'Предмет | Кабинет', 'Группы'],
  search: ['Время', 'Предмет', 'Кабинет · Группа · Препод.'],
};

const noLessonsMsg = (data) =>
  (data.mode || 'group') === 'search' ? 'Ничего не найдено' : data.weekend ? 'Выходной, пар нет' : 'Пар нет';

/**
 * { f1, f2, f3 } для полей-таймеров (только сегодня, режим группы) или null.
 * Использует Discord-таймстампы <t:SEC:R> — клиент сам обновляет «через N минут».
 */
function countdownParts(data) {
  if ((data.mode || 'group') !== 'group') return null;
  const t = data.target;
  if (D.iso(t) !== D.iso(D.todayParts())) return null;
  const now = D.tzNow();
  const nowMin = now.h * 60 + now.mi;
  const lessons = data.rows
    .filter((r) => r.kind === 'lesson' && r.start && r.end)
    .map((r) => ({ s: D.toMinutes(r.start), e: D.toMinutes(r.end), end: r.end, start: r.start }))
    .filter((r) => r.s != null && r.e != null);
  if (!lessons.length) return null;

  const current = lessons.find((r) => r.s <= nowMin && nowMin < r.e);
  const next = lessons.find((r) => r.s > nowMin);
  const last = lessons[lessons.length - 1];

  const rel = (hhmm) => {
    const ep = D.epochAt(t, hhmm);
    return ep ? `<t:${ep}:R>` : hhmm;
  };
  const at = (hhmm) => {
    const ep = D.epochAt(t, hhmm);
    return ep ? `<t:${ep}:t>` : hhmm;
  };

  return {
    f1: current
      ? `идёт пара, конец ${rel(current.end)}`
      : next
        ? `${rel(next.start)} — в ${at(next.start)}`
        : 'на сегодня всё',
    f2: current ? `${rel(current.end)} — до ${at(current.end)}` : 'сейчас пар нет',
    f3: nowMin < last.e ? `${rel(last.end)} — до ${at(last.end)}` : 'пары закончились',
  };
}

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};

/** «Завтра 4 пары, первая 10:00, до 16:30» — краткая сводка (режим группы, есть пары). */
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

function scheduleEmbed(data, humanUrl) {
  const mode = data.mode || 'group';
  const weekend = D.weekdayIso(data.target) >= 6;
  const isToday = D.iso(data.target) === D.iso(D.todayParts());
  const embed = new EmbedBuilder();

  let title;
  let descHead = null;
  if (mode === 'teacher') title = `Преподаватель ${data.teacher} — ${D.fmtDM(data.target)} (${data.weekday})`;
  else if (mode === 'search') title = `Поиск: ${data.title} — ${D.fmtDM(data.target)} (${data.weekday})`;
  else {
    title = `Расписание на ${D.fmtDM(data.target)} (${data.weekday})`;
    descHead = `**Группа:** ${data.group}`;
  }
  embed.setTitle(title.slice(0, 256));

  const descLines = [];
  if (descHead) descLines.push(descHead);
  if (humanUrl && /^https?:\/\//.test(humanUrl)) descLines.push(`**🔗 Проверить:** ${humanUrl}`);

  if (data.note === 'no-lessons') embed.setColor(C.none);
  else if (data.note === 'not-found') embed.setColor(C.weekend);
  else if (mode === 'teacher') embed.setColor(C.teacher);
  else if (mode === 'search') embed.setColor(C.search);
  else embed.setColor(weekend ? C.weekend : C.weekday);

  if (data.note === 'not-found') {
    embed.setDescription(`${descLines.join('\n')}\n\nГруппа не найдена в расписании на эту дату.`);
    return { content: '', embeds: [embed], components: [] };
  }
  if (data.note === 'no-lessons' || !data.rows.length) {
    embed.setDescription(`${descLines.length ? `${descLines.join('\n')}\n\n` : ''}**${noLessonsMsg(data)}**`);
    return { content: '', embeds: [embed], components: [] };
  }
  const summary = summaryLine(data);
  const desc = summary ? [...descLines, '', `📋 ${summary}`] : descLines;
  if (desc.length) embed.setDescription(desc.join('\n'));

  let curIdx = -1;
  let nextIdx = -1;
  if (isToday && mode === 'group') {
    const now = D.tzNow();
    const nowMin = now.h * 60 + now.mi;
    data.rows.forEach((r, i) => {
      if (r.kind !== 'lesson') return;
      const sMin = D.toMinutes(r.start);
      const eMin = D.toMinutes(r.end);
      if (sMin == null || eMin == null) return;
      if (curIdx < 0 && sMin <= nowMin && nowMin < eMin) curIdx = i;
      if (nextIdx < 0 && sMin > nowMin) nextIdx = i;
    });
  }

  const col1 = [];
  const col2 = [];
  const col3 = [];
  data.rows.forEach((r, i) => {
    const mark = i === curIdx ? '🔴 ' : i === nextIdx ? '🟢 ' : '• ';
    const b = i === curIdx || i === nextIdx;
    const w = (t) => (b ? `**${t}**` : t);
    const subj = r.icon ? `${r.icon} ${r.subject}` : r.subject || '—';
    col1.push(w(`${mark}${timeCol(r)}`));
    if (mode === 'search') {
      col2.push(w(subj));
      col3.push(w([r.room && `каб. ${r.room}`, r.groupsText, r.teacher].filter(Boolean).join(' · ') || '—'));
    } else {
      col2.push(w(r.room ? `${subj} | ${r.room}` : subj));
      col3.push(w((mode === 'teacher' ? r.groupsText : r.teacher) || '—'));
    }
  });

  const [n1, n2, n3] = FIELD_NAMES[mode] || FIELD_NAMES.group;
  embed.addFields(
    { name: n1, value: clip(col1.join('\n')), inline: true },
    { name: n2, value: clip(col2.join('\n')), inline: true },
    { name: n3, value: clip(col3.join('\n')), inline: true },
  );

  const cd = countdownParts(data);
  if (cd) {
    embed.addFields(
      { name: 'Следующая пара', value: cd.f1, inline: true },
      { name: 'Текущая пара', value: cd.f2, inline: true },
      { name: 'Учёба', value: cd.f3, inline: true },
    );
  } else if (mode === 'group' && !isToday) {
    const first = data.rows.find((r) => r.kind === 'lesson' && r.start);
    if (first) {
      const ep = D.epochAt(data.target, first.start);
      embed.addFields({
        name: 'До первой пары',
        value: ep ? `<t:${ep}:R> (в ${first.start})` : `в ${first.start}`,
        inline: true,
      });
    }
  }

  return { content: '', embeds: [embed], components: [] };
}

/** Текстовый формат — блоками, с жирными подписями (как просил пользователь). */
function scheduleTextRich(data, humanUrl) {
  const mode = data.mode || 'group';
  let head;
  if (mode === 'teacher') head = `**Преподаватель ${data.teacher} — ${D.fmtDM(data.target)} (${data.weekday})**`;
  else if (mode === 'search') head = `**Поиск: ${data.title} — ${D.fmtDM(data.target)} (${data.weekday})**`;
  else head = `**Расписание на ${D.fmtDM(data.target)} (${data.weekday})**\n**Группа:** ${data.group}`;

  const lines = [head];
  if (humanUrl && /^https?:\/\//.test(humanUrl)) lines.push(`**🔗 Проверить:** ${humanUrl}`);

  if (data.note === 'not-found') {
    lines.push('', '**Группа не найдена в расписании на эту дату.**');
    return lines.join('\n');
  }
  if (data.note === 'no-lessons' || !data.rows.length) {
    lines.push('', `**${noLessonsMsg(data)}**`);
    return lines.join('\n');
  }

  const summary = summaryLine(data);
  if (summary) lines.push('', `📋 **${summary}**`);
  if (mode === 'group' && D.iso(data.target) !== D.iso(D.todayParts())) {
    const first = data.rows.find((r) => r.kind === 'lesson' && r.start);
    const ep = first && D.epochAt(data.target, first.start);
    if (ep) lines.push(`**До первой пары:** <t:${ep}:R>`);
  }

  for (const r of data.rows) {
    const range = r.start && r.end ? `${r.start}–${r.end}` : r.start || '';
    const num = r.pair != null ? `${r.pair}.` : '';
    lines.push('', `**${num}🕓 ${range}**`);
    if (r.kind === 'free') {
      lines.push('**Предмет:** пар нет');
      continue;
    }
    lines.push(`**Предмет:** ${r.icon ? `${r.icon} ${r.subject}` : r.subject}`);
    if (r.room) lines.push(`**Кабинет:** ${r.room}`);
    if (mode === 'teacher') lines.push(`**Группы:** ${r.groupsText || '—'}`);
    else {
      if (r.teacher) lines.push(`**Преподаватель:** ${r.teacher}`);
      if (mode === 'search') lines.push(`**Группа:** ${r.groupsText || '—'}`);
    }
  }

  const cd = countdownParts(data);
  if (cd) {
    lines.push('', `**Следующая пара:** ${cd.f1}`, `**Текущая пара:** ${cd.f2}`, `**Учёба:** ${cd.f3}`);
  }
  return lines.join('\n');
}

/** Единый payload расписания: эмбед или текст (по настройке пользователя). */
function scheduleMessage(data, humanUrl, format) {
  if (format === 'text') {
    return { content: scheduleTextRich(data, humanUrl).slice(0, 1990), embeds: [] };
  }
  return scheduleEmbed(data, humanUrl);
}

// ---- Экран расписания группы с навигацией по датам -------------------

function scheduleNav(isoStr) {
  const todayIso = D.iso(D.todayParts());
  const tomIso = D.iso(D.tomorrowParts());
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sch:prev:${isoStr}`).setLabel('◀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('sch:jump:today')
      .setLabel('Сегодня')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isoStr === todayIso),
    new ButtonBuilder()
      .setCustomId('sch:jump:tomorrow')
      .setLabel('Завтра')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isoStr === tomIso),
    new ButtonBuilder().setCustomId(`sch:next:${isoStr}`).setLabel('▶').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sch:menu').setLabel('В меню').setStyle(ButtonStyle.Primary),
  );
}

function buildScheduleView(data, isoStr, humanUrl, errorText, format) {
  const nav = scheduleNav(isoStr);
  if (errorText) return { content: errorText, embeds: [], components: [nav] };

  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sch:send:${isoStr}`).setLabel('📨 Прислать сообщением').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sch:report:${isoStr}`).setLabel('⚠️ Ошибка').setStyle(ButtonStyle.Danger),
  );
  if (humanUrl && /^https?:\/\//.test(humanUrl)) {
    actions.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(humanUrl).setLabel('🔗 Источник'));
  }

  const base = scheduleMessage(data, humanUrl, format);
  return { content: base.content || '', embeds: base.embeds, components: [nav, actions] };
}

// ---- Экран поиска / преподавателя (навигация по датам через lookupState) ----

function buildLookupView(data, humanUrl, format, errorText) {
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lk:prev').setLabel('◀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('lk:day:today').setLabel('Сегодня').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('lk:day:tomorrow').setLabel('Завтра').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('lk:next').setLabel('▶').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('lk:menu').setLabel('В меню').setStyle(ButtonStyle.Primary),
  );
  if (errorText) return { content: errorText, embeds: [], components: [nav] };
  const rows = [nav];
  if (data && data.mode === 'teacher') {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('lk:pin')
          .setLabel('📌 Сделать моим расписанием (рассылка)')
          .setStyle(ButtonStyle.Success),
      ),
    );
  }
  const base = scheduleMessage(data, humanUrl, format);
  return { content: base.content || '', embeds: base.embeds, components: rows };
}

// ---- Роль (студент / преподаватель) -----------------------------

function buildRoleView(s) {
  const embed = new EmbedBuilder()
    .setColor(C.teacher)
    .setTitle('👤 Роль')
    .setDescription(
      `Сейчас: **${s.role === 'teacher' ? 'преподаватель' : 'студент'}**\n` +
        `Группа: ${s.group || '—'}\nФамилия: ${s.teacherName || '—'}\n\n` +
        'В режиме преподавателя ежедневная рассылка, расписание, неделя и напоминания — по твоим парам во всех группах.',
    );
  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('role:student')
          .setLabel('🎓 Студент')
          .setStyle(s.role === 'student' ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(!s.group),
        new ButtonBuilder()
          .setCustomId('role:teacher')
          .setLabel('👨‍🏫 Преподаватель')
          .setStyle(s.role === 'teacher' ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(!s.teacherName),
        new ButtonBuilder().setCustomId('role:setname').setLabel('✏️ Указать фамилию').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('role:done').setLabel('Готово').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function setTeacherModal(current) {
  const input = new TextInputBuilder()
    .setCustomId('surname')
    .setLabel('Твоя фамилия (пусто — очистить)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(40);
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId('modal:setteacher')
    .setTitle('Режим преподавателя')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

// ---- Выбор группы --------------------------------------------------

function buildGroupPicker(groups, page, { error } = {}) {
  const pages = Math.max(1, Math.ceil(groups.length / GROUPS_PER_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = groups.slice(p * GROUPS_PER_PAGE, p * GROUPS_PER_PAGE + GROUPS_PER_PAGE);

  const embed = new EmbedBuilder().setColor(C.weekday).setTitle('Выбор группы');
  const rows = [];
  if (slice.length) {
    embed.setDescription(`Всего групп: ${groups.length}. Страница ${p + 1}/${pages}. Нет твоей — пролистай или введи вручную.`);
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('grp:pick')
          .setPlaceholder('Выбери группу…')
          .addOptions(slice.map((g) => ({ label: g.slice(0, 100), value: g.slice(0, 100) }))),
      ),
    );
  } else {
    embed.setDescription(error || 'Список групп получить не удалось. Введи название вручную.');
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`grp:page:${p - 1}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(p <= 0 || !slice.length),
      new ButtonBuilder().setCustomId(`grp:page:${p + 1}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(p >= pages - 1 || !slice.length),
      new ButtonBuilder().setCustomId('grp:manual').setLabel('Ввести вручную').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('grp:cancel').setLabel('Назад').setStyle(ButtonStyle.Secondary),
    ),
  );
  return { content: '', embeds: [embed], components: rows };
}

// ---- Дни недели --------------------------------------------------

function buildDaysView(days) {
  const set = new Set(days);
  const btn = (isoDay) =>
    new ButtonBuilder()
      .setCustomId(`days:toggle:${isoDay}`)
      .setLabel(DAYS_RU[isoDay - 1])
      .setStyle(set.has(isoDay) ? ButtonStyle.Success : ButtonStyle.Secondary);
  const embed = new EmbedBuilder()
    .setColor(C.weekday)
    .setTitle('Дни рассылки')
    .setDescription(`Зелёный день — расписание **на этот день** придёт накануне.\nСейчас: **${daysLabel(days)}**`);
  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(btn(1), btn(2), btn(3), btn(4), btn(5)),
      new ActionRowBuilder().addComponents(
        btn(6),
        btn(7),
        new ButtonBuilder().setCustomId('days:done').setLabel('Готово').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

// ---- Напоминания -----------------------------------------------

function buildReminderView(current) {
  const btn = (n) =>
    new ButtonBuilder()
      .setCustomId(`rem:set:${n}`)
      .setLabel(n === 0 ? 'Выкл' : `${n} мин`)
      .setStyle(n === current ? ButtonStyle.Success : ButtonStyle.Secondary);
  const embed = new EmbedBuilder()
    .setColor(C.weekday)
    .setTitle('Напоминания о парах')
    .setDescription(
      'За сколько минут до начала пары присылать напоминание (только по сегодняшнему дню).\n' +
        `Сейчас: ${current ? `**за ${current} мин**` : '**выкл**'}`,
    );
  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(btn(0), btn(5), btn(10), btn(15), btn(20)),
      new ActionRowBuilder().addComponents(
        btn(30),
        btn(60),
        new ButtonBuilder().setCustomId('rem:done').setLabel('Готово').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

// ---- Модальные окна --------------------------------------------

function groupModal(current) {
  const input = new TextInputBuilder()
    .setCustomId('group')
    .setLabel('Название группы, например 209ИС-1')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(40);
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId('modal:setgroup')
    .setTitle('Учебная группа')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function timeModal(current) {
  const input = new TextInputBuilder()
    .setCustomId('time')
    .setLabel('Время ЧЧ:ММ (пусто — по умолчанию)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(5)
    .setPlaceholder(cfg.defaultTime);
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId('modal:time')
    .setTitle('Время рассылки')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function askModal() {
  return new ModalBuilder()
    .setCustomId('modal:ask')
    .setTitle('Вопрос администратору')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('topic').setLabel('Тема').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('question').setLabel('Вопрос').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500),
      ),
    );
}

function answerModal(qid, topic) {
  return new ModalBuilder()
    .setCustomId(`modal:answer:${qid}`)
    .setTitle(`Ответ: ${topic}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('answer').setLabel('Ответ пользователю').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1800),
      ),
    );
}

function searchModal() {
  return new ModalBuilder()
    .setCustomId('modal:search')
    .setTitle('Поиск по расписанию')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('room').setLabel('Кабинет (можно пусто)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('teacher').setLabel('Фамилия преподавателя (можно пусто)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('date').setLabel('Дата дд.мм (пусто — сегодня)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10).setPlaceholder('05.09'),
      ),
    );
}

function teacherModal() {
  return new ModalBuilder()
    .setCustomId('modal:teacher')
    .setTitle('Расписание преподавателя')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('surname').setLabel('Фамилия преподавателя').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('date').setLabel('Дата дд.мм (пусто — сегодня)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10).setPlaceholder('05.09'),
      ),
    );
}

function reportModal(iso) {
  return new ModalBuilder()
    .setCustomId(`modal:report:${iso}`)
    .setTitle('Ошибка в расписании')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('text').setLabel('Что не так с расписанием?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500),
      ),
    );
}

// ---- Сообщения вопрос/ответ администратору --------------------

function adminQuestionMessage(q, qid) {
  const embed = new EmbedBuilder()
    .setColor(0xd9a441)
    .setTitle(`❓ ${q.topic}`.slice(0, 256))
    .setDescription(q.question.slice(0, 4000))
    .addFields({ name: 'От кого', value: `${q.askerTag} (\`${q.askerId}\`)` })
    .setFooter({ text: `вопрос ${qid}` })
    .setTimestamp(q.at || Date.now());
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ans:${qid}`).setLabel('Ответить').setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

function answerMessage(q, answer) {
  const embed = new EmbedBuilder()
    .setColor(C.weekday)
    .setTitle(`💬 Ответ на твой вопрос: ${q.topic}`.slice(0, 256))
    .addFields(
      { name: 'Твой вопрос', value: q.question.slice(0, 1024) },
      { name: 'Ответ', value: answer.slice(0, 1024) },
    );
  return { embeds: [embed] };
}

// ---- Обзор недели ---------------------------------------------

const trunc = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function dayCell(d) {
  if (d.error) return `_${d.error}_`;
  const data = d.data;
  if (!data || data.note === 'not-found') return '_нет группы_';
  if (data.note === 'no-lessons' || !data.rows.length) return data.weekend ? 'выходной' : 'пар нет';
  return (
    data.rows
      .filter((r) => r.kind !== 'free')
      .slice(0, 8)
      .map((r) => `${r.pair ?? '·'}·${(r.start || '—').slice(0, 5)} ${trunc(r.subject, 16)}`)
      .join('\n') || 'пар нет'
  );
}

const weekLabel = (week) =>
  week.days.map((d) => d.data && (d.data.group || d.data.teacher)).find(Boolean) || '';

function weekEmbed(week) {
  const mon = week.days[0].parts;
  const sat = week.days[week.days.length - 1].parts;
  const grp = weekLabel(week);
  const embed = new EmbedBuilder()
    .setColor(C.weekday)
    .setTitle(`Неделя ${D.fmtDM(mon)} – ${D.fmtDM(sat)}${grp ? `, ${grp}` : ''}`);
  for (const d of week.days) {
    embed.addFields({
      name: `${DAYS_RU[D.weekdayIso(d.parts) - 1]} ${D.fmtDM(d.parts)}`,
      value: clip(dayCell(d)),
      inline: true,
    });
  }
  return embed;
}

function weekText(week) {
  const mon = week.days[0].parts;
  const sat = week.days[week.days.length - 1].parts;
  const grp = weekLabel(week);
  const out = [`**Неделя ${D.fmtDM(mon)} – ${D.fmtDM(sat)}${grp ? `, ${grp}` : ''}**`];
  for (const d of week.days) {
    out.push('', `**${DAYS_RU[D.weekdayIso(d.parts) - 1]} ${D.fmtDM(d.parts)}**`, dayCell(d));
  }
  return out.join('\n');
}

function buildWeekView(week, format) {
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wk:prev').setLabel('◀ неделя').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('wk:this').setLabel('Эта неделя').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('wk:next').setLabel('неделя ▶').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('wk:menu').setLabel('В меню').setStyle(ButtonStyle.Primary),
  );
  if (format === 'text') return { content: weekText(week).slice(0, 1990), embeds: [], components: [nav] };
  return { content: '', embeds: [weekEmbed(week)], components: [nav] };
}

// ---- Расписание звонков --------------------------------------

function bellView() {
  const fmt = (tbl) => [1, 2, 3, 4, 5, 6, 7].map((p) => `${p}. ${tbl[p][0]}–${tbl[p][1]}`).join('\n');
  const embed = new EmbedBuilder()
    .setColor(C.weekday)
    .setTitle('🔔 Расписание звонков')
    .addFields(
      { name: 'Будни (Пн–Пт)', value: fmt(ss.BELL_WEEKDAY), inline: true },
      { name: 'Выходные (Сб–Вс)', value: fmt(ss.BELL_WEEKEND), inline: true },
    );
  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu:refresh').setLabel('← В меню').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ---- Админ-панель ------------------------------------------

const ADMIN_COLOR = 0xd9a441;
const adminBack = () =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adm:menu').setLabel('← Назад').setStyle(ButtonStyle.Secondary),
  );

function buildAdminMenu() {
  const embed = new EmbedBuilder()
    .setColor(ADMIN_COLOR)
    .setTitle('🛠 Панель администратора')
    .setDescription('Объявления, статистика, управление админами.');
  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('adm:announce').setLabel('📢 Объявление').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('adm:stats').setLabel('📊 Статистика').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('adm:admins').setLabel('👥 Админы').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function buildStatsView(s) {
  const top =
    Object.entries(s.byGroup)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([g, n]) => `${g} — ${n}`)
      .join('\n') || '—';
  const embed = new EmbedBuilder()
    .setColor(ADMIN_COLOR)
    .setTitle('📊 Статистика')
    .addFields(
      { name: 'Пользователей', value: String(s.total), inline: true },
      { name: 'С группой/фамилией', value: String(s.withGroup), inline: true },
      { name: 'Подписано', value: String(s.subscribed), inline: true },
      { name: 'Преподавателей', value: String(s.teachers || 0), inline: true },
      { name: 'Напоминания вкл', value: String(s.reminders), inline: true },
      { name: 'Текстовый формат', value: String(s.textFormat), inline: true },
      { name: 'Открытых вопросов', value: String(s.openQuestions), inline: true },
      { name: 'Подписки по группам', value: clip(top) },
    );
  return { content: '', embeds: [embed], components: [adminBack()] };
}

function buildAdminsView(adminIds, selfId) {
  const embed = new EmbedBuilder()
    .setColor(ADMIN_COLOR)
    .setTitle('👥 Администраторы')
    .setDescription(adminIds.map((id) => `• \`${id}\`${id === String(selfId) ? ' (ты)' : ''}`).join('\n') || '—');
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('adm:addadmin').setLabel('➕ Добавить').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('adm:menu').setLabel('← Назад').setStyle(ButtonStyle.Secondary),
    ),
  ];
  if (adminIds.length > 1) {
    for (let i = 0; i < adminIds.length && rows.length < 5; i += 5) {
      rows.push(
        new ActionRowBuilder().addComponents(
          ...adminIds.slice(i, i + 5).map((id) =>
            new ButtonBuilder()
              .setCustomId(`adm:del:${id}`)
              .setLabel(`✖ …${id.slice(-4)}`)
              .setStyle(ButtonStyle.Danger),
          ),
        ),
      );
    }
  }
  return { content: '', embeds: [embed], components: rows };
}

function announceModal() {
  return new ModalBuilder()
    .setCustomId('modal:announce')
    .setTitle('Объявление подписчикам')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('text')
          .setLabel('Текст объявления')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1800),
      ),
    );
}

// ---- Свободные кабинеты --------------------------------------

function roomsModal() {
  return new ModalBuilder()
    .setCustomId('modal:rooms')
    .setTitle('Свободные кабинеты')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('pair')
          .setLabel('Номер пары (1–7)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(1)
          .setPlaceholder('3'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('date')
          .setLabel('Дата дд.мм (пусто — сегодня)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setPlaceholder('05.09'),
      ),
    );
}

function buildRoomsView(result, target) {
  const embed = new EmbedBuilder()
    .setColor(C.search)
    .setTitle(`🚪 Кабинеты — ${D.fmtDM(target)} (${D.weekdayRu(target)}), пара ${result.pair}`)
    .addFields(
      { name: `Свободно (${result.free.length})`, value: clip(result.free.join(', ') || '—') },
      { name: `Занято (${result.busy.length})`, value: clip(result.busy.join(', ') || '—') },
    )
    .setFooter({ text: 'Учитываются только кабинеты, встречающиеся в расписании на этот день' });
  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu:rooms').setLabel('🔁 Другая пара/дата').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('menu:refresh').setLabel('← В меню').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

function addAdminModal() {
  return new ModalBuilder()
    .setCustomId('modal:addadmin')
    .setTitle('Добавить администратора')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('id')
          .setLabel('Discord ID пользователя')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20)
          .setPlaceholder('123456789012345678'),
      ),
    );
}

module.exports = {
  buildMenu,
  buildGroupPicker,
  buildDaysView,
  buildReminderView,
  buildRoleView,
  setTeacherModal,
  buildWeekView,
  bellView,
  scheduleEmbed,
  scheduleMessage,
  buildScheduleView,
  buildLookupView,
  buildAdminMenu,
  buildStatsView,
  buildAdminsView,
  groupModal,
  timeModal,
  askModal,
  answerModal,
  searchModal,
  teacherModal,
  reportModal,
  roomsModal,
  buildRoomsView,
  announceModal,
  addAdminModal,
  adminQuestionMessage,
  answerMessage,
  REMINDER_OPTS,
  GROUPS_PER_PAGE,
};
