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
const render = require('./render');

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
const isoToDM = (iso) => {
  const t = D.partsFromIso(iso);
  return t ? D.fmtDM(t) : iso;
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
  ];
  if (noSubj) {
    fields.push({ name: 'Рассылка', value: '_нужна группа или фамилия_', inline: true });
  } else if (!s.subscribed) {
    fields.push({ name: 'Рассылка', value: '⛔ выключена', inline: true });
  } else if (extras.pausedUntil) {
    fields.push({ name: 'Рассылка', value: `⏸ пауза до ${isoToDM(extras.pausedUntil)}`, inline: true });
  } else {
    fields.push({
      name: 'Ближайшая рассылка',
      value: nb ? `📬 <t:${nb}:R> (<t:${nb}:t>)` : '—',
      inline: true,
    });
  }
  if (!noSubj && extras.nextPair) {
    fields.push({ name: 'Следующая пара', value: String(extras.nextPair).slice(0, 1024), inline: false });
  }

  const embed = new EmbedBuilder()
    .setColor(teacherMode ? C.teacher : C.weekday)
    .setTitle('🎓 Расписание — Кооперативный техникум')
    .setDescription(
      noSubj
        ? 'Чтобы начать — открой ⚙️ Настройки и укажи группу (или свою фамилию в разделе «Роль»).'
        : 'Расписание пар приходит в личные сообщения.',
    )
    .addFields(fields)
    .setFooter({ text: 'Петрозаводск • koopteh10.ru' });

  const row1 = new ActionRowBuilder().addComponents(
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
    new ButtonBuilder().setCustomId('menu:settings').setLabel('⚙️ Настройки').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('menu:search').setLabel('🔍 Поиск').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('menu:teacher').setLabel('👨‍🏫 Преподаватель').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('menu:bell').setLabel('🔔 Звонки').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('menu:rooms').setLabel('🚪 Кабинеты').setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('menu:ask').setLabel('❓ Задать вопрос').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('menu:help').setLabel('ℹ️ Помощь').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('menu:refresh').setLabel('🔄 Обновить').setStyle(ButtonStyle.Secondary),
  );
  if (extras.showBus) {
    row3.addComponents(new ButtonBuilder().setCustomId('menu:bus').setLabel('🚌 Автобус').setStyle(ButtonStyle.Secondary));
  }

  return { content: '', embeds: [embed], files: [], components: [row1, row2, row3] };
}

// ---- Помощь ------------------------------------------------------

function buildHelpView({ inMenu = false } = {}) {
  const embed = new EmbedBuilder()
    .setColor(C.weekday)
    .setTitle('ℹ️ Как пользоваться ботом')
    .setDescription('Всё приходит в личные сообщения. Настройка — через `/start` → ⚙️ Настройки.')
    .addFields(
      {
        name: 'Команды',
        value: [
          '`/start` — меню и все настройки',
          '`/расписание [группа] [дата]` — расписание на день',
          '`/сейчас` — текущая и следующая пара + до звонка',
          '`/поиск` — кабинет, преподаватель, `предмет` (ближайшая пара), `группа` (что идёт сейчас), `пара` (свободен ли)',
          '`/преподаватель <фамилия> [дата]` · `/преподаватели` — кто что ведёт',
          '`/звонки` — расписание звонков · `/помощь` — эта справка',
        ].join('\n'),
      },
      {
        name: 'Кнопки в меню',
        value: [
          '📅 **Расписание / Неделя** — на сегодня и обзор пн–сб (неделю можно картинкой)',
          '📨 **На завтра** — прислать расписание отдельным сообщением',
          '📝 **Заметка к паре** — на экране расписания: «взять чертёж» и т.п.',
          '🔍 **Поиск** · 👨‍🏫 **Преподаватель** · 🚪 **Кабинеты** · 🔔 **Звонки**',
          '❓ **Задать вопрос** — написать администратору',
        ].join('\n'),
      },
      {
        name: '⚙️ Настройки',
        value: [
          'Группа и роль (студент / преподаватель)',
          'Ежедневная рассылка: время, дни недели, вкл/выкл',
          '⏸ Пауза — заглушить всё на время (практика, отпуск); напомнит за день до конца',
          '⏰ Напоминания за N минут · ☀️ Утро (+ свой текст приветствия)',
          'Формат: эмбед / текст / картинка · 🎨 цвет эмбеда · показывать ли «окна»',
          '🏘 **Не из города** — погода по месту жительства и кнопка «🚌 Автобус» (до техникума и обратно)',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'Петрозаводск • koopteh10.ru' });
  const components = inMenu
    ? [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('menu:refresh').setLabel('← В меню').setStyle(ButtonStyle.Primary),
        ),
      ]
    : [];
  return { content: '', embeds: [embed], files: [], components };
}

