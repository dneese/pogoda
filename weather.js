const fetch = require('node-fetch');
const { getForecastEntry, setCachedForecast } = require('./db');

const RAIN_CODES = [51, 53, 55, 61, 63, 65, 80, 81, 82];
const THUNDER_CODES = [95, 97];
const HAIL_CODES = [96, 99];

const CACHE_TTL_MINUTES = parseInt(process.env.FORECAST_CACHE_TTL_MIN || '60', 10);
// Біля події прогноз освіжаємо значно частіше, ніж для далекого аутлуку:
// час старту дощу має бути якомога точнішим у момент попередження.
const IMMINENT_TTL_MINUTES = parseInt(process.env.IMMINENT_TTL_MIN || '10', 10);
const FORECAST_DAYS = parseInt(process.env.FORECAST_DAYS || '3', 10);

const RAIN_THRESHOLD_MM = parseFloat(process.env.RAIN_THRESHOLD_MM || '0.3');
// «Значний дощ»: ігноруємо дрібний/короткий. Подія репортується, якщо в
// якусь годину інтенсивність >= MIN_RAIN_MM_H І тривалість >=
// MIN_RAIN_DURATION_HOURS (або був сильний дощ >= HEAVY_RAIN_MM_H — тоді
// навіть коротка злива важлива, парасолька потрібна).
const MIN_RAIN_MM_H = parseFloat(process.env.MIN_RAIN_MM_H || '0.5');
const MIN_RAIN_DURATION_HOURS = parseFloat(process.env.MIN_RAIN_DURATION_HOURS || '2');
const HEAVY_RAIN_MM_H = parseFloat(process.env.HEAVY_RAIN_MM_H || '3');
const URGENT_WIND_MS = parseFloat(process.env.URGENT_WIND_MS || '25');

const SOON_WINDOW_HOURS = parseFloat(process.env.SOON_WINDOW_HOURS || '3');
const OUTLOOK_MAX_HOURS = parseFloat(process.env.OUTLOOK_MAX_HOURS || '72');

function clusterKeyOf(lat, lon, gridDeg = parseFloat(process.env.CLUSTER_GRID_DEG || '0.11')) {
  const gLat = Math.floor(lat / gridDeg) * gridDeg;
  const gLon = Math.floor(lon / gridDeg) * gridDeg;
  return `${gLat.toFixed(2)}_${gLon.toFixed(2)}`;
}

// Open-Meteo повертає місцевий час без зсуву + utc_offset_seconds.
// Парсимо як "наївний UTC" і віднімаємо зсув — отримуємо справжній
// абсолютний момент незалежно від часового поясу машини, де працює бот.
function timeParser(forecastJson) {
  const offsetSec = (forecastJson && forecastJson.utc_offset_seconds) || 0;
  return (timeStr) => new Date(Date.parse(timeStr + 'Z') - offsetSec * 1000);
}

async function getForecast(lat, lon) {
  const key = clusterKeyOf(lat, lon);

  const entry = await getForecastEntry(key, CACHE_TTL_MINUTES);
  if (entry) {
    const ageMin = (Date.now() - new Date(entry.fetched_at).getTime()) / 60000;
    // Якщо найближчим часом активність І кеш старший за IMMINENT_TTL —
    // перечитуємо, щоб час старту був точним. Далекий аутлук кешується спокійно.
    const needFresh = hasNearActivity(entry.payload, SOON_WINDOW_HOURS + 1) &&
      ageMin >= IMMINENT_TTL_MINUTES;
    if (!needFresh) return entry.payload;
  }

  const data = await fetchForecast(lat, lon);
  if (data) await setCachedForecast(key, lat, lon, data);
  return data;
}

