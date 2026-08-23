const { getForecastEntry, setCachedForecast } = require('./db');
const log = require('./logger');
const stats = require('./stats');

// L1-кеш у пам'яті процесу перед DB-кешем: економить round-trip до Supabase
// у межах одного інстансу. TTL збігається з FORECAST_CACHE_TTL_MIN.
const FETCH_TIMEOUT_MS = parseInt(process.env.OPEN_METEO_TIMEOUT_MS || '15000', 10);
const FETCH_RETRIES = parseInt(process.env.OPEN_METEO_RETRIES || '2', 10);
const memCache = new Map(); // clusterKey -> { payload, fetchedAt }

// --- Пороги рівнів небезпеки ------------------------------------------
// Модель як в офіційних попередженнях (MeteoAlarm/CAP): кожне явище
// отримує severity 1..3 → 🟡 жовтий / 🟠 оранжевий / 🔴 червоний.
const WIND_Y_MS = parseFloat(process.env.WIND_YELLOW_MS || '17');
const WIND_O_MS = parseFloat(process.env.WIND_ORANGE_MS || '21');
const WIND_R_MS = parseFloat(process.env.WIND_RED_MS || '25');
const RAIN_O_MM_H = parseFloat(process.env.RAIN_ORANGE_MM_H || '7');
const RAIN_R_MM_H = parseFloat(process.env.RED_RAIN_MM_H || '15');
const SNOW_Y_CM_H = parseFloat(process.env.SNOW_YELLOW_CM_H || '1');
const SNOW_O_CM_H = parseFloat(process.env.SNOW_ORANGE_CM_H || '3');
const SNOW_R_CM_H = parseFloat(process.env.SNOW_RED_CM_H || '6');
const HEAT_Y_C = parseFloat(process.env.HEAT_YELLOW_C || '30');
const HEAT_O_C = parseFloat(process.env.HEAT_ORANGE_C || '35');
const HEAT_R_C = parseFloat(process.env.HEAT_RED_C || '39');
const COLD_Y_C = parseFloat(process.env.COLD_YELLOW_C || '-12');
const COLD_O_C = parseFloat(process.env.COLD_ORANGE_C || '-20');
const COLD_R_C = parseFloat(process.env.COLD_RED_C || '-26');
const UV_Y = parseFloat(process.env.UV_YELLOW || '6');
const UV_O = parseFloat(process.env.UV_ORANGE || '8');
const UV_R = parseFloat(process.env.UV_RED || '11');

// Класичні пороги дощу (значність події, не колір)
const RAIN_THRESHOLD_MM = parseFloat(process.env.RAIN_THRESHOLD_MM || '0.3');
const MIN_RAIN_MM_H = parseFloat(process.env.MIN_RAIN_MM_H || '0.5');
const MIN_RAIN_DURATION_HOURS = parseFloat(process.env.MIN_RAIN_DURATION_HOURS || '2');
const HEAVY_RAIN_MM_H = parseFloat(process.env.HEAVY_RAIN_MM_H || '3');
// «Помірні» явища (спека/мороз/туман/UV) рахуємо значними лише якщо
// тривають щонайменше N годин — інакше бот шумітиме щодня.
const MILD_MIN_DURATION_HOURS = parseFloat(process.env.MILD_MIN_DURATION_HOURS || '2');

const SOON_WINDOW_HOURS = parseFloat(process.env.SOON_WINDOW_HOURS || '3');
const OUTLOOK_MAX_HOURS = parseFloat(process.env.OUTLOOK_MAX_HOURS || '72');

const CACHE_TTL_MINUTES = parseInt(process.env.FORECAST_CACHE_TTL_MIN || '60', 10);
// Біля події прогноз освіжаємо значно частіше, ніж для далекого аутлуку:
// час старту дощу має бути якомога точнішим у момент попередження.
const IMMINENT_TTL_MINUTES = parseInt(process.env.IMMINENT_TTL_MIN || '10', 10);
const FORECAST_DAYS = parseInt(process.env.FORECAST_DAYS || '3', 10);

// --- Явища: пріоритет і категорії налаштувань -------------------------
// kind події = найвищий за пріоритетом вид активності в межах рану.
// category використовується у налаштуваннях користувача (/settings).
const KIND_PRIORITY = ['hail', 'thunder', 'ice', 'wind', 'snow', 'rain', 'heat', 'cold', 'fog', 'uv'];
const CATEGORY_OF = {
  rain: 'precip', snow: 'precip', ice: 'precip',
  thunder: 'storm', hail: 'storm',
  wind: 'wind',
  heat: 'temp', cold: 'temp',
  fog: 'other', uv: 'other'
};