// ---- Формат вывода расписания (эмбед / текст / картинка) ------------

const fmtLabel = (f) => (f === 'image' ? 'картинка' : f === 'text' ? 'текст' : 'эмбед');
const fmtField = (f) => (f === 'image' ? '🖼 картинка' : f === 'text' ? '📄 текст' : '📊 эмбед');

/** Следующий формат по кругу. «Картинку» предлагаем только если рендер доступен. */
function nextFormat(cur) {
  const order = render.available() ? ['embed', 'text', 'image'] : ['embed', 'text'];
  const i = order.indexOf(cur);
  return order[(i + 1) % order.length];
}

// ---- Цветовая тема эмбеда расписания -------------------------------

const THEMES = {
  default: null,
  blue: 0x2b6cb0,
  green: 0x2f9e44,
  purple: 0x7048e8,
  teal: 0x1098ad,
  orange: 0xd9822b,
  pink: 0xd6336c,
  graphite: 0x495057,
};
const THEME_LABEL = {
  default: 'по умолчанию',
  blue: '🔵 синяя',
  green: '🟢 зелёная',
  purple: '🟣 фиолетовая',
  teal: '🩵 бирюзовая',
  orange: '🟠 оранжевая',
  pink: '🩷 розовая',
  graphite: '⚫ графит',
};
const THEME_ORDER = Object.keys(THEMES);
function nextTheme(cur) {
  const i = THEME_ORDER.indexOf(cur);
  return THEME_ORDER[(i + 1) % THEME_ORDER.length];
}
const themeColor = (theme) => (theme && THEMES[theme] != null ? THEMES[theme] : null);

// ---- Настройки -----------------------------------------------------