async function fetchForecast(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}` +
    `&longitude=${lon.toFixed(4)}` +
    `&hourly=weather_code,wind_gusts_10m,precipitation,precipitation_probability` +
    `&minutely_15=precipitation&forecast_minutely_15=96&forecast_days=${FORECAST_DAYS}` +
    `&timezone=${encodeURIComponent(process.env.TIMEZONE || 'Europe/Kyiv')}`;

  try {
    const res = await fetch(url, { timeout: 20000 });
    if (!res.ok) {
      console.error(`Open-Meteo HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('Open-Meteo fetch error:', err.message);
    return null;
  }
}

// Швидка перевірка: чи є в найближчі N годин хоч якась активність
// (для рішення про «освіження» прогнозу біля події).
function hasNearActivity(forecastJson, hours) {
  if (!forecastJson || !forecastJson.hourly) return false;
  const { time, weather_code, precipitation } = forecastJson.hourly;
  const parse = timeParser(forecastJson);
  const nowMs = Date.now();
  for (let i = 0; i < time.length; i++) {
    const hoursAhead = (parse(time[i]).getTime() - nowMs) / 3600000;
    if (hoursAhead < 0 || hoursAhead > hours) continue;
    const code = weather_code ? weather_code[i] : 0;
    const mm = precipitation ? precipitation[i] : 0;
    if (RAIN_CODES.includes(code) || THUNDER_CODES.includes(code) ||
      HAIL_CODES.includes(code) || mm >= RAIN_THRESHOLD_MM) return true;
  }
  return false;
}

function classifyHour(code, windMs, mm) {
  if (windMs >= URGENT_WIND_MS) return { kind: 'urgent', description: `Ураган (пориви ${Math.round(windMs)} м/с)` };
  if (HAIL_CODES.includes(code)) return { kind: 'urgent', description: 'Гроза з градом' };
  if (THUNDER_CODES.includes(code)) return { kind: 'thunder', description: 'Гроза з блискавками' };
  if (RAIN_CODES.includes(code) || mm >= RAIN_THRESHOLD_MM) return { kind: 'rain', description: 'Дощ' };
  return null;
}

// Знаходить усі події (дощ/гроза/ураган), що перетинаються з вікном
// [fromHours, toHours] відносно зараз. Застосовує фільтри «значного дощу»
// до kind='rain'; грози й урагани — завжди. Повертає масив
// { kind, startTime, endTime, maxMm, description } (startTime — початок
// годинного слота; точніший onset рахується окремо через refineRainOnset).
function findEvents(forecastJson, fromHours, toHours) {
  if (!forecastJson || !forecastJson.hourly) return [];
  const { time, weather_code, wind_gusts_10m, precipitation } = forecastJson.hourly;
  const parse = timeParser(forecastJson);
  const nowMs = Date.now();

  const runs = [];
  let run = null;

  function flushRun() {
    if (!run) return;
    const { startIdx, endIdx, maxMm, hasUrgent, hasThunder, descriptions } = run;
    const kind = hasUrgent ? 'urgent' : (hasThunder ? 'thunder' : 'rain');
    const startTime = parse(time[startIdx]);
    const endTime = new Date(parse(time[endIdx]).getTime() + 3600000);

    let significant = true;
    if (kind === 'rain') {
      const heavy = maxMm >= HEAVY_RAIN_MM_H;
      const enoughIntensity = maxMm >= MIN_RAIN_MM_H;
      const enoughDuration = (endIdx - startIdx + 1) >= MIN_RAIN_DURATION_HOURS;
      significant = enoughIntensity && (enoughDuration || heavy);
    }

    if (significant) {
      runs.push({
        kind,
        startTime,
        endTime,
        maxMm,
        description: kind === 'rain'
          ? `Дощ (до ${maxMm.toFixed(1)} мм/год)`
          : descriptions[0]
      });
    }
    run = null;
  }

  for (let i = 0; i < time.length; i++) {
    const code = weather_code ? weather_code[i] : 0;
    const gust = wind_gusts_10m ? wind_gusts_10m[i] : 0;
    const mm = precipitation ? precipitation[i] : 0;
    const cls = classifyHour(code, gust / 3.6, mm);

    if (cls) {
      if (!run) {
        run = {
          startIdx: i, endIdx: i, maxMm: mm,
          hasUrgent: cls.kind === 'urgent', hasThunder: cls.kind === 'thunder',
          descriptions: [cls.description]
        };
      } else {
        run.endIdx = i;
        if (mm > run.maxMm) run.maxMm = mm;
        if (cls.kind === 'urgent') run.hasUrgent = true;
        if (cls.kind === 'thunder') run.hasThunder = true;
        if (!run.descriptions.includes(cls.description)) run.descriptions.push(cls.description);
      }
    } else {
      flushRun();
    }
  }
  flushRun();

  const fromMs = nowMs + fromHours * 3600000;
  const toMs = nowMs + toHours * 3600000;
  return runs.filter((ev) =>
    ev.endTime.getTime() > fromMs && ev.startTime.getTime() < toMs
  );
}

