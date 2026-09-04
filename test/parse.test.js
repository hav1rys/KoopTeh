'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ss = require('../scheduleSource');

// 07.09.2026 — понедельник.
const CSV = [
  '07.09.2026 понедельник,,209ИС-1,"109РУ-2, 109СА"',
  ',2.10.00 - 11.20,2.МДК 02.01 Пашкевич ЕЛ 22,2.История Иванов АА 10',
  ',3.11.50 - 13.10,3.Операционные системы Ермаков ИС 20,3.Информатика Кузнецов ДД 15',
  ',4.13.30 - 14.50,,4.Физкультура Петров ББ спортзал',
  ',5.15.00 - 16.20,5.Базы данных Сидорова ВВ 21,5.Базы данных Сидорова ВВ 21',
  '07.09.2026 понедельник,,101ПР,102ПР',
  ',1.08.30 - 09.50,1.Торжественная линейка,',
  ',2.10.00 - 11.20,2.Математика Орлова ЕЕ 33,2.Математика Орлова ЕЕ 33',
].join('\n');

const MON = { y: 2026, mo: 9, d: 7 };

test('обычная группа: пары, внутреннее окно, формат строки', () => {
  const msg = ss.buildScheduleFromCsv(CSV, '209ис-1', MON);
  assert.equal(
    msg,
    [
      'Расписание на 07.09 (понедельник), группа 209ис-1:',
      '10:00–11:20 — МДК 02.01, Пашкевич Е.Л., ауд. 22',
      '11:50–13:10 — Операционные системы, Ермаков И.С., ауд. 20',
      '13:30–14:50 — пар нет',
      '15:00–16:20 — Базы данных, Сидорова В.В., ауд. 21',
    ].join('\n'),
  );
});

test('общекурсовое событие (объединённая ячейка) показывается', () => {
  const msg = ss.buildScheduleFromCsv(CSV, '102ПР', MON);
  assert.equal(
    msg,
    [
      'Расписание на 07.09 (понедельник), группа 102ПР:',
      '08:30–09:50 — 🔔 Торжественная линейка',
      '10:00–11:20 — Математика, Орлова Е.Е., ауд. 33',
    ].join('\n'),
  );
});

test('группы нет в таблице дня', () => {
  const msg = ss.buildScheduleFromCsv(CSV, 'ЗАО-99', MON);
  assert.match(msg, /Группа не найдена в расписании/);
});

test('в этот день у группы вообще нет пар', () => {
  const csv = '08.09.2026 вторник,,АА1,ББ2\n,1.08.30 - 09.50,,\n,2.10.00 - 11.20,,\n';
  const msg = ss.buildScheduleFromCsv(csv, 'АА1', { y: 2026, mo: 9, d: 8 });
  assert.match(msg, /Пар нет$/);
});

test('нормализация имени группы: регистр, пробелы, ё', () => {
  const header = ['07.09.2026 пн', '', ' ГруппаЁ ', 'X1'];
  // Колонка найдена (регистр/пробелы/ё не мешают) -> пустой список, а не null.
  assert.deepEqual(ss.buildEntries([{ header, rows: [] }], 'группае'), []);
  // Незнакомая группа -> null.
  assert.equal(ss.buildEntries([{ header, rows: [] }], 'другая'), null);
});

test('formatLesson: занятие без преподавателя и аудитории', () => {
  assert.equal(ss.formatLesson('1.Классный час'), 'Классный час');
});

test('formatLesson: аудитория-слово не превращается в «ауд.»', () => {
  assert.equal(ss.formatLesson('3.Физкультура Петров ББ спортзал'), 'Физкультура, Петров Б.Б., спортзал');
});

test('извлечение ссылок из HTML-календаря', () => {
  const html =
    '<td><span>6</span> <a href="https://docs.google.com/spreadsheets/d/ABC_123/edit#gid=77">07.09.2026</a></td>' +
    '<td>8</td>' +
    '<td><span>9</span> <a href="https://docs.google.com/spreadsheets/d/XYZ789/edit?usp=sharing&amp;gid=0">расписание</a></td>';
  const links = ss.extractSheetLinks(html);
  assert.equal(
    links.get('07.09.2026'),
    'https://docs.google.com/spreadsheets/d/ABC_123/export?format=csv&gid=77',
  );
  assert.equal(
    ss.findSheetUrl(links, { y: 2026, mo: 9, d: 7 }),
    'https://docs.google.com/spreadsheets/d/ABC_123/export?format=csv&gid=77',
  );
  assert.equal(
    links.get(9),
    'https://docs.google.com/spreadsheets/d/XYZ789/export?format=csv&gid=0',
  );
});