function buildSettingsView(s) {
  const noSubj = !s.subj;
  const teacherMode = s.role === 'teacher' && s.teacherName;
  const paused = s.pausedUntil && s.pausedUntil > D.iso(D.todayParts());
  const embed = new EmbedBuilder()
    .setColor(C.weekday)
    .setTitle('⚙️ Настройки')
    .addFields(
      { name: 'Группа', value: s.group ? `**${s.group}**` : '_не указана_', inline: true },
      {
        name: 'Роль',
        value: teacherMode ? `👨‍🏫 преподаватель — **${s.teacherName}**` : '🎓 студент',
        inline: true,
      },
      {
        name: 'Рассылка',
        value: noSubj
          ? '_нужна группа/фамилия_'
          : paused
            ? `⏸ пауза до ${isoToDM(s.pausedUntil)}`
            : s.subscribed
              ? '✅ включена'
              : '⛔ выключена',
        inline: true,
      },
      { name: 'Время', value: `🕘 ${s.time}${s.customTime ? '' : ' (по умолч.)'}`, inline: true },
      { name: 'Дни', value: `📆 ${daysLabel(s.days)}`, inline: true },
      { name: 'Напоминания', value: s.reminderMinutes ? `⏰ за ${s.reminderMinutes} мин` : '⏰ выкл', inline: true },
      { name: 'Утро', value: s.morning ? `☀️ ${s.morningTime}` : '☀️ выкл', inline: true },
      { name: 'Формат', value: fmtField(s.format), inline: true },
      { name: 'Цвет', value: `🎨 ${THEME_LABEL[s.theme] || s.theme || 'по умолчанию'}`, inline: true },
      { name: 'Окна «пар нет»', value: s.showGaps ? 'показывать' : 'скрывать', inline: true },
      { name: 'Не из города', value: s.away && s.homePlace ? `🏘 ${s.homePlace}` : '—', inline: true },
      { name: 'Погода', value: fmtField(s.weatherFormat), inline: true },
    );
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('set:group')
      .setLabel(s.group ? '🎓 Сменить группу' : '🎓 Указать группу')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('set:role').setLabel('👤 Роль').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('set:pause')
      .setLabel(paused ? '⏸ Пауза (вкл)' : '⏸ Пауза')
      .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(noSubj),
    new ButtonBuilder()
      .setCustomId('set:away')
      .setLabel(s.away ? '🏘 Не из города (вкл)' : '🏘 Не из города')
      .setStyle(s.away ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('set:togglesub')
      .setLabel(s.subscribed ? 'Отключить рассылку' : 'Включить рассылку')
      .setStyle(s.subscribed ? ButtonStyle.Danger : ButtonStyle.Success)
      .setDisabled(noSubj),
    new ButtonBuilder().setCustomId('set:time').setLabel(`🕘 ${s.time}`).setStyle(ButtonStyle.Secondary).setDisabled(noSubj),
    new ButtonBuilder().setCustomId('set:days').setLabel('📆 Дни').setStyle(ButtonStyle.Secondary).setDisabled(noSubj),
    new ButtonBuilder().setCustomId('set:reminder').setLabel('⏰ Напоминания').setStyle(ButtonStyle.Secondary).setDisabled(noSubj),
    new ButtonBuilder().setCustomId('set:morning').setLabel('☀️ Утро').setStyle(ButtonStyle.Secondary).setDisabled(noSubj),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('set:togglegaps')
      .setLabel(s.showGaps ? 'Окна: скрыть' : 'Окна: показать')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(noSubj),
    new ButtonBuilder()
      .setCustomId('set:format')
      .setLabel(`Формат: ${fmtLabel(s.format)}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('set:theme').setLabel('🎨 Цвет').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('set:wthrformat').setLabel(`Погода: ${fmtLabel(s.weatherFormat)}`).setStyle(ButtonStyle.Secondary),
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('set:back').setLabel('← В меню').setStyle(ButtonStyle.Primary),
  );
  return { content: '', embeds: [embed], files: [], components: [row1, row2, row3, row4] };
}

// ---- «Я не из города» — домашние погода и автобус -------------------

function buildAwayView(s) {
  const embed = new EmbedBuilder()
    .setColor(C.weekday)
    .setTitle('🏘 Я не из города')
    .setDescription(
      'Если включено — присылаю ещё и погоду по месту жительства (вторым сообщением, отдельно от городской), ' +
        'и расписание автобуса до техникума и обратно (кнопка «🚌 Автобус» в меню).\n\n' +
        `Статус: ${s.away ? '✅ включено' : '⛔ выключено'}\n` +
        `Населённый пункт: ${s.homePlace ? `**${s.homePlace}**` : '_не указан_'}\n` +
        `Остановка: ${s.homeStop ? `**${s.homeStop}**` : '_не указана — время автобуса будет примерным_'}`,
    );
  return {
    content: '',
    embeds: [embed],
    files: [],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('away:toggle')
          .setLabel(s.away ? 'Выключить' : 'Включить')
          .setStyle(s.away ? ButtonStyle.Danger : ButtonStyle.Success)
          .setDisabled(!s.homePlace && !s.away),
        new ButtonBuilder().setCustomId('away:place').setLabel('🏘 Населённый пункт').setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('away:stop')
          .setLabel('🚏 Остановка')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!s.homePlace),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('away:back').setLabel('← Назад').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function awayPlaceModal(current) {
  const input = new TextInputBuilder()
    .setCustomId('place')
    .setLabel('Населённый пункт (пусто — выключить)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(80)
    .setPlaceholder('Новая Вилга');
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId('modal:awayplace')
    .setTitle('Населённый пункт')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function awayStopModal(current) {
  const input = new TextInputBuilder()
    .setCustomId('stop')
    .setLabel('Номер (1/2/3) или название (пусто — примерно)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(60)
    .setPlaceholder('2 (или «кладбище», если другая остановка)');
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId('modal:awaystop')
    .setTitle('Остановка')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

// ---- Погода: сообщение (эмбед / текст / картинка) и расписание автобуса ----

function buildWeatherMessage(place, forecast, format) {
  const advice = forecast.advice || [];
  const body = (forecast.ranges || [])
    .map((r) => `${r.label} — ${r.icon} ${r.temp > 0 ? '+' : ''}${r.temp}°`)
    .join('\n');

  if (format === 'image') {
    const buf = render.available() ? render.renderWeatherImage(place, forecast) : null;
    if (buf) return { content: '', embeds: [], files: [{ attachment: buf, name: 'pogoda.png' }] };
    // нет canvas — откат на эмбед
  }
  if (format === 'text') {
    const lines = [`**🌤 Погода — ${place}**`];
    if (advice.length) lines.push(advice.join('\n'));
    lines.push('', body || 'нет данных');
    return { content: lines.join('\n').slice(0, 1990), embeds: [], files: [] };
  }
  const embed = new EmbedBuilder()
    .setColor(C.weekday)
    .setTitle(`🌤 Погода — ${place}`)
    .addFields({ name: 'Прогноз на сегодня', value: clip(body || 'нет данных') });
  if (advice.length) embed.setDescription(advice.join('\n'));
  return { content: '', embeds: [embed], files: [] };
}

/**
 * direction 'toHome' — едет из города домой: отправление с автовокзала точное,
 * а вот прибытие домой — плюс-минус ~10 мин (обычно задерживается).
 * direction 'toCity' — едет из дома в город: домой автобус подъезжает
 * тоже с задержкой ~10 мин (это промежуточная точка маршрута), а вот
 * прибытие в город после — как в расписании.
 */
/** Расписание одно и то же каждый день («ежедневно» у перевозчика) — на нужный день просто пересчитываем эпохи. */
function withEpochs(rows, target) {
  return (rows || []).map((r) => ({ ...r, epoch: r.depHHMM ? D.epochAt(target, r.depHHMM) : null }));
}

function busLine(rows, direction, target) {
  const isToday = D.iso(target) === D.iso(D.todayParts());
  const dated = withEpochs(rows, target);
  if (!dated.length) return 'нет данных';
  const now = Date.now();
  const next = isToday ? dated.find((r) => r.epoch && r.epoch * 1000 > now) : dated[0];
  if (!next) return 'рейсов на этот день больше нет';
  const head = [next.number, next.title].filter(Boolean).join(' ');
  const rel = next.epoch ? `<t:${next.epoch}:R>` : `в ${next.depHHMM}`;
  const dep = next.depHHMM ? `отправление ${next.depHHMM}` : '';
  const arr = next.arrHHMM ? `прибытие ${next.arrHHMM}` : '';
  const late = ' (±10 мин)';
  const detail =
    direction === 'toHome'
      ? [dep, arr && `${arr}${late}`].filter(Boolean).join(', ')
      : [dep && `${dep}${late}`, arr].filter(Boolean).join(', ');
  return `${head ? `${head} — ` : ''}${rel}${detail ? `\n${detail}` : ''}`;
}

function buildBusView(place, toHomeRows, toCityRows, toHomeUrl, toCityUrl, isoStr) {
  const target = D.partsFromIso(isoStr) || D.todayParts();
  const todayIso = D.iso(D.todayParts());
  const tomIso = D.iso(D.tomorrowParts());
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bus:prev:${isoStr}`).setLabel('◀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bus:jump:today').setLabel('Сегодня').setStyle(ButtonStyle.Secondary).setDisabled(isoStr === todayIso),
    new ButtonBuilder().setCustomId('bus:jump:tomorrow').setLabel('Завтра').setStyle(ButtonStyle.Secondary).setDisabled(isoStr === tomIso),
    new ButtonBuilder().setCustomId(`bus:next:${isoStr}`).setLabel('▶').setStyle(ButtonStyle.Secondary),
  );
  const list = (rows) => clip((rows || []).map((r) => `${r.depHHMM} → ${r.arrHHMM}`).join('\n') || '—');
  const withLink = (line, url) => (url ? `${line}\n🔗 Проверить: ${url}` : line);
  const embed = new EmbedBuilder()
    .setColor(C.weekday)
    .setTitle(`🚌 Автобус — ${place} · ${D.fmtDM(target)} (${D.weekdayRu(target)})`)
    .addFields(
      { name: 'Ближайший из города (домой)', value: withLink(busLine(toHomeRows, 'toHome', target), toHomeUrl), inline: false },
      { name: 'Ближайший из дома (в город)', value: withLink(busLine(toCityRows, 'toCity', target), toCityUrl), inline: false },
      { name: 'Все рейсы из города', value: list(toHomeRows), inline: true },
      { name: 'Все рейсы из дома', value: list(toCityRows), inline: true },
    )
    .setFooter({ text: 'расписание ежедневное · из города — автовокзал/Яндекс, из дома — Яндекс' });
  return {
    content: '',
    embeds: [embed],
    files: [],
    components: [
      nav,
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu:bus').setLabel('🔄 Обновить').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('menu:refresh').setLabel('← В меню').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ---- Пауза подписки -------------------------------------------------

function buildPauseView(s) {
  const active = s.pausedUntil && s.pausedUntil > D.iso(D.todayParts());
  const embed = new EmbedBuilder()
    .setColor(active ? C.none : C.weekday)
    .setTitle('⏸ Пауза подписки')
    .setDescription(
      (active
        ? `Сейчас на паузе. Рассылка, утро и напоминания вернутся **${isoToDM(s.pausedUntil)}**.`
        : 'Заглушить рассылку, утреннее сообщение и напоминания на время (практика, отпуск, каникулы). Ручной просмотр и команды продолжают работать.') +
        '\n\nВыбери, до какого дня молчать (в этот день всё включится само):',
    );
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pause:days:7').setLabel('на неделю').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pause:days:14').setLabel('на 2 недели').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pause:days:30').setLabel('на месяц').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pause:date').setLabel('📅 До даты…').setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('pause:off')
      .setLabel('Снять паузу')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!active),
    new ButtonBuilder().setCustomId('pause:back').setLabel('← Назад').setStyle(ButtonStyle.Secondary),
  );
  return { content: '', embeds: [embed], files: [], components: [row1, row2] };
}

