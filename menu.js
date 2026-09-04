'use strict';

// Меню /start: эмбед со статусом + кнопки. Вся настройка — здесь.

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const cfg = require('./config');

const pad = (n) => String(n).padStart(2, '0');
const BROADCAST_AT = `${pad(cfg.broadcast.hh)}:${pad(cfg.broadcast.mm)}`;

/** @param {{ group: string|null, subscribed: boolean }} state */
function buildMenu(state) {
  const { group, subscribed } = state;

  const embed = new EmbedBuilder()
    .setColor(0x2b6cb0)
    .setTitle('🎓 Расписание — Кооперативный техникум')
    .setDescription(
      `Присылаю расписание пар в личные сообщения каждый день в **${BROADCAST_AT}** ` +
        `(${cfg.timezone}). Настройка — кнопками ниже.`,
    )
    .addFields(
      { name: 'Твоя группа', value: group ? `**${group}**` : '_не указана_', inline: true },
      {
        name: 'Ежедневная рассылка',
        value: !group ? '_сначала укажи группу_' : subscribed ? '✅ включена' : '⛔ выключена',
        inline: true,
      },
    )
    .setFooter({ text: 'Петрозаводск • koopteh10.ru' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('menu:setgroup')
      .setLabel(group ? 'Сменить группу' : 'Указать группу')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('menu:tomorrow')
      .setLabel('Расписание на завтра')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!group),
    new ButtonBuilder()
      .setCustomId('menu:date')
      .setLabel('На другую дату')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!group),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('menu:togglesub')
      .setLabel(subscribed ? 'Отключить рассылку' : 'Включить рассылку')
      .setStyle(subscribed ? ButtonStyle.Danger : ButtonStyle.Success)
      .setDisabled(!group),
    new ButtonBuilder()
      .setCustomId('menu:refresh')
      .setLabel('Обновить')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

function groupModal(current) {
  const input = new TextInputBuilder()
    .setCustomId('group')
    .setLabel('Группа, например 209ИС-1')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(40);
  if (current) input.setValue(current);

  return new ModalBuilder()
    .setCustomId('modal:setgroup')
    .setTitle('Учебная группа')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function dateModal() {
  const input = new TextInputBuilder()
    .setCustomId('date')
    .setLabel('Дата: дд.мм или дд.мм.гггг')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(10)
    .setPlaceholder('15.09');

  return new ModalBuilder()
    .setCustomId('modal:date')
    .setTitle('Расписание на дату')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

module.exports = { buildMenu, groupModal, dateModal };
