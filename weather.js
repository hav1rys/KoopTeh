'use strict';

// Погода через open-meteo (без ключа, без лимитов на разумных объёмах):
//  - geocode(name)     — название населённого пункта -> координаты (Open-Meteo Geocoding API)
//  - dayForecast(lat, lon) — почасовой прогноз на остаток сегодняшнего дня, схлопнутый
//                            в диапазоны («11:00–13:00 — 🌦 +5»), плюс советы «возьми зонт» /
//                            «надень куртку».
// По умолчанию город — Петрозаводск (координаты в config.js, можно переопределить
// env WEATHER_LAT/LON/PLACE). Второе (домашнее) место — своё у каждого пользователя,
// задаётся в ⚙️ Настройки → 🏘 Не из города (geocode() вызывается один раз при вводе).

const cfg = require('./config');
const D = require('./dates');

// Коды погоды WMO -> [эмодзи, текст]
const WMO = {
  0: ['☀️', 'ясно'],
  1: ['🌤', 'малооблачно'],
  2: ['⛅', 'переменная облачность'],
  3: ['☁️', 'пасмурно'],
  45: ['🌫', 'туман'],
  48: ['🌫', 'изморозь'],
  51: ['🌦', 'слабая морось'],
  53: ['🌦', 'морось'],
  55: ['🌦', 'сильная морось'],
  56: ['🌧', 'ледяная морось'],
  57: ['🌧', 'ледяная морось'],
  61: ['🌧', 'слабый дождь'],
  63: ['🌧', 'дождь'],
  65: ['🌧', 'сильный дождь'],
  66: ['🌧', 'ледяной дождь'],
  67: ['🌧', 'ледяной дождь'],
  71: ['🌨', 'слабый снег'],
  73: ['🌨', 'снег'],
  75: ['🌨', 'сильный снег'],
  77: ['🌨', 'снежная крупа'],
  80: ['🌦', 'ливень'],
  81: ['🌦', 'ливень'],
  82: ['🌦', 'сильный ливень'],
  85: ['🌨', 'снегопад'],
  86: ['🌨', 'сильный снегопад'],
  95: ['⛈', 'гроза'],
  96: ['⛈', 'гроза с градом'],
  99: ['⛈', 'гроза с градом'],
};

const RAIN_CODES = new Set([51, 53, 55, 61, 63, 65, 80, 81, 82]);
const SNOW_CODES = new Set([56, 57, 66, 67, 71, 73, 75, 77, 85, 86]);
const STORM_CODES = new Set([95, 96, 99]);

const iconFor = (code) => (WMO[code] || ['🌡', 'погода'])[0];

// ---------------------------------------------------------------------------
// Геокодинг: название места -> координаты (Open-Meteo Geocoding API, бесплатно)
// ---------------------------------------------------------------------------

/** @returns {Promise<{lat:number, lon:number, name:string}|null>} */
async function geocode(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=ru&format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(cfg.httpTimeout, 10 * 1000));
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const list = Array.isArray(j.results) ? j.results : [];
    if (!list.length) return null;
    const best = list.find((r) => r.country_code === 'RU') || list[0];
    return { lat: best.latitude, lon: best.longitude, name: best.name };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Почасовой прогноз на сегодня
// ---------------------------------------------------------------------------

async function fetchHourly(lat, lon, days) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&hourly=temperature_2m,apparent_temperature,weather_code' +
    `&forecast_days=${days}&timezone=${encodeURIComponent(cfg.timezone)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(cfg.httpTimeout, 10 * 1000));
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const h = j && j.hourly;
    if (!h || !Array.isArray(h.time) || !Array.isArray(h.temperature_2m)) throw new Error('ответ без hourly');
    return h.time.map((t, i) => ({
      date: String(t).slice(0, 10),
      hhmm: String(t).slice(11, 16),
      temp: h.temperature_2m[i],
      feels: Array.isArray(h.apparent_temperature) ? h.apparent_temperature[i] : h.temperature_2m[i],
      code: Number((h.weather_code || [])[i]),
    }));
  } finally {
    clearTimeout(timer);
  }
}

/** Схлопывает подряд идущие часы с одинаковой (округлённой) температурой и иконкой в один диапазон. */
function mergeRanges(hours) {
  const merged = [];
  for (const h of hours) {
    const temp = Math.round(h.temp);
    const icon = iconFor(h.code);
    const last = merged[merged.length - 1];
    if (last && last.temp === temp && last.icon === icon) last.to = h.hhmm;
    else merged.push({ from: h.hhmm, to: h.hhmm, temp, icon });
  }
  return merged.map((r) => ({
    label: r.from === r.to ? r.from : `${r.from}–${r.to}`,
    icon: r.icon,
    temp: r.temp,
  }));
}

/** «Возьми зонт» / «надень куртку» и т.п. — по минимальной ощущаемой и осадкам за день. */
function adviceLines(hours) {
  if (!hours.length) return [];
  const lines = [];
  const feelsVals = hours.map((h) => h.feels).filter((v) => Number.isFinite(v));
  const minFeels = feelsVals.length ? Math.min(...feelsVals) : hours[0].temp;
  const codes = hours.map((h) => h.code);

  if (codes.some((c) => STORM_CODES.has(c))) lines.push('⛈ Возьми зонт, ожидается гроза');
  else if (codes.some((c) => RAIN_CODES.has(c))) lines.push('☔ Возьми зонт');
  else if (codes.some((c) => SNOW_CODES.has(c))) lines.push('❄️ Возьми зонт или капюшон, идёт снег');

  if (minFeels >= 18) lines.push('🩳 Можно налегке');
  else if (minFeels >= 10) lines.push('🧥 Лёгкая куртка');
  else if (minFeels >= 1) lines.push('🧥 Куртка потеплее');
  else if (minFeels >= -9) lines.push('🧥 Тёплая куртка, шапка');
  else lines.push('🥶 Надевай зимнюю куртку, тепло одевайся');

  return lines;
}

const FORECAST_DAYS = 7; // горизонт для листания дат в /start → 🌤 Погода

const _hourlyCache = new Map(); // "lat,lon" -> { at, hours }

async function fetchHourlyCached(lat, lon, maxAgeMs) {
  const key = `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
  const hit = _hourlyCache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.hours;
  const hours = await fetchHourly(lat, lon, FORECAST_DAYS);
  _hourlyCache.set(key, { at: Date.now(), hours });
  return hours;
}

/**
 * Прогноз на день targetIso (по умолчанию — остаток сегодняшнего дня):
 * { ranges: [{label, icon, temp}], advice: [строки] }.
 * @returns {Promise<{ranges: Array, advice: string[]}>}
 */
async function dayForecast(lat, lon, targetIso, { maxAgeMs = 10 * 60 * 1000 } = {}) {
  const all = await fetchHourlyCached(lat, lon, maxAgeMs);
  const todayIso = D.iso(D.todayParts());
  const iso = targetIso || todayIso;

  let hours = all.filter((h) => h.date === iso);
  if (iso === todayIso) {
    const now = D.tzNow();
    const nowHHMM = `${D.pad(now.h)}:00`;
    const rest = hours.filter((h) => h.hhmm >= nowHHMM);
    if (rest.length) hours = rest;
  }
  if (!hours.length) hours = all; // день вне горизонта прогноза — лучше приблизительно, чем ничего

  return { ranges: mergeRanges(hours), advice: adviceLines(hours) };
}

module.exports = { geocode, dayForecast, FORECAST_DAYS };
