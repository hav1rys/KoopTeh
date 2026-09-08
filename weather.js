'use strict';

// Погода для утреннего сообщения через open-meteo (без ключа, без лимитов на разумных объёмах).
// По умолчанию — Петрозаводск (координаты в config.js, можно переопределить env WEATHER_LAT/LON/PLACE).
// Всё best-effort: сеть недоела — morningLine() вернёт null или последнее удачное значение.

const cfg = require('./config');

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

const ICE_CODES = new Set([56, 57, 66, 67]);
const PRECIP_CODES = new Set([51, 53, 55, 61, 63, 65, 71, 73, 75, 77, 80, 81, 82, 85, 86]);

let _cache = { at: 0, data: null };

const fmtTemp = (t) => {
  const r = Math.round(t);
  return `${r > 0 ? '+' : ''}${r}°`;
};

async function fetchWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${cfg.weatherLat}&longitude=${cfg.weatherLon}` +
    '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m' +
    `&wind_speed_unit=ms&timezone=${encodeURIComponent(cfg.timezone)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(cfg.httpTimeout, 10 * 1000));
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const c = j && j.current;
    if (!c || typeof c.temperature_2m !== 'number') throw new Error('ответ без current');
    return {
      tempC: c.temperature_2m,
      feelsC: typeof c.apparent_temperature === 'number' ? c.apparent_temperature : c.temperature_2m,
      code: Number(c.weather_code),
      windMs: typeof c.wind_speed_10m === 'number' ? c.wind_speed_10m : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildLine(w) {
  const [icon, desc] = WMO[w.code] || ['🌡', 'погода'];
  const parts = [`${icon} ${cfg.weatherPlace}: ${fmtTemp(w.tempC)}, ${desc}`];
  if (Math.abs(Math.round(w.feelsC) - Math.round(w.tempC)) >= 3) {
    parts.push(`ощущается ${fmtTemp(w.feelsC)}`);
  }
  if (w.windMs != null && w.windMs >= 10) parts.push(`ветер ${Math.round(w.windMs)} м/с`);
  const icy = ICE_CODES.has(w.code) || (PRECIP_CODES.has(w.code) && w.tempC <= 1.5 && w.tempC >= -6);
  if (icy) parts.push('возможен гололёд ⚠️');
  return parts.join(', ');
}

/**
 * Строка погоды для «Доброе утро», напр. «🌨 Петрозаводск: −5°, снег, возможен гололёд ⚠️».
 * @returns {Promise<string|null>}
 */
async function morningLine({ maxAgeMs = 10 * 60 * 1000 } = {}) {
  if (_cache.data && Date.now() - _cache.at < maxAgeMs) return buildLine(_cache.data);
  try {
    const w = await fetchWeather();
    _cache = { at: Date.now(), data: w };
    return buildLine(w);
  } catch {
    return _cache.data ? buildLine(_cache.data) : null; // отдаём устаревшее, если было
  }
}

module.exports = { morningLine };
