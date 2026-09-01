const crypto = require('crypto');
const {
  getSubscriberClusters,
  filterUnsentSubscribers,
  markAlertsSentBatch,
  getChatMessages,
  upsertChatMessage,
  getSettingsForChats,
  removeSubscriber,
  cleanupOldData
} = require('./db');
const { getForecast, analyzeForecast, OUTLOOK_MAX_HOURS } = require('./weather');
const { getRadarAnalysis } = require('./radar');
const stats = require('./stats');
const log = require('./logger');

const SUDDEN_MINUTES = parseInt(process.env.SUDDEN_MINUTES || '60', 10);
const SEND_CONCURRENCY = parseInt(process.env.SEND_CONCURRENCY || '10', 10);
const TZ = process.env.TIMEZONE || 'Europe/Kyiv';

// --- Мета даних про явища і рівні -------------------------------------
// Рівні небезпеки за моделлю MeteoAlarm/CAP:
//   1 → 🟡 жовтий (будьте уважні), 2 → 🟠 оранжевий (небезпечно),
//   3 → 🔴 червоний (надзвичайна небезпека)
const SEVERITY_META = {
  1: { emoji: '🟡', label: 'Жовтий рівень небезпеки' },
  2: { emoji: '🟠', label: 'Оранжевий рівень небезпеки' },
  3: { emoji: '🔴', label: 'Червоний рівень небезпеки' }
};

// Короткі поради з безпеки — як в офіційних попередженнях: кожне
// сповіщення має казати, ЩО РОБИТИ, а не лише ЩО відбувається.
const KIND_META = {
  rain:    { emoji: '🌧', name: 'Дощ',
             tip: 'Візьміть парасольку, закладіть більше часу на дорогу.' },
  thunder: { emoji: '⛈', name: 'Гроза',
             tip: 'Перечекайте в приміщенні, подалі від вікон. Не ховайтеся під поодинокими деревами.' },
  hail:    { emoji: '🌨', name: 'Град',
             tip: 'Негайно сховайтеся в приміщенні або під надійним дахом. Защітьте автомобіль.' },
  wind:    { emoji: '💨', name: 'Сильний вітер',
             tip: 'Уникайте дерев, рекламних щитів і ЛЕП. Закрийте вікна та балкони.' },
  snow:    { emoji: '❄️', name: 'Снігопад/хуртовина',
             tip: 'На дорозі ожеледиця — пересуйтеся обережно, плануйте більше часу.' },
  ice:     { emoji: '🧊', name: 'Ожеледиця (крижаний дощ)',
             tip: 'Дороги та тротуари дуже слизькі. Взуття з нескользкою підошвою, обережно на сходах.' },
  heat:    { emoji: '🔥', name: 'Спека',
             tip: 'Пийте більше води, уникайте сонця 11:00–17:00. Ніколи не лишайте дітей у машині.' },
  cold:    { emoji: '🥶', name: 'Сильний мороз',
             tip: 'Одягайтеся багатошарово, обмежте перебування на вулиці. Слідкуйте за ознаками обмороження.' },
  fog:     { emoji: '🌫', name: 'Туман',
             tip: 'На дорозі — увімкніть протитуманні фари, тримайте дистанцію.' },
  uv:      { emoji: '☀️', name: 'Високий УФ-індекс',
             tip: "Користуйтеся SPF 30+, сонцезахисними окулярами. Не засмагайте в пік активності." }
};

function severityMeta(sev) {
  return SEVERITY_META[sev] || SEVERITY_META[1];
}

// --- Форматування ----------------------------------------------------

function formatTime(date) {
  return date.toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ
  });
}

function dayName(date) {
  return date.toLocaleDateString('uk-UA', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: TZ
  });
}

function minutesLabel(m) {
  if (m % 10 === 1 && m % 100 !== 11) return `${m} хвилина`;
  if (m % 10 >= 2 && m % 10 <= 4 && (m % 100 < 12 || m % 100 > 14)) return `${m} хвилини`;
  return `${m} хвилин`;
}

function hoursLabel(h) {
  if (h % 10 === 1 && h % 100 !== 11) return `${h} година`;
  if (h % 10 >= 2 && h % 10 <= 4 && (h % 100 < 12 || h % 100 > 14)) return `${h} години`;
  return `${h} годин`;
}