function severityByThresholds(v, y, o, r) {
  if (v >= r) return 3;
  if (v >= o) return 2;
  if (v >= y) return 1;
  return 0;
}

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

  // L1: пам'ять процесу
  const mem = memCache.get(key);
  if (mem) {
    const ageMin = (Date.now() - mem.fetchedAt) / 60000;
    const needFresh = hasNearActivity(mem.payload, SOON_WINDOW_HOURS + 1) &&
      ageMin >= IMMINENT_TTL_MINUTES;
    if (ageMin < CACHE_TTL_MINUTES && !needFresh) {
      stats.inc('forecast_cache_hits_mem');
      return mem.payload;
    }
  }

  // L2: БД (переживає рестарт, спільний між інстансами)
  const entry = await getForecastEntry(key, CACHE_TTL_MINUTES);
  if (entry) {
    stats.inc('forecast_cache_hits_db');
    const ageMin = (Date.now() - new Date(entry.fetched_at).getTime()) / 60000;
    // Якщо найближчим часом активність І кеш старший за IMMINENT_TTL —
    // перечитуємо, щоб час старту був точним. Далекий аутлук кешується спокійно.
    const needFresh = hasNearActivity(entry.payload, SOON_WINDOW_HOURS + 1) &&
      ageMin >= IMMINENT_TTL_MINUTES;
    if (!needFresh) {
      memCache.set(key, { payload: entry.payload, fetchedAt: new Date(entry.fetched_at).getTime() });
      return entry.payload;
    }
  }

  const data = await fetchForecast(lat, lon);
  if (data) {
    stats.inc('forecast_fetches');
    await setCachedForecast(key, lat, lon, data);
    memCache.set(key, { payload: data, fetchedAt: Date.now() });
  }
  return data;
}

async function fetchOnce(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}` +
    `&longitude=${lon.toFixed(4)}` +
    `&hourly=weather_code,temperature_2m,apparent_temperature,wind_speed_10m,` +
    `wind_gusts_10m,precipitation,snowfall,uv_index` +
    `&minutely_15=precipitation&forecast_minutely_15=96&forecast_days=${FORECAST_DAYS}` +
    `&timezone=${encodeURIComponent(process.env.TIMEZONE || 'Europe/Kyiv')}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return res.json();
}