// Точний початок дощу по minutely_15 (крок 15 хв): перший слот у межах
// події з інтенсивністю >= MIN_RAIN_MM_H. Для грози/урагану — годинний
// слот. Поза горизонтом 24 год (minutely_15) залишається годинний початок.
function refineRainOnset(event, forecastJson) {
  if (event.kind !== 'rain') return event.startTime;
  const minutely = forecastJson && forecastJson.minutely_15;
  if (!minutely || !minutely.time || !minutely.precipitation) return event.startTime;
  const parse = timeParser(forecastJson);
  const startMs = event.startTime.getTime();
  const endMs = event.endTime.getTime();
  for (let i = 0; i < minutely.time.length; i++) {
    const t = parse(minutely.time[i]).getTime();
    if (t < startMs) continue;
    if (t >= endMs) break;
    if (minutely.precipitation[i] >= MIN_RAIN_MM_H) return parse(minutely.time[i]);
  }
  return event.startTime;
}

// Головна аналітика для картки: розбиває події на «іміджент» (старт в
// межах SOON_WINDOW_HOURS) та «аутлук» (старт у межах OUTLOOK_MAX_HOURS).
// Для дощу підставляє точний onset з minutely_15.
// Повертає { imminent, outlook, now } — масиви подій { kind, startTime,
// onset, endTime, maxMm, description }, відсортовані за часом старту.
function analyzeForecast(forecastJson, opts = {}) {
  const soonHours = opts.soonWindowHours != null ? opts.soonWindowHours : SOON_WINDOW_HOURS;
  const maxHours = opts.maxHours != null ? opts.maxHours : OUTLOOK_MAX_HOURS;
  const nowMs = Date.now();
  const now = new Date(nowMs);

  const events = findEvents(forecastJson, -1, maxHours).map((ev) => ({
    ...ev,
    onset: refineRainOnset(ev, forecastJson)
  }));

  const imminent = [];
  const outlook = [];
  for (const ev of events) {
    if (ev.endTime.getTime() <= nowMs) continue;
    if (ev.onset.getTime() <= nowMs + soonHours * 3600000) imminent.push(ev);
    else outlook.push(ev);
  }

  imminent.sort((a, b) => a.onset - b.onset);
  outlook.sort((a, b) => a.onset - b.onset);
  return { imminent, outlook, now };
}

// Зворотна сумісність: найближча іміджент-подія або null.
function analyzeUpcoming(forecastJson, soonWindowHours) {
  const a = analyzeForecast(forecastJson, { soonWindowHours });
  const ev = a.imminent[0];
  if (!ev) return null;
  return {
    hasEvent: true,
    startTime: ev.onset,
    endTime: ev.endTime,
    kind: ev.kind,
    description: ev.description
  };
}

module.exports = {
  getForecast,
  analyzeForecast,
  analyzeUpcoming,
  findEvents,
  clusterKeyOf,
  RAIN_THRESHOLD_MM,
  MIN_RAIN_MM_H,
  MIN_RAIN_DURATION_HOURS,
  HEAVY_RAIN_MM_H,
  SOON_WINDOW_HOURS,
  OUTLOOK_MAX_HOURS
};
