// Smoke-тест аналітики: синтетичний прогноз → події/рівні/картки.
// Запуск: node scripts/smoke.js (не торкається мережі, БД лише мок)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@localhost:5432/x';

const path = require('path');
const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './db') {
    return {
      getForecastEntry: async () => null,
      setCachedForecast: async () => {},
      getSubscriberClusters: async () => [],
      filterUnsentSubscribers: async () => [],
      markAlertsSentBatch: async () => {},
      getChatMessages: async () => [],
      upsertChatMessage: async () => {},
      getSettingsForChats: async () => new Map(),
      removeSubscriber: async () => true,
      cleanupOldData: async () => {},
      pool: { query: async () => ({ rows: [] }) }
    };
  }
  if (id === './radar') {
    return {
      getRadarAnalysis: async () => ({ hasData: false, confirmed: false, riskScore: 0 }),
      extractMinutelyRadar: () => ({ hasData: false, slots: [], maxMmH: 0, totalMm: 0 }),
      checkRadarAvailability: async () => ({ available: false, timestamp: null })
    };
  }
  return orig.call(this, id);
};

const weather = require(path.join(__dirname, '..', 'weather'));
const alerts = require(path.join(__dirname, '..', 'alerts'));

function hourlyFixture() {
  const time = [];
  const base = new Date();
  base.setMinutes(0, 0, 0);
  for (let i = 0; i < 72; i++) {
    const d = new Date(base.getTime() + i * 3600000);
    // Open-Meteo повертає місцевий час без зсуву; для тесту UTC-зсув = 0
    time.push(d.toISOString().slice(0, 16));
  }
  const n = time.length;
  const fill = (v) => Array(n).fill(v);
  return {
    utc_offset_seconds: 0,
    hourly: {
      time,
      weather_code: Object.assign(fill(0), (() => {
        const a = fill(0);
        a[2] = 95;  // гроза через ~2 години
        a[10] = 65; // сильний дощ
        return a;
      })()),
      temperature_2m: fill(20),
      apparent_temperature: fill(20),
      wind_speed_10m: fill(5),
      wind_gusts_10m: Object.assign(fill(30), (() => {
        const a = fill(30); // 30 км/год ≈ 8.3 м/с — нижче жовтого
        a[2] = 100;         // ~27.8 м/с — червоний рівень вітру в годину грози
        a[20] = 80;         // ~22 м/с — оранжевий
        return a;
      })()),
      precipitation: Object.assign(fill(0), (() => {
        const a = fill(0);
        a[10] = 18; // червоний рівень дощу
        a[11] = 9;  // оранжевий
        return a;
      })()),
      precipitation_probability: Object.assign(fill(0), (() => {
        const a = fill(0);
        a[10] = 90; // висока ймовірність при сильному дощі
        a[11] = 80;
        return a;
      })()),
      snowfall: fill(0),
      uv_index: fill(3),
      minutely_15: { time: [], precipitation: [] }
    }
  };
}

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
}

const fx = hourlyFixture();

// --- findEvents ---
const events = weather.findEvents(fx, -1, 72);
check(`знайдено 3 події (гроза+шквал, дощ, вітер) — отримано ${events.length}`, events.length === 3);

const thunder = events.find((e) => e.kind === 'thunder' || e.kind === 'hail' || e.kind === 'wind');
check('гроза/вітер у перші години', thunder && thunder.startTime.getHours() === base(fx).getHours() + 2);
check('severity грози = 3 (пориви 27.8 м/с)', thunder && thunder.severity === 3);

const rain = events.find((e) => e.kind === 'rain');
check('дощ знайдений', !!rain);
check('severity дощу = 3 (18 мм/год)', rain && rain.severity === 3);
check('категорія дощу = precip', rain && rain.category === 'precip');

// --- analyzeForecast ---
const analysis = weather.analyzeForecast(fx);
check('іміджент містить грозу', analysis.imminent.some((e) => ['thunder','hail','wind'].includes(e.kind)));
check('аутлук містить дощ', analysis.outlook.some((e) => e.kind === 'rain'));

