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

test('обычная группа: пары с номером, внутреннее окно, формат строки', () => {
  const msg = ss.buildScheduleFromCsv(CSV, '209ис-1', MON);
  assert.equal(
    msg,
    [
      'Расписание на 07.09 (понедельник), группа 209ис-1:',
      '2 · 10:00–11:20 — МДК 02.01, Пашкевич Е.Л., ауд. 22',
      '3 · 11:50–13:10 — Операционные системы, Ермаков И.С., ауд. 20',
      '4 · 13:30–14:50 — пар нет',
      '5 · 15:00–16:20 — Базы данных, Сидорова В.В., ауд. 21',
    ].join('\n'),
  );
});

test('showGaps: false убирает строки «пар нет»', () => {
  const msg = ss.buildScheduleFromCsv(CSV, '209ис-1', MON, { showGaps: false });
  assert.equal(
    msg,
    [
      'Расписание на 07.09 (понедельник), группа 209ис-1:',
      '2 · 10:00–11:20 — МДК 02.01, Пашкевич Е.Л., ауд. 22',
      '3 · 11:50–13:10 — Операционные системы, Ермаков И.С., ауд. 20',
      '5 · 15:00–16:20 — Базы данных, Сидорова В.В., ауд. 21',
    ].join('\n'),
  );
});

test('общекурсовое событие (объединённая ячейка) показывается', () => {
  const msg = ss.buildScheduleFromCsv(CSV, '102ПР', MON);
  assert.equal(
    msg,
    [
      'Расписание на 07.09 (понедельник), группа 102ПР:',
      '1 · 08:30–09:50 — 🔔 Торжественная линейка',
      '2 · 10:00–11:20 — Математика, Орлова Е.Е., ауд. 33',
    ].join('\n'),
  );
});

test('pairNoFromCell: номер пары из столбца B и из ячейки', () => {
  assert.equal(ss.pairNoFromCell('2.10.00 - 11.20'), 2);
  assert.equal(ss.pairNoFromCell('5.МДК 02.01 Пашкевич ЕЛ 22'), 5);
  assert.equal(ss.pairNoFromCell(''), null);
});

test('поиск по кабинету', () => {
  const data = ss.searchSchedule(CSV, { room: '22', teacher: '' }, MON);
  assert.equal(data.mode, 'search');
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].subject, 'МДК 02.01');
  assert.equal(data.rows[0].teacher, 'Пашкевич Е.Л.');
});

test('режим преподавателя: собирает пары по фамилии из всех колонок', () => {
  const data = ss.buildTeacherData(CSV, 'Орлова', MON);
  assert.equal(data.mode, 'teacher');
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].subject, 'Математика');
  assert.match(data.rows[0].groupsText, /101ПР|102ПР/);
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
    '<td><span>9</span> <a href="https://docs.google.com/spreadsheets/d/XYZ789/edit?usp=sharing&amp;gid=0">расписание</a></td>' +
    '<td>10 <a href="https://docs.google.com/spreadsheets/d/NOGID123/edit?usp=sharing">10</a></td>';
  const links = ss.extractSheetLinks(html);
  assert.equal(
    links.get('07.09.2026'),
    'https://docs.google.com/spreadsheets/d/ABC_123/export?format=csv&gid=77',
  );
  assert.equal(
    ss.findSheetUrl(links, { y: 2026, mo: 9, d: 7 }),
    'https://docs.google.com/spreadsheets/d/ABC_123/export?format=csv&gid=77',
  );
  assert.equal(links.get(9), 'https://docs.google.com/spreadsheets/d/XYZ789/export?format=csv&gid=0');
  // ссылка без gid -> экспорт без gid (первый лист), а не gid=0
  assert.equal(links.get(10), 'https://docs.google.com/spreadsheets/d/NOGID123/export?format=csv');
});

test('календарь с двумя месяцами: число дня не путается между месяцами', () => {
  const a = (id, n) => `<td><a href="https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing">${n}</a></td>`;
  const html =
    '<h3><a href="https://docs.google.com/spreadsheets/d/RETAKE1/edit">График пересдачи задолженности летней сессии 2025-2026 уч.года</a></h3>' +
    '<p><strong><span>Октябрь, 2026</span></strong></p><table><tr>' + a('OCT01', '01') + a('OCT02', '02') + a('OCT05', '05') + '</tr></table>' +
    '<p><strong>Ноябрь, 2026</strong></p><table><tr>' + a('NOV02', '02') + a('NOV03', '03') + '</tr></table>';
  const links = ss.extractSheetLinks(html);
  const url = (id) => `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
  assert.equal(ss.findSheetUrl(links, { y: 2026, mo: 10, d: 2 }), url('OCT02'));
  assert.equal(ss.findSheetUrl(links, { y: 2026, mo: 11, d: 2 }), url('NOV02'));
  assert.equal(ss.findSheetUrl(links, { y: 2026, mo: 11, d: 3 }), url('NOV03'));
  // 01.11 и 05.11 не опубликованы: нельзя подсовывать таблицы 01.10 / 05.10
  assert.equal(ss.findSheetUrl(links, { y: 2026, mo: 11, d: 1 }), null);
  assert.equal(ss.findSheetUrl(links, { y: 2026, mo: 11, d: 5 }), null);
  // длинная ссылка («График пересдачи…») не считается днём календаря
  assert.ok(![...links.values()].some((u) => u.includes('RETAKE1')));
});

test('защита от чужого дня: дата внутри таблицы должна совпасть с запрошенной', async () => {
  const csv = ',,,\n03.11.2026 вторник,"109Б",109РУ-1,\n,1.Литература,,\n';
  assert.deepEqual(ss.sheetBlockDates(csv), ['2026-11-03']);
  await ss.assertSheetIsForDate('x', csv, { y: 2026, mo: 11, d: 3 });
  await assert.rejects(
    () => ss.assertSheetIsForDate('x', csv, { y: 2026, mo: 11, d: 1 }),
    (e) => e instanceof ss.NotPublishedError,
  );
});

test('humanSheetUrl: из любой ссылки -> человекочитаемый /edit', () => {
  assert.equal(
    ss.humanSheetUrl('https://docs.google.com/spreadsheets/d/ABC_123/export?format=csv&gid=77'),
    'https://docs.google.com/spreadsheets/d/ABC_123/edit',
  );
  assert.equal(ss.humanSheetUrl(''), null);
});