// «через ~15 хвилин» / «через ~2 години 15 хв» / «йде зараз»
function relLabel(diffMs) {
  const min = Math.round(diffMs / 60000);
  if (min <= 0) return 'йде зараз';
  if (min < 60) return `через ~${minutesLabel(min)}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `через ~${hoursLabel(h)} ${m} хв` : `через ~${hoursLabel(h)}`;
}

function durationLabel(ev) {
  const start = ev.onset || ev.startTime;
  const hours = Math.max(1, Math.round((ev.endTime - start) / 3600000));
  return hoursLabel(hours);
}

// Візуалізація інтенсивності опадів: ▓▓░░ — 4-клітинна «шкала»
function intensityBar(v, thresholds) {
  const t = thresholds || [1, 2, 4];
  const filled = v >= t[2] ? 4 : v >= t[1] ? 3 : v >= t[0] ? 2 : 1;
  return '▓'.repeat(filled) + '░'.repeat(4 - filled);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Деталі події для картки: максимум явища, що визначає kind.
function eventDetails(ev) {
  switch (ev.kind) {
    case 'wind': return `пориви до ${Math.round(ev.maxGustMs)} м/с`;
    case 'snow': return `${ev.maxSnowCm.toFixed(1)} см/год`;
    case 'heat': return `відчувається як +${Math.round(ev.maxTappC)}°C`;
    case 'cold': return `відчувається як ${Math.round(ev.minTappC)}°C`;
    case 'uv':   return `УФ-індекс ${Math.round(ev.maxUv)}`;
    case 'rain': return `${intensityBar(ev.maxMm)} до ${ev.maxMm.toFixed(1)} мм/год`;
    default: return null;
  }
}

// Рядок іміджент-події у картці
function eventLine(ev, now) {
  const meta = KIND_META[ev.kind] || KIND_META.rain;
  const sev = severityMeta(ev.severity);
  const t = formatTime(ev.onset);
  const rel = relLabel(ev.onset.getTime() - now.getTime());
  const to = formatTime(ev.endTime);
  const det = eventDetails(ev);
  const detPart = det ? ` · ${det}` : '';
  return `${sev.emoji} ${meta.name} — о **${t}** (${rel}), до **${to}**${detPart}`;
}

// Rich Markdown-картка: іміджент + аутлук на кілька днів в одному
// повідомленні. content_hash вважається по цьому рендеру (без
// «Оновлено о …», щоб час у футері не викликав зайвих редагувань).
function buildCardContent({ imminent, outlook, now }) {
  const parts = [];

  // Найвищий рівень серед іміджент-подій визначає заголовок картки
  const maxSev = imminent.reduce((m, ev) => Math.max(m, ev.severity), 0);

  if (imminent.length > 0) {
    const lead = imminent[0];
    const leadMeta = KIND_META[lead.kind] || KIND_META.rain;
    parts.push(`# ${severityMeta(maxSev).emoji} ${leadMeta.name} наближається!`);
    if (maxSev >= 2) {
      parts.push('');
      parts.push(`**${severityMeta(maxSev).label}**`);
    }
    parts.push('');
    for (const ev of imminent) parts.push(`> ${eventLine(ev, now)}`);
    parts.push('');
    parts.push(`💡 ${leadMeta.tip}`);
    parts.push('');
    parts.push('Прогноз уточнюється — це повідомлення оновлюється автоматично.');
  } else if (outlook.length > 0) {
    parts.push('# 📅 Небезпечні явища найближчими днями');
    parts.push('');
    parts.push('За 3 години до початку уточню час окремим попередженням.');
  } else {
    parts.push('# ☀️ Небезпечних явищ не очікується');
    parts.push('');
    parts.push(`Найближчі ${Math.round(OUTLOOK_MAX_HOURS / 24)} дні — спокійно.`);
  }

  if (outlook.length > 0) {
    parts.push('');
    parts.push('## Найближчі дні');
    parts.push('');
    parts.push('| День | Явище | Коли | Деталі |');
    parts.push('| :-- | :-- | :-- | :-- |');
    for (const ev of outlook) {
      const meta = KIND_META[ev.kind] || KIND_META.rain;
      const from = formatTime(ev.onset);
      const to = formatTime(ev.endTime);
      const det = eventDetails(ev) || `${durationLabel(ev)}`;
      parts.push(
        `| ${dayName(ev.onset)} | ${severityMeta(ev.severity).emoji} ${meta.name} | ${from}–${to} | ${det} |`
      );
    }
  }

  parts.push('');
  parts.push('---');
  parts.push(`*Оновлено о ${formatTime(now)} · @RainNot_bot*`);
  return parts.join('\n');
}