// Ретраї з лінійним backoff: разові мережеві спайки не зривають цикл.
async function fetchForecast(lat, lon) {
  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      return await fetchOnce(lat, lon);
    } catch (err) {
      lastErr = err;
      stats.inc('forecast_errors');
      log.warn(`Open-Meteo attempt ${attempt + 1}/${FETCH_RETRIES + 1} failed:`, err.message);
      if (attempt < FETCH_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  log.error('Open-Meteo fetch failed after retries:', lastErr.message);
  return null;
}

// Швидка перевірка: чи є в найближчі N годин хоч якась активність
// (для рішення про «освіження» прогнозу біля події).
function hasNearActivity(forecastJson, hours) {
  if (!forecastJson || !forecastJson.hourly) return false;
  const { time, weather_code, precipitation, snowfall } = forecastJson.hourly;
  const parse = timeParser(forecastJson);
  const nowMs = Date.now();
  for (let i = 0; i < time.length; i++) {
    const hoursAhead = (parse(time[i]).getTime() - nowMs) / 3600000;
    if (hoursAhead < 0 || hoursAhead > hours) continue;
    const code = weather_code ? weather_code[i] : 0;
    const mm = precipitation ? precipitation[i] : 0;
    const cm = snowfall ? snowfall[i] : 0;
    if (classifyHour(code, 0, mm, cm, 0, 0)) return true;
  }
  return false;
}

// Класифікація однієї години. Одна година може містити декілька явищ
// одночасно (гроза + шквал + злива), тому спочатку збираємо ВСІХ кандидатів,
// потім повертаємо найприоритетніший вид із максимальним рівнем небезпеки.
function hourlyCandidates(code, gustMs, mm, snowCm, tappC, uvIndex) {
  const out = [];
  // Гроза з градом (96/99 — гроза з градом, 97 — сильна гроза з градом)
  if (code === 96 || code === 99) out.push({ kind: 'hail', severity: 3 });
  // Гроза
  if (code === 95) out.push({ kind: 'thunder', severity: 2 });
  if (code === 97) out.push({ kind: 'thunder', severity: 3 });
  // Ожеледиця: крижаний дощ (66/67), крижана мряка (56/57)
  if (code === 67) out.push({ kind: 'ice', severity: 3 });
  if (code === 66 || code === 57) out.push({ kind: 'ice', severity: 2 });
  if (code === 56) out.push({ kind: 'ice', severity: 1 });
  // Вітер (пориви)
  const windSev = severityByThresholds(gustMs, WIND_Y_MS, WIND_O_MS, WIND_R_MS);
  if (windSev > 0) out.push({ kind: 'wind', severity: windSev });
  // Сніг/хуртовина: коди 71-77 (сніг), 85/86 (зливи снігу), або інтенсивність
  const snowSev = Math.max(
    severityByThresholds(snowCm, SNOW_Y_CM_H, SNOW_O_CM_H, SNOW_R_CM_H),
    [73, 74, 75, 77, 86].includes(code) ? 2 : ([71, 72, 85].includes(code) ? 1 : 0)
  );
  if (snowSev > 0) out.push({ kind: 'snow', severity: snowSev });
  // Дощ
  if (RAIN_CODES.includes(code) || mm >= RAIN_THRESHOLD_MM) {
    const sev = Math.max(
      severityByThresholds(mm, MIN_RAIN_MM_H, RAIN_O_MM_H, RAIN_R_MM_H),
      [63, 65, 82].includes(code) ? 2 : 0,
      code === 65 ? 3 : 0
    );
    out.push({ kind: 'rain', severity: Math.max(1, sev) });
  }
  // Спека / мороз (за відчуваюаною температурою)
  if (tappC >= HEAT_Y_C) out.push({ kind: 'heat', severity: severityByThresholds(tappC, HEAT_Y_C, HEAT_O_C, HEAT_R_C) });
  if (tappC <= COLD_Y_C) out.push({ kind: 'cold', severity: severityByThresholds(-tappC, -COLD_Y_C, -COLD_O_C, -COLD_R_C) });
  // Туман
  if (code === 45 || code === 48) out.push({ kind: 'fog', severity: 1 });
  // УФ-індекс
  if (uvIndex >= UV_Y) out.push({ kind: 'uv', severity: severityByThresholds(uvIndex, UV_Y, UV_O, UV_R) });
  return out;
}

function classifyHour(code, gustMs, mm, snowCm, tappC, uvIndex) {
  const cands = hourlyCandidates(code, gustMs, mm, snowCm, tappC, uvIndex);
  if (cands.length === 0) return null;
  const sorted = [...cands].sort((a, b) =>
    KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind));
  const best = sorted[0];
  return { kind: best.kind, severity: Math.max(...cands.map((c) => c.severity)) };
}

const RAIN_CODES = [51, 53, 55, 61, 62, 63, 64, 65, 80, 81, 82];
const SNOW_CODES = [71, 72, 73, 74, 75, 77, 85, 86];