function pauseDateModal(current) {
  const input = new TextInputBuilder()
    .setCustomId('date')
    .setLabel('Вернуться дд.мм (до этого дня — тишина)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(10)
    .setPlaceholder('20.09');
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId('modal:pausedate')
    .setTitle('Пауза до даты')
    .addComponents(new ActionRowBuilder().addComponents(input));
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

const stripEmoji = (s) => String(s).replace(/^🔔\s*/, '');

/** Короткая строка «следующая пара» для меню (режим группы или преподавателя). */
function nextPairLine(data) {
  if (!data || data.note || !Array.isArray(data.rows) || !data.rows.length) return null;
  const lessons = data.rows.filter((r) => r.kind === 'lesson' && r.start);
  if (!lessons.length) return null;
  const T = data.target;
  const isToday = D.iso(T) === D.iso(D.todayParts());
  const now = D.tzNow();
  const nowMin = now.h * 60 + now.mi;
  const R = (hhmm) => {
    const ep = D.epochAt(T, hhmm);
    return ep ? `<t:${ep}:R>` : `в ${hhmm}`;
  };
  const desc = (r) =>
    `${r.pair ? `${r.pair}. ` : ''}${stripEmoji(r.subject)}${r.room ? `, ауд. ${r.room}` : ''}`;

  if (!isToday) {
    const f = lessons[0];
    return `${desc(f)} — ${R(f.start)} (в ${f.start})`;
  }
  const cur = lessons.find((r) => {
    const s = D.toMinutes(r.start);
    const e = D.toMinutes(r.end);
    return s != null && e != null && s <= nowMin && nowMin < e;
  });
  if (cur) return `сейчас ${desc(cur)} — до ${R(cur.end)}`;
  const nx = lessons.find((r) => (D.toMinutes(r.start) ?? 1e9) > nowMin);
  if (!nx) return 'на сегодня всё';
  return `${desc(nx)} — ${R(nx.start)} (в ${nx.start})`;
}

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

function scheduleEmbed(data, humanUrl, theme) {
  const mode = data.mode || 'group';
  const weekend = D.weekdayIso(data.target) >= 6;
  const isToday = D.iso(data.target) === D.iso(D.todayParts());
  const embed = new EmbedBuilder();
  const applyTheme = () => {
    const tc = themeColor(theme);
    if (tc != null) embed.setColor(tc);
  };

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
    applyTheme();
    return { content: '', embeds: [embed], components: [] };
  }
  if (data.note === 'no-lessons' || !data.rows.length) {
    embed.setDescription(`${descLines.length ? `${descLines.join('\n')}\n\n` : ''}**${noLessonsMsg(data)}**`);
    applyTheme();
    return { content: '', embeds: [embed], components: [] };
  }
  const summary = summaryLine(data);
  const desc = summary ? [...descLines, '', `📋 ${summary}`] : descLines;
  if (desc.length) embed.setDescription(desc.join('\n'));

  // Выделяем только текущую пару (сегодня, режим группы).
  let curIdx = -1;
  if (isToday && mode === 'group') {
    const now = D.tzNow();
    const nowMin = now.h * 60 + now.mi;
    data.rows.forEach((r, i) => {
      if (curIdx >= 0 || r.kind !== 'lesson') return;
      const sMin = D.toMinutes(r.start);
      const eMin = D.toMinutes(r.end);
      if (sMin != null && eMin != null && sMin <= nowMin && nowMin < eMin) curIdx = i;
    });
  }

  const col1 = [];
  const col2 = [];
  const col3 = [];
  data.rows.forEach((r, i) => {
    const cur = i === curIdx;
    const w = (t) => (cur ? `**${t}**` : t);
    const subj = r.subject || '—';
    col1.push(w(`${cur ? '▸ ' : '• '}${timeCol(r)}`));
    if (mode === 'search') {
      col2.push(w(subj));
      col3.push(w([r.room && `каб. ${r.room}`, r.groupsText, r.teacher].filter(Boolean).join(' · ') || '—'));
    } else {
      const c2 = r.room ? `${subj} | ${r.room}` : subj;
      col2.push(w(c2 + (r.note ? ` — 📝 ${r.note}` : '')));
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

  applyTheme();
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
    lines.push(`**Предмет:** ${r.subject}`);
    if (r.room) lines.push(`**Кабинет:** ${r.room}`);
    if (r.note) lines.push(`**📝 Заметка:** ${r.note}`);
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

/** Текст «что именно поменялось» для уведомления об изменении расписания. */
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
  if (total > 8) {
    return `⚠️ **Расписание на ${D.fmtDM(target)} сильно изменилось** (${total} изменений), актуальная версия ниже:`;
  }
  const lines = [`📝 **Что изменилось на ${D.fmtDM(target)}:**`];
  for (const c of diff.changed) lines.push(`• ${num(c.to)}: ${label(c.from)} → ${label(c.to)}`);
  for (const r of diff.added) lines.push(`• добавилась ${num(r)}: ${label(r)}`);
  for (const r of diff.removed) lines.push(`• убрали ${num(r)}: ${label(r)}`);
  return lines.join('\n').slice(0, 1900);
}

/** Единый payload расписания: эмбед / текст / картинка (по настройке пользователя). */
function scheduleMessage(data, humanUrl, format, theme) {
  if (format === 'image') {
    const buf = render.available() ? render.renderScheduleImage(data) : null;
    if (buf) {
      return {
        content: '',
        embeds: [],
        files: [{ attachment: buf, name: `raspisanie-${D.iso(data.target)}.png` }],
      };
    }
    // картинки нет (нет пар / режим не «группа» / нет canvas) — откат на эмбед
    return scheduleEmbed(data, humanUrl, theme);
  }
  if (format === 'text') {
    return { content: scheduleTextRich(data, humanUrl).slice(0, 1990), embeds: [] };
  }
  return scheduleEmbed(data, humanUrl, theme);
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

function buildScheduleView(data, isoStr, humanUrl, errorText, format, theme) {
  const nav = scheduleNav(isoStr);
  if (errorText) return { content: errorText, embeds: [], files: [], components: [nav] };

  const canImg = render.available() && (data.mode || 'group') === 'group' && !data.note && data.rows.length;
  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sch:send:${isoStr}`).setLabel('📨 Прислать').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sch:share:${isoStr}`).setLabel('📋 Текстом').setStyle(ButtonStyle.Secondary),
  );
  if (canImg) {
    actions.addComponents(
      new ButtonBuilder().setCustomId(`sch:img:${isoStr}`).setLabel('🖼 Картинкой').setStyle(ButtonStyle.Secondary),
    );
  }
  actions.addComponents(
    new ButtonBuilder().setCustomId(`sch:report:${isoStr}`).setLabel('⚠️ Ошибка').setStyle(ButtonStyle.Danger),
  );
  if (humanUrl && /^https?:\/\//.test(humanUrl)) {
    actions.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(humanUrl).setLabel('🔗 Источник'));
  }

  const rows = [nav, actions];
  if ((data.mode || 'group') === 'group' && !data.note) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sch:note:${isoStr}`).setLabel('📝 Заметка к паре').setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  const base = scheduleMessage(data, humanUrl, format, theme);
  return {
    content: base.content || '',
    embeds: base.embeds || [],
    files: base.files || [],
    components: rows,
  };
}

// ---- Экран поиска / преподавателя (навигация по датам через lookupState) ----

function buildLookupView(data, humanUrl, format, errorText, theme) {
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lk:prev').setLabel('◀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('lk:day:today').setLabel('Сегодня').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('lk:day:tomorrow').setLabel('Завтра').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('lk:next').setLabel('▶').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('lk:menu').setLabel('В меню').setStyle(ButtonStyle.Primary),
  );
  if (errorText) return { content: errorText, embeds: [], files: [], components: [nav] };
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
  const base = scheduleMessage(data, humanUrl, format, theme);
  return { content: base.content || '', embeds: base.embeds || [], files: base.files || [], components: rows };
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

// ---- Утреннее сообщение --------------------------------------

function buildMorningView(s) {
  const embed = new EmbedBuilder()
    .setColor(C.weekday)
    .setTitle('☀️ Утреннее сообщение')
    .setDescription(
      `Короткая сводка на сегодня утром: сколько пар и во сколько первая (или «выходной»)${
        cfg.weatherEnabled ? `, плюс погода в ${cfg.weatherPlace}` : ''
      }.\n` +
        `Сейчас: ${s.morning ? `**вкл, ${s.morningTime}**` : '**выкл**'}. Учитывает выбранные дни недели.\n` +
        `Приветствие: ${s.morningGreeting ? `«${s.morningGreeting}»` : '☀️ Доброе утро! _(по умолчанию)_'}`,
    );
  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('mrn:toggle')
          .setLabel(s.morning ? 'Выключить' : 'Включить')
          .setStyle(s.morning ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('mrn:time').setLabel(`🕗 ${s.morningTime}`).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('mrn:greeting').setLabel('✍️ Приветствие').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('mrn:done').setLabel('Готово').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

function morningGreetingModal(current) {
  const input = new TextInputBuilder()
    .setCustomId('text')
    .setLabel('Свой текст (пусто — вернуть по умолчанию)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(120)
    .setPlaceholder('☀️ Доброе утро, солнышко!');
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId('modal:morninggreeting')
    .setTitle('Утреннее приветствие')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function morningTimeModal(current) {
  const input = new TextInputBuilder()
    .setCustomId('time')
    .setLabel('Время утром, ЧЧ:ММ')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(5)
    .setPlaceholder('07:30');
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId('modal:morningtime')
    .setTitle('Время утреннего сообщения')
    .addComponents(new ActionRowBuilder().addComponents(input));
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

function noteModal(iso) {
  return new ModalBuilder()
    .setCustomId(`modal:note:${iso}`)
    .setTitle(`Заметка к паре — ${isoToDM(iso)}`)
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
          .setCustomId('text')
          .setLabel('Текст заметки (пусто — удалить)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(150)
          .setPlaceholder('взять чертёж'),
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
  const rows = [nav];
  if (render.available()) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('wk:img').setLabel('🖼 Картинкой').setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  if (format === 'text') return { content: weekText(week).slice(0, 1990), embeds: [], files: [], components: rows };
  return { content: '', embeds: [weekEmbed(week)], files: [], components: rows };
}

/** Короткий ответ на /сейчас: текущая/следующая пара + статус звонков. */
function buildNowMessage(data, label) {
  const t = D.todayParts();
  const lines = [`🎓 **${label}** — ${D.fmtDM(t)} (${D.weekdayRu(t)})`];
  const npl = data && !data.note ? nextPairLine(data) : null;
  if (!data || data.note === 'not-found') lines.push('расписание на сегодня не найдено');
  else if (data.note === 'no-lessons' || !npl) lines.push(data.weekend ? 'сегодня выходной 🎉' : 'на сегодня пар нет');
  else lines.push(npl);
  lines.push(`🔔 ${bellStatus(t)}`);
  return { content: lines.join('\n') };
}

// ---- Расписание звонков --------------------------------------

/** Живая строка «идёт пара / перемена / до первой» с Discord-таймстампом. */
function bellStatus(t) {
  const weekend = D.weekdayIso(t) >= 6;
  const tbl = weekend ? ss.BELL_WEEKEND : ss.BELL_WEEKDAY;
  const now = D.tzNow();
  const nowMin = now.h * 60 + now.mi;
  const pairs = [1, 2, 3, 4, 5, 6, 7].map((p) => ({
    p,
    s: D.toMinutes(tbl[p][0]),
    e: D.toMinutes(tbl[p][1]),
    start: tbl[p][0],
    end: tbl[p][1],
  }));
  const R = (hhmm) => {
    const ep = D.epochAt(t, hhmm);
    return ep ? `<t:${ep}:R>` : hhmm;
  };
  const cur = pairs.find((x) => x.s <= nowMin && nowMin < x.e);
  if (cur) return `🔔 идёт ${cur.p}-я пара — звонок ${R(cur.end)} (${cur.end})`;
  const next = pairs.find((x) => x.s > nowMin);
  if (!next) return '🔔 пары закончились';
  if (nowMin < pairs[0].s) return `🔔 до ${next.p}-й пары — звонок ${R(next.start)} (${next.start})`;
  return `☕ перемена — звонок на ${next.p}-ю ${R(next.start)} (${next.start})`;
}

function bellView() {
  const fmt = (tbl) => [1, 2, 3, 4, 5, 6, 7].map((p) => `${p}. ${tbl[p][0]}–${tbl[p][1]}`).join('\n');
  const embed = new EmbedBuilder()
    .setColor(C.weekday)
    .setTitle('🔔 Расписание звонков')
    .setDescription(bellStatus(D.todayParts()))
    .addFields(
      { name: 'Будни (Пн–Пт)', value: fmt(ss.BELL_WEEKDAY), inline: true },
      { name: 'Выходные (Сб–Вс)', value: fmt(ss.BELL_WEEKEND), inline: true },
    );
  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu:bell').setLabel('🔄 Обновить').setStyle(ButtonStyle.Secondary),
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
    .setDescription('Объявления (в т.ч. отложенные и по группе), статистика, состояние источника, журнал, админы.');
  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('adm:announce').setLabel('📢 Объявление').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('adm:schann').setLabel('🕓 Отложенные').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('adm:stats').setLabel('📊 Статистика').setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('adm:health').setLabel('🩺 Источник').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('adm:log').setLabel('🧾 Журнал').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('adm:admins').setLabel('👥 Админы').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function buildAdminLogView(entries) {
  const body =
    entries
      .map((e) => `• <t:${Math.floor(e.at / 1000)}:R> · \`…${String(e.adminId).slice(-4)}\` — ${e.action}`)
      .join('\n') || 'пусто';
  const embed = new EmbedBuilder()
    .setColor(ADMIN_COLOR)
    .setTitle('🧾 Журнал действий')
    .setDescription(body.slice(0, 4000));
  return { content: '', embeds: [embed], components: [adminBack()] };
}

function buildSchedAnnView(list) {
  const body =
    list
      .map(
        (x) =>
          `• \`${x.id}\` — ${isoToDM(x.atIso)} ${x.atHHMM} · ${x.group ? x.group : 'всем'}\n  ${String(x.text).replace(/\n/g, ' ').slice(0, 80)}`,
      )
      .join('\n') || 'Запланированных объявлений нет.';
  const embed = new EmbedBuilder()
    .setColor(ADMIN_COLOR)
    .setTitle('🕓 Отложенные объявления')
    .setDescription(body.slice(0, 4000));
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('adm:schann:add').setLabel('➕ Запланировать').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('adm:menu').setLabel('← Назад').setStyle(ButtonStyle.Secondary),
    ),
  ];
  for (let i = 0; i < list.length && rows.length < 5; i += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(
        ...list.slice(i, i + 5).map((x) =>
          new ButtonBuilder()
            .setCustomId(`adm:schann:del:${x.id}`)
            .setLabel(`✖ ${x.id}`)
            .setStyle(ButtonStyle.Danger),
        ),
      ),
    );
  }
  return { content: '', embeds: [embed], components: rows };
}

