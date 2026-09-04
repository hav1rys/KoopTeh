'use strict';

// Сборка всех экранов бота: главное меню /start, выбор группы, дни недели,
// экран расписания с навигацией по датам, формы (модалки), сообщения вопрос/ответ.

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

const COLOR = 0x2b6cb0;
const DAYS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']; // индекс 0 = ISO-день 1
const GROUPS_PER_PAGE = 25;

function daysLabel(days) {
  if (!days || !days.length) return '— (не присылать)';
  if (days.length === 7) return 'каждый день';
  const set = new Set(days);
  return [1, 2, 3, 4, 5, 6, 7].filter((d) => set.has(d)).map((d) => DAYS_RU[d - 1]).join(' ');
}

// ---- Главное меню ------------------------------------------------------

/**
 * @param {{ group, subscribed, time, customTime, days, showGaps }} s
 */
function buildMenu(s) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🎓 Расписание — Кооперативный техникум')
    .setDescription('Расписание пар приходит в личные сообщения. Настрой всё кнопками ниже.')
    .addFields(
      { name: 'Группа', value: s.group ? `**${s.group}**` : '_не указана_', inline: true },
      {
        name: 'Ежедневная рассылка',
        value: !s.group ? '_нужна группа_' : s.subscribed ? '✅ включена' : '⛔ выключена',
        inline: true,
      },
      {
        name: 'Время',
        value: `🕘 ${s.time}${s.customTime ? '' : ' (по умолчанию)'}`,
        inline: true,
      },
      { name: 'Дни рассылки', value: `📆 ${daysLabel(s.days)}`, inline: true },
      { name: 'Окна «пар нет»', value: s.showGaps ? 'показывать' : 'скрывать', inline: true },
    )
    .setFooter({ text: 'Петрозаводск • koopteh10.ru' });

  const noGroup = !s.group;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('menu:setgroup')
      .setLabel(s.group ? 'Сменить группу' : 'Указать группу')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('menu:schedule')
      .setLabel('📅 Расписание')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(noGroup),
    new ButtonBuilder()
      .setCustomId('menu:now')
      .setLabel('📨 Прислать на завтра')
      .setStyle(ButtonStyle.Success)
      .setDisabled(noGroup),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('menu:togglesub')
      .setLabel(s.subscribed ? 'Отключить рассылку' : 'Включить рассылку')
      .setStyle(s.subscribed ? ButtonStyle.Danger : ButtonStyle.Success)
      .setDisabled(noGroup),
    new ButtonBuilder()
      .setCustomId('menu:time')
      .setLabel(`🕘 Время: ${s.time}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(noGroup),
    new ButtonBuilder()
      .setCustomId('menu:days')
      .setLabel('📆 Дни')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(noGroup),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('menu:togglegaps')
      .setLabel(s.showGaps ? 'Окна: скрыть' : 'Окна: показать')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(noGroup),
    new ButtonBuilder()
      .setCustomId('menu:ask')
      .setLabel('❓ Задать вопрос')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('menu:refresh').setLabel('🔄 Обновить').setStyle(ButtonStyle.Secondary),
  );

  return { content: '', embeds: [embed], components: [row1, row2, row3] };
}

// ---- Выбор группы (выпадающий список + листание) ----------------------

function buildGroupPicker(groups, page, { error } = {}) {
  const pages = Math.max(1, Math.ceil(groups.length / GROUPS_PER_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = groups.slice(p * GROUPS_PER_PAGE, p * GROUPS_PER_PAGE + GROUPS_PER_PAGE);

  const embed = new EmbedBuilder().setColor(COLOR).setTitle('Выбор группы');
  const rows = [];

  if (slice.length) {
    embed.setDescription(
      `Всего групп: ${groups.length}. Страница ${p + 1}/${pages}. ` +
        'Нет твоей — пролистай стрелками или введи вручную.',
    );
    const select = new StringSelectMenuBuilder()
      .setCustomId('grp:pick')
      .setPlaceholder('Выбери группу…')
      .addOptions(slice.map((g) => ({ label: g.slice(0, 100), value: g.slice(0, 100) })));
    rows.push(new ActionRowBuilder().addComponents(select));
  } else {
    embed.setDescription(error || 'Список групп получить не удалось. Введи название вручную.');
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`grp:page:${p - 1}`)
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p <= 0 || !slice.length),
      new ButtonBuilder()
        .setCustomId(`grp:page:${p + 1}`)
        .setLabel('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p >= pages - 1 || !slice.length),
      new ButtonBuilder().setCustomId('grp:manual').setLabel('Ввести вручную').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('grp:cancel').setLabel('Назад').setStyle(ButtonStyle.Secondary),
    ),
  );

  return { content: '', embeds: [embed], components: rows };
}

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

// ---- Дни недели -------------------------------------------------------

function buildDaysView(days) {
  const set = new Set(days);
  const btn = (isoDay) =>
    new ButtonBuilder()
      .setCustomId(`days:toggle:${isoDay}`)
      .setLabel(DAYS_RU[isoDay - 1])
      .setStyle(set.has(isoDay) ? ButtonStyle.Success : ButtonStyle.Secondary);

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Дни рассылки')
    .setDescription(
      'Зелёный день — расписание **на этот день** будет приходить накануне.\n' +
        'Нажми, чтобы включить/выключить. Сейчас: ' +
        `**${daysLabel(days)}**`,
    );

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

// ---- Экран расписания с навигацией по датам --------------------------

function buildScheduleView(text, isoStr, humanUrl) {
  const todayIso = D.iso(D.todayParts());
  const tomIso = D.iso(D.tomorrowParts());

  // custom_id у стрелок и «Сегодня/Завтра» разных пространств имён —
  // иначе при совпадении дат Discord ругается на дублирующийся custom_id.
  const nav = new ActionRowBuilder().addComponents(
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

  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sch:send:${isoStr}`)
      .setLabel('📨 Прислать сообщением')
      .setStyle(ButtonStyle.Success),
  );
  if (humanUrl && /^https?:\/\//.test(humanUrl)) {
    actions.addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(humanUrl).setLabel('🔗 Источник'),
    );
  }

  return { content: text.slice(0, 1900), embeds: [], components: [nav, actions] };
}