// Нове push-повідомлення. Надсилається для червоних/оранжевих подій
// завжди, для жовтих — якщо початок в межах SUDDEN_MINUTES.
// Включає рівень небезпеки + конкретну пораду з безпеки.
function buildSuddenText(ev, now) {
  const meta = KIND_META[ev.kind] || KIND_META.rain;
  const sev = severityMeta(ev.severity);
  const t = formatTime(ev.onset);
  const rel = relLabel(ev.onset.getTime() - now.getTime());
  const to = formatTime(ev.endTime);
  const det = eventDetails(ev);
  const detLine = det ? `\n\n📊 **${det}**` : '';

  // 🔴 червоний — крик; 🟠/🟡 — спокійніше
  const title = ev.severity >= 3
    ? `${sev.emoji} ${meta.name.toUpperCase()} — НЕГАЙНО!`
    : `${sev.emoji} ${sev.label}: ${meta.name}`;

  return `${title}\n\n` +
    `${meta.name} очікується о **${t}** (${rel}) і триватиме приблизно до **${to}**.` +
    detLine +
    `\n\n> 💡 ${meta.tip}`;
}

// --- Фільтр за налаштуваннями користувача -----------------------------
// Кожен чат може: вимкнути категорії явищ, підняти мінімальний рівень
// небезпеки та ввімкнути тихі години (🔴 червоні проходять завжди).

function currentHourInTz(now = new Date()) {
  return parseInt(
    now.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }),
    10
  );
}

function inQuietHours(settings, hour) {
  if (!settings.quiet_enabled) return false;
  const start = settings.quiet_start;
  const end = settings.quiet_end;
  if (start === end) return true; // увесь день
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // через північ
}

function isEventAllowed(ev, settings, now) {
  if (settings.cats && !settings.cats.includes(ev.category)) {
    stats.inc('alerts_suppressed_settings');
    return false;
  }
  if (ev.severity < settings.min_severity) {
    stats.inc('alerts_suppressed_settings');
    return false;
  }
  // 🔴 червоний рівень — завжди пробиває тихі години
  if (ev.severity < 3 && inQuietHours(settings, currentHourInTz(now))) {
    stats.inc('alerts_suppressed_quiet');
    return false;
  }
  return true;
}

// --- Виконання -------------------------------------------------------

function isMessageNotFound(err) {
  const resp = err && err.response && err.response.body && err.response.body.description;
  const desc = String((err && err.message) || resp || '');
  return desc.toLowerCase().includes('not found');
}

// Чат більше не може отримувати повідомлення (бот заблокований/видалений/
// користувач вийшов) — прибираємо підписника, щоб не витрачати на нього
// запити до Telegram і БД в кожному циклі.
function isChatUnavailable(err) {
  const resp = err && err.response && err.response.body && err.response.body.description;
  const desc = String((err && err.message) || resp || '').toLowerCase();
  return (
    desc.includes('bot was blocked by the user') ||
    desc.includes('chat not found') ||
    desc.includes('user is deactivated') ||
    desc.includes('kicked from')
  );
}

async function dropDeadChats(chatIds, errs) {
  for (const { chatId, err } of errs) {
    if (!isChatUnavailable(err)) continue;
    try {
      await removeSubscriber(chatId);
      stats.inc('blocked_chats_cleaned');
      log.info(`Removed unavailable chat ${chatId} from subscribers`);
    } catch (dbErr) {
      log.error(`Failed to remove dead chat ${chatId}:`, dbErr.message);
    }
  }
}