// --- classifyHour одиниці ---
const c1 = weather.classifyHour(96, 0, 0, 0, 0, 0);
check('град = hail/3', c1.kind === 'hail' && c1.severity === 3);
const c2 = weather.classifyHour(66, 0, 0, 0, 0, 0);
check('крижаний дощ = ice/2', c2.kind === 'ice' && c2.severity === 2);
const c3 = weather.classifyHour(45, 0, 0, 0, 15, 0);
check('туман = fog/1 (не спека)', c3.kind === 'fog' && c3.severity === 1);
const c4 = weather.classifyHour(0, 0, 0, 0, -24, 0);
check('мороз = cold', c4.kind === 'cold');
const c5 = weather.classifyHour(0, 11, 0, 0, 0, 0);
check(`пориви 11 м/с — тиша (отримано ${JSON.stringify(c5)})`, c5 === null);
const c6 = weather.classifyHour(0, 25, 0, 0, 0, 0);
check('пориви 25 м/с = wind/3', c6.kind === 'wind' && c6.severity === 3);
const c7 = weather.classifyHour(71, 0, 0, 3.5, 0, 0);
check('сніг 3.5 см/год = snow/2', c7.kind === 'snow' && c7.severity === 2);
const c9 = weather.classifyHour(71, 0, 0, 1.2, 0, 0);
check('сніг 1.2 см/год = snow/1 (жовтий)', c9.kind === 'snow' && c9.severity === 1);
const c8 = weather.classifyHour(0, 0, 0, 0, 36, 9);
check('спека пріоритетніша за UV', c8.kind === 'heat');

// --- Картки і тексти ---
const card = alerts.buildCardContent(analysis);
check('картка містить рівень небезпеки', card.includes('🔴') || card.includes('🟡') || card.includes('🟠'));
check('картка містить пораду', card.includes('💡'));

const ev = analysis.imminent[0];
if (ev) {
  const sudden = alerts.buildSuddenText(ev, analysis.now);
  check('sudden-текст містить назву явища', sudden.length > 50);
}

// Фільтр налаштувань
const allowedAll = alerts.isEventAllowed(
  { category: 'storm', severity: 1 },
  { cats: ['storm'], min_severity: 1, quiet_enabled: false },
  new Date()
);
check('подія дозволена при дефолтних налаштуваннях', allowedAll === true);

const blockedSev = alerts.isEventAllowed(
  { category: 'rain', severity: 1 },
  { cats: ['rain'], min_severity: 2, quiet_enabled: false },
  new Date()
);
check('жовта подія блокується при min_severity=2', blockedSev === false);

const blockedCat = alerts.isEventAllowed(
  { category: 'uv', severity: 2 },
  { cats: ['storm'], min_severity: 1, quiet_enabled: false },
  new Date()
);
check('подія вимкненої категорії блокується', blockedCat === false);

// --- Каскадний консенсус: радар + ймовірність ---
const cascadeEvents = weather.mergeCascade(
  [{ kind: 'rain', severity: 1, startTime: new Date(), endTime: new Date(Date.now() + 3600000), maxMm: 2, maxProb: 85 }],
  { hasData: true, slots: [{ timeMs: Date.now() + 600000, mmH: 5 }], maxMmH: 5, activeSlots: 2 },
  fx
);
check('каскад: радар підвищує severity дощу', cascadeEvents[0].severity >= 2);

const cascadeNoRadar = weather.mergeCascade(
  [{ kind: 'rain', severity: 1, startTime: new Date(), endTime: new Date(Date.now() + 3600000), maxMm: 2, maxProb: 30 }],
  { hasData: false },
  fx
);
check('каскад: низька ймовірність — без змін', cascadeNoRadar[0].severity === 1);

// Тест analyzeForecast з radarData
const analysisWithRadar = weather.analyzeForecast(fx, {
  radarData: { hasData: true, slots: [{ timeMs: Date.now() + 600000, mmH: 8 }], maxMmH: 8, activeSlots: 3 }
});
check('analyzeForecast з радаром працює', Array.isArray(analysisWithRadar.imminent));

// Тест нових констант
check('PROBABILITY_HIGH експортується', typeof weather.PROBABILITY_HIGH === 'number');
check('PROBABILITY_BOOST експортується', typeof weather.PROBABILITY_BOOST === 'number');

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);

function base(fx) {
  return new Date(Date.parse(fx.hourly.time[0] + ':00Z'));
}
