const log = require('./logger');
const stats = require('./stats');

const RADAR_API = 'https://api.rainviewer.com';
const RADAR_TIMEOUT_MS = parseInt(process.env.RADAR_TIMEOUT_MS || '8000', 10);
const RADAR_CACHE_TTL_MS = parseInt(process.env.RADAR_CACHE_TTL_MS || '120000', 10);

const radarCache = new Map();

function cacheKey(lat, lon) {
  return `${lat.toFixed(3)}_${lon.toFixed(3)}`;
}

// Перевірка наявності радарних даних RainViewer для локації
async function checkRadarAvailability(lat, lon) {
  try {
    const res = await fetch(`${RADAR_API}/public/weather-maps.json`, {
      signal: AbortSignal.timeout(RADAR_TIMEOUT_MS)
    });
    if (!res.ok) return { available: false, timestamp: null };
    const data = await res.json();
    if (!data || !data.radar || !data.radar.past || data.radar.past.length === 0) {
      return { available: false, timestamp: null };
    }
    const latest = data.radar.past[data.radar.past.length - 1];
    return { available: true, timestamp: latest.time };
  } catch (err) {
    log.debug('RainViewer availability check failed:', err.message);
    return { available: false, timestamp: null };
  }
}

// Витягує короткострокові опади з minutely_15 Open-Meteo як «радарний» сигнал.
// minutely_15 = 15-хвилинні інтервали на 24 години вперед — найточніше
// джерело для короткострокових опадів (аналог радарного трекингу).
function extractMinutelyRadar(forecastJson) {
  if (!forecastJson || !forecastJson.minutely_15) {
    return { hasData: false, slots: [], maxMmH: 0, totalMm: 0 };
  }
  const m = forecastJson.minutely_15;
  if (!m.time || !m.precipitation) {
    return { hasData: false, slots: [], maxMmH: 0, totalMm: 0 };
  }

  const offsetSec = (forecastJson.utc_offset_seconds) || 0;
  const parse = (s) => new Date(Date.parse(s + 'Z') - offsetSec * 1000);
  const nowMs = Date.now();

  // Збираємо слоти на наступні 2 години
  const horizonMs = nowMs + 2 * 3600000;
  const slots = [];
  let maxMmH = 0;

  for (let i = 0; i < m.time.length; i++) {
    const t = parse(m.time[i]).getTime();
    if (t < nowMs || t > horizonMs) continue;
    const mmH = m.precipitation[i] || 0;
    slots.push({ timeMs: t, mmH });
    if (mmH > maxMmH) maxMmH = mmH;
  }

  const totalMm = slots.reduce((s, sl) => s + sl.mmH * 0.25, 0);

  return {
    hasData: slots.length > 0,
    slots,
    maxMmH,
    totalMm,
    // Кількість слотів з опадами > 0.1 мм/год
    activeSlots: slots.filter((s) => s.mmH > 0.1).length,
    // Загальна тривалість опадів (хв)
    durationMinutes: slots.filter((s) => s.mmH > 0.1).length * 15
  };
}

// Отримати «радарний» аналіз: поєднує RainViewer + minutely_15
async function getRadarAnalysis(lat, lon, forecastJson) {
  const key = cacheKey(lat, lon);
  const cached = radarCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < RADAR_CACHE_TTL_MS) {
    stats.inc('radar_cache_hits');
    return cached.data;
  }

  const [availability, minutely] = await Promise.all([
    checkRadarAvailability(lat, lon).catch(() => ({ available: false, timestamp: null })),
    Promise.resolve(extractMinutelyRadar(forecastJson))
  ]);

  const result = {
    rainviewerAvailable: availability.available,
    rainviewerTimestamp: availability.timestamp,
    ...minutely,
    // Консенсус: радар підтверджує дощ якщо є активні слоти
    confirmed: minutely.activeSlots > 0,
    // Інтенсивність з урахуванням тривалості
    riskScore: calculateRiskScore(minutely)
  };

  radarCache.set(key, { data: result, fetchedAt: Date.now() });
  stats.inc('radar_fetches');
  return result;
}

// Рахує «рівень ризику» 0..1 на основі радарних даних
function calculateRiskScore(minutely) {
  if (!minutely.hasData) return 0;
  const { maxMmH, activeSlots, totalMm } = minutely;
  // Сила: max intensity normalized
  const intensityScore = Math.min(1, maxMmH / 10);
  // Тривалість: кількість активних слотів / 8 (2 години = 8 слотів)
  const durationScore = Math.min(1, activeSlots / 8);
  // Сума опадів
  const totalScore = Math.min(1, totalMm / 5);
  return Math.min(1, intensityScore * 0.5 + durationScore * 0.3 + totalScore * 0.2);
}

module.exports = {
  getRadarAnalysis,
  extractMinutelyRadar,
  checkRadarAvailability
};