async function runPool(items, fn, limit) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        await fn(items[idx]);
      } catch (err) {
        // помилки вже оброблені всередині fn; це страховка
        log.error('runPool item error:', err.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
}

async function sendRichConcurrently(bot, chatIds, markdown) {
  const sentIds = [];
  const dead = [];
  let cursor = 0;
  async function worker() {
    while (cursor < chatIds.length) {
      const idx = cursor++;
      const chatId = chatIds[idx];
      try {
        await bot.sendRichMessage(chatId, { markdown });
        sentIds.push(chatId);
      } catch (err) {
        stats.inc('telegram_send_errors');
        log.warn(`Failed to send rich message to ${chatId}:`, err.message);
        dead.push({ chatId, err });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const workers = Array.from({ length: Math.min(SEND_CONCURRENCY, Math.max(1, chatIds.length)) }, worker);
  await Promise.all(workers);
  await dropDeadChats(chatIds, dead);
  return sentIds;
}

// Оновлює прогноз-картку кожного чату кластера: редагує існуюче
// повідомлення, якщо контент змінився; створює, якщо його ще нема.
async function updateCards(bot, chatIds, analysis) {
  const content = buildCardContent(analysis);
  const hash = sha256(content);
  const rows = await getChatMessages(chatIds);
  const byId = new Map(rows.map((r) => [r.chat_id, r]));

  const hasEvents = analysis.imminent.length > 0 || analysis.outlook.length > 0;
  const ops = [];
  for (const chatId of chatIds) {
    const row = byId.get(chatId);
    if (row && row.content_hash === hash) continue;
    if (!hasEvents && !row) continue; // картку «сухо» з нуля не створюємо
    ops.push({ chatId, existingId: row ? row.message_id : null });
  }
  if (ops.length === 0) return;

  const updated = [];
  const dead = [];
  await runPool(ops, async (op) => {
    if (op.existingId != null) {
      try {
        await bot.editMessageText({
          chat_id: op.chatId,
          message_id: op.existingId,
          rich_message: { markdown: content }
        });
        stats.inc('cards_updated');
        updated.push({ chatId: op.chatId, messageId: op.existingId });
        return;
      } catch (err) {
        if (!isMessageNotFound(err)) {
          stats.inc('telegram_send_errors');
          log.warn(`Failed to edit card for ${op.chatId}:`, err.message);
          dead.push({ chatId: op.chatId, err });
          return;
        }
        // повідомлення видалено користувачем — надсилаємо нове
      }
    }
    try {
      const msg = await bot.sendRichMessage(op.chatId, { markdown: content });
      stats.inc('cards_created');
      updated.push({ chatId: op.chatId, messageId: msg.message_id });
    } catch (err) {
      stats.inc('telegram_send_errors');
      log.warn(`Failed to send card to ${op.chatId}:`, err.message);
      dead.push({ chatId: op.chatId, err });
    }
  }, SEND_CONCURRENCY);
  await dropDeadChats(ops.map((o) => o.chatId), dead);

  await runPool(updated, (u) => upsertChatMessage(u.chatId, u.messageId, hash), SEND_CONCURRENCY);
}

// Push-повідомлення про небезпечні явища. Дедуп через sent_alerts
// (kind = kind події, ключ = годинний слот старту).
// НОВЕ: фільтр за індивідуальними налаштуваннями чата — категорії,
// мінімальний рівень небезпеки, тихі години.
async function sendSuddenAlerts(bot, chatIds, analysis) {
  const now = analysis.now;

  // Один запит на кластер замість запиту на кожну подію
  const settingsMap = await getSettingsForChats(chatIds);

  for (const ev of analysis.imminent) {
    // Жовті події штовхаємо тільки якщо вони «раптові»; оранжеві й
    // червоні — одразу, як тільки з'явилися в прогнозі.
    if (ev.severity < 2 && ev.onset.getTime() - now.getTime() > SUDDEN_MINUTES * 60000) continue;

    const unsent = await filterUnsentSubscribers(chatIds, ev.kind, ev.startTime);
    if (unsent.length === 0) continue;

    const toNotify = unsent.filter((chatId) =>
      isEventAllowed(ev, settingsMap.get(String(chatId)) || {}, now));
    if (toNotify.length === 0) continue;

    const text = buildSuddenText(ev, now);
    const sent = await sendRichConcurrently(bot, toNotify, text);
    if (sent.length > 0) {
      await markAlertsSentBatch(sent, ev.kind, ev.startTime);
    }
  }
}

let cycleRunning = false;
let cycleCount = 0;

async function checkAndNotify(bot) {
  // Захист від накладання циклів: попередній ще не завершився (довгий
  // Open-Meteo/розсилка) — поточний тік пропускаємо, нічого не втрачаємо.
  if (cycleRunning) {
    stats.inc('cron_skipped_overlaps');
    return;
  }
  cycleRunning = true;
  try {
    // Чистка застарілих записів — раз на годину, а не в кожному циклі.
    if (++cycleCount % 12 === 1) {
      await cleanupOldData();
    }

    const clusters = await getSubscriberClusters();
    if (clusters.length === 0) return;

    for (const cluster of clusters) {
      const { center_lat: lat, center_lon: lon, chat_ids: chatIds } = cluster;

      const forecast = await getForecast(lat, lon);
      if (!forecast) continue;

      // Каскад: радар + прогноз + ймовірність
      let radarData = null;
      try {
        radarData = await getRadarAnalysis(lat, lon, forecast);
      } catch (radarErr) {
        log.debug(`Radar analysis failed for cluster ${lat},${lon}:`, radarErr.message);
      }

      const analysis = analyzeForecast(forecast, { radarData });
      await updateCards(bot, chatIds, analysis);
      await sendSuddenAlerts(bot, chatIds, analysis);
    }
    stats.inc('cron_cycles');
  } catch (err) {
    log.error('checkAndNotify error:', err);
  } finally {
    cycleRunning = false;
  }
}

module.exports = {
  checkAndNotify,
  buildCardContent,
  buildSuddenText,
  isEventAllowed,
  KIND_META,
  SEVERITY_META
};