// ---- Время рассылки -------------------------------------------------

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

// ---- Вопрос администратору / ответ --------------------------------

function askModal() {
  const topic = new TextInputBuilder()
    .setCustomId('topic')
    .setLabel('Тема')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);
  const question = new TextInputBuilder()
    .setCustomId('question')
    .setLabel('Вопрос')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1500);
  return new ModalBuilder()
    .setCustomId('modal:ask')
    .setTitle('Вопрос администратору')
    .addComponents(
      new ActionRowBuilder().addComponents(topic),
      new ActionRowBuilder().addComponents(question),
    );
}

function answerModal(qid, topic) {
  const input = new TextInputBuilder()
    .setCustomId('answer')
    .setLabel('Ответ пользователю')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1800);
  return new ModalBuilder()
    .setCustomId(`modal:answer:${qid}`)
    .setTitle(`Ответ: ${topic}`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(input));
}

/** Сообщение администратору с кнопкой «Ответить». */
function adminQuestionMessage(q, qid) {
  const embed = new EmbedBuilder()
    .setColor(0xd9a441)
    .setTitle(`❓ ${q.topic}`.slice(0, 256))
    .setDescription(q.question.slice(0, 4000))
    .addFields({ name: 'От кого', value: `${q.askerTag} (\`${q.askerId}\`)` })
    .setFooter({ text: `вопрос ${qid}` })
    .setTimestamp(q.at || Date.now());
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ans:${qid}`).setLabel('Ответить').setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row] };
}

/** Сообщение пользователю с ответом администратора. */
function answerMessage(q, answer) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`💬 Ответ на твой вопрос: ${q.topic}`.slice(0, 256))
    .addFields(
      { name: 'Твой вопрос', value: q.question.slice(0, 1024) },
      { name: 'Ответ', value: answer.slice(0, 1024) },
    );
  return { embeds: [embed] };
}

module.exports = {
  buildMenu,
  buildGroupPicker,
  groupModal,
  buildDaysView,
  buildScheduleView,
  timeModal,
  askModal,
  answerModal,
  adminQuestionMessage,
  answerMessage,
  GROUPS_PER_PAGE,
};