function schedAnnModal() {
  return new ModalBuilder()
    .setCustomId('modal:schann')
    .setTitle('Отложенное объявление')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('text').setLabel('Текст объявления').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('when').setLabel('Когда: дд.мм ЧЧ:ММ').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16).setPlaceholder('12.09 08:00'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('group').setLabel('Группа (пусто — всем)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40),
      ),
    );
}

/** «Состояние источника» — когда последний раз удалось/не удалось загрузить расписание. */
function buildHealthView(h) {
  const rel = (ms) => (ms ? `<t:${Math.floor(ms / 1000)}:R>` : '—');
  const okAge = h.lastOkAt ? Date.now() - h.lastOkAt : null;
  const dot = okAge == null ? '⚪' : okAge < 20 * 60 * 1000 ? '🟢' : okAge < 60 * 60 * 1000 ? '🟡' : '🔴';
  const state =
    okAge == null
      ? 'загрузок ещё не было'
      : okAge < 20 * 60 * 1000
        ? 'работает'
        : okAge < 60 * 60 * 1000
          ? 'давно не обновлялось'
          : 'похоже, источник недоступен';

  const embed = new EmbedBuilder()
    .setColor(okAge != null && okAge < 60 * 60 * 1000 ? C.none : C.error)
    .setTitle(`${dot} Состояние источника — ${state}`)
    .addFields(
      {
        name: 'Последняя успешная загрузка',
        value: h.lastOkAt ? `${rel(h.lastOkAt)}${h.lastOkIso ? ` · расписание на ${h.lastOkIso}` : ''}` : 'ещё не было',
        inline: false,
      },
      { name: 'Последняя попытка', value: rel(h.lastTryAt), inline: true },
      {
        name: 'Последняя ошибка',
        value: h.lastErrAt
          ? `${rel(h.lastErrAt)} · ${h.lastErrKind === 'not-published' ? 'нет ссылки на дату (норма для будущих дней)' : 'источник недоступен'}\n\`${clip(String(h.lastErrMsg || '—'))}\``
          : '—',
        inline: false,
      },
    )
    .setFooter({ text: 'koopteh10.ru → Google Sheets (CSV)' });
  return { content: '', embeds: [embed], files: [], components: [adminBack()] };
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
      { name: 'Формат: текст', value: String(s.textFormat), inline: true },
      { name: 'Формат: картинка', value: String(s.imageFormat || 0), inline: true },
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
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('group')
          .setLabel('Группа (пусто — всем подписчикам)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(40)
          .setPlaceholder('209ИС-2'),
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
  buildSettingsView,
  buildHelpView,
  buildPauseView,
  pauseDateModal,
  buildAwayView,
  awayPlaceModal,
  awayStopModal,
  buildWeatherMessage,
  buildBusView,
  nextFormat,
  nextTheme,
  buildRoleView,
  setTeacherModal,
  buildMorningView,
  morningTimeModal,
  morningGreetingModal,
  nextPairLine,
  buildWeekView,
  buildNowMessage,
  bellView,
  scheduleEmbed,
  scheduleMessage,
  changeSummaryText,
  buildScheduleView,
  buildLookupView,
  noteModal,
  buildAdminMenu,
  buildAdminLogView,
  buildSchedAnnView,
  schedAnnModal,
  buildHealthView,
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