// Знаходить усі події, що перетинаються з вікном [fromHours, toHours]
// відносно зараз. Сусідні години з будь-якою активністю склеюються в один
// ран; kind рану — найприоритетніше явище в ньому, severity — максимум.
function findEvents(forecastJson, fromHours, toHours) {
  if (!forecastJson || !forecastJson.hourly) return [];
  const H = forecastJson.hourly;
  const parse = timeParser(forecastJson);
  const nowMs = Date.now();

  function hourlyVal(arr, i, dflt) {
    return Array.isArray(arr) && arr[i] != null ? arr[i] : dflt;
  }

  const runs = [];
  let run = null;

  function flushRun() {
    if (!run) return;
    const kind = Array.from(run.kinds).sort((a, b) =>
      KIND_PRIORITY.indexOf(a) - KIND_PRIORITY.indexOf(b))[0];

    let significant = true;
    if (kind === 'rain') {
      const heavy = run.maxMm >= HEAVY_RAIN_MM_H;
      const enoughIntensity = run.maxMm >= MIN_RAIN_MM_H;
      const enoughDuration = (run.endIdx - run.startIdx + 1) >= MIN_RAIN_DURATION_HOURS;
      significant = enoughIntensity && (enoughDuration || heavy);
    } else if (CATEGORY_OF[kind] === 'precip' ||
               kind === 'heat' || kind === 'cold' || kind === 'fog' || kind === 'uv') {
      significant = (run.endIdx - run.startIdx + 1) >= MILD_MIN_DURATION_HOURS;
    }

    if (significant) {
      runs.push({
        kind,
        category: CATEGORY_OF[kind],
        severity: run.maxSeverity,
        startTime: parse(H.time[run.startIdx]),
        endTime: new Date(parse(H.time[run.endIdx]).getTime() + 3600000),
        maxMm: run.maxMm,
        maxSnowCm: run.maxSnowCm,
        maxGustMs: run.maxGustMs,
        maxTappC: run.maxTappC,
        minTappC: run.minTappC,
        maxUv: run.maxUv
      });
    }
    run = null;
  }

  for (let i = 0; i < H.time.length; i++) {
    const cls = classifyHour(
      hourlyVal(H.weather_code, i, 0),
      hourlyVal(H.wind_gusts_10m, i, 0) / 3.6, // км/год → м/с
      hourlyVal(H.precipitation, i, 0),
      hourlyVal(H.snowfall, i, 0),
      hourlyVal(H.apparent_temperature, i, 0),
      hourlyVal(H.uv_index, i, 0)
    );

    if (cls) {
      const gust = hourlyVal(H.wind_gusts_10m, i, 0) / 3.6;
      const tapp = hourlyVal(H.apparent_temperature, i, 0);
      if (!run) {
        run = {
          startIdx: i, endIdx: i,
          kinds: new Set([cls.kind]),
          maxSeverity: cls.severity,
          maxMm: hourlyVal(H.precipitation, i, 0),
          maxSnowCm: hourlyVal(H.snowfall, i, 0),
          maxGustMs: gust,
          maxTappC: tapp,
          minTappC: tapp,
          maxUv: hourlyVal(H.uv_index, i, 0)
        };
      } else {
        run.endIdx = i;
        run.kinds.add(cls.kind);
        if (cls.severity > run.maxSeverity) run.maxSeverity = cls.severity;
        run.maxMm = Math.max(run.maxMm, hourlyVal(H.precipitation, i, 0));
        run.maxSnowCm = Math.max(run.maxSnowCm, hourlyVal(H.snowfall, i, 0));
        run.maxGustMs = Math.max(run.maxGustMs, gust);
        run.maxTappC = Math.max(run.maxTappC, tapp);
        run.minTappC = Math.min(run.minTappC, tapp);
        run.maxUv = Math.max(run.maxUv, hourlyVal(H.uv_index, i, 0));
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

// Точний початок опадів по minutely_15 (крок 15 хв): перший слот у межах
// події з інтенсивністю >= MIN_RAIN_MM_H. Для решти явищ — годинний слот.
// Поза горизонтом 24 год (minutely_15) залишається годинний початок.
function refineOnset(event, forecastJson) {
  const isPrecip = event.kind === 'rain' || event.kind === 'snow' ||
    event.kind === 'ice' || event.kind === 'hail';
  if (!isPrecip) return event.startTime;
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
function analyzeForecast(forecastJson, opts = {}) {
  const soonHours = opts.soonWindowHours != null ? opts.soonWindowHours : SOON_WINDOW_HOURS;
  const maxHours = opts.maxHours != null ? opts.maxHours : OUTLOOK_MAX_HOURS;
  const nowMs = Date.now();
  const now = new Date(nowMs);

  const events = findEvents(forecastJson, -1, maxHours).map((ev) => ({
    ...ev,
    onset: refineOnset(ev, forecastJson)
  }));

  const imminent = [];
  const outlook = [];
  for (const ev of events) {
    if (ev.endTime.getTime() <= nowMs) continue;
    if (ev.onset.getTime() <= nowMs + soonHours * 3600000) imminent.push(ev);
    else outlook.push(ev);
  }

  // Найнебезпечніші — першими
  imminent.sort((a, b) => (b.severity - a.severity) || (a.onset - b.onset));
  outlook.sort((a, b) => a.onset - b.onset);
  return { imminent, outlook, now };
}

module.exports = {
  getForecast,
  analyzeForecast,
  findEvents,
  classifyHour,
  clusterKeyOf,
  CATEGORY_OF,
  KIND_PRIORITY,
  RAIN_THRESHOLD_MM,
  MIN_RAIN_MM_H,
  MIN_RAIN_DURATION_HOURS,
  HEAVY_RAIN_MM_H,
  SOON_WINDOW_HOURS,
  OUTLOOK_MAX_HOURS
};
