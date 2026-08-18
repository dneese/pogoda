const crypto = require('crypto');
const {
  getSubscriberClusters,
  filterUnsentSubscribers,
  markAlertsSentBatch,
  getChatMessages,
  upsertChatMessage,
  cleanupOldData
} = require('./db');
const { getForecast, analyzeForecast, OUTLOOK_MAX_HOURS } = require('./weather');

const SUDDEN_MINUTES = parseInt(process.env.SUDDEN_MINUTES || '60', 10);
const SEND_CONCURRENCY = parseInt(process.env.SEND_CONCURRENCY || '10', 10);
const TZ = process.env.TIMEZONE || 'Europe/Kyiv';

const EMOJI = { rain: '🌧', thunder: '⛈', urgent: '🚨' };

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

// Візуалізація інтенсивності: ▓▓░░ — 4-клітинна «шкала»
function intensityBar(mm) {
  const filled = mm >= 4 ? 4 : mm >= 2 ? 3 : mm >= 1 ? 2 : 1;
  return '▓'.repeat(filled) + '░'.repeat(4 - filled);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Рядок іміджент-події у картці
function eventLine(ev, now) {
  const t = formatTime(ev.onset);
  const rel = relLabel(ev.onset.getTime() - now.getTime());
  const to = formatTime(ev.endTime);
  if (ev.kind === 'urgent') {
    return `${EMOJI.urgent} ${ev.description} — о **${t}** (${rel})`;
  }
  if (ev.kind === 'thunder') {
    return `⛈ Гроза — о **${t}** (${rel}), триватиме до **${to}**`;
  }
  return `🌧 Дощ — о **${t}** (${rel}), триватиме до **${to}** · ${intensityBar(ev.maxMm)} ${ev.maxMm.toFixed(1)} мм/год`;
}

// Rich Markdown-картка: іміджент + аутлук на кілька днів в одному
// повідомленні. content_hash вважається по цьому рендеру (без
// «Оновлено о …», щоб час у футері не викликав зайвих редагувань).
function buildCardContent({ imminent, outlook, now }) {
  const parts = [];

  if (imminent.length > 0) {
    const lead = imminent[0];
    if (lead.kind === 'urgent') parts.push(`# 🚨 Небезпека: ${lead.description}!`);
    else if (lead.kind === 'thunder') parts.push('# ⛈ Гроза наближається!');
    else parts.push('# 🌧 Дощ наближається!');
    parts.push('');
    for (const ev of imminent) parts.push(`> ${eventLine(ev, now)}`);
    parts.push('');
    parts.push('Прогноз уточнюється — це повідомлення оновлюється автоматично.');
  } else if (outlook.length > 0) {
    parts.push('# ☔ Дощ найближчими днями');
    parts.push('');
    parts.push('За 3 години до дощу уточню точний час окремим попередженням.');
  } else {
    parts.push('# ☀️ Дощу не очікується');
    parts.push('');
    parts.push(`Найближчі ${Math.round(OUTLOOK_MAX_HOURS / 24)} дні — сухо.`);
  }

  if (outlook.length > 0) {
    parts.push('');
    parts.push('## Найближчі дні');
    parts.push('');
    parts.push('| День | Коли | Тривалість | Інтенсивність |');
    parts.push('| :-- | :-- | :-- | :-- |');
    for (const ev of outlook) {
      const from = formatTime(ev.onset);
      const to = formatTime(ev.endTime);
      parts.push(
        `| ${dayName(ev.onset)} | ${EMOJI[ev.kind]} ${from}–${to} | ${durationLabel(ev)} | ${intensityBar(ev.maxMm)} ${ev.maxMm.toFixed(1)} мм/год |`
      );
    }
  }

  parts.push('');
  parts.push('---');
  parts.push(`*Оновлено о ${formatTime(now)} · @RainNot_bot*`);
  return parts.join('\n');
}

// Нове повідомлення — тільки «раптовий дощ» (start в межах SUDDEN_MINUTES)
// та ураган/град. Решта — редагування картки.
function buildSuddenText(ev, now) {
  const t = formatTime(ev.onset);
  const rel = relLabel(ev.onset.getTime() - now.getTime());
  const to = formatTime(ev.endTime);
  if (ev.kind === 'urgent') {
    return `# 🚨 ${ev.description}!\n\nОчікується о **${t}** (${rel}).\n\n> Терміново сховайтеся в безпечне місце!`;
  }
  if (ev.kind === 'thunder') {
    return `# ⛈ Раптова гроза!\n\nГроза очікується о **${t}** (${rel}), триватиме до **${to}**.\n\n> Перечекайте вдома, подалі від вікон.`;
  }
  return `# 🌧 Раптовий дощ!\n\nДощ почнеться о **${t}** (${rel}) і триватиме до **${to}**.\n\n> Швидше зайдіть додому — і не забудьте парасольку!`;
}

// --- Виконання -------------------------------------------------------

function isMessageNotFound(err) {
  const resp = err && err.response && err.response.body && err.response.body.description;
  const desc = String((err && err.message) || resp || '');
  return desc.toLowerCase().includes('not found');
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
        console.error('runPool item error:', err.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
}

async function sendRichConcurrently(bot, chatIds, markdown) {
  const sentIds = [];
  let cursor = 0;
  async function worker() {
    while (cursor < chatIds.length) {
      const idx = cursor++;
      const chatId = chatIds[idx];
      try {
        await bot.sendRichMessage(chatId, { markdown });
        sentIds.push(chatId);
      } catch (err) {
        console.error(`Failed to send rich message to ${chatId}:`, err.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const workers = Array.from({ length: Math.min(SEND_CONCURRENCY, chatIds.length) }, worker);
  await Promise.all(workers);
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
  await runPool(ops, async (op) => {
    if (op.existingId != null) {
      try {
        await bot.editMessageText({
          chat_id: op.chatId,
          message_id: op.existingId,
          rich_message: { markdown: content }
        });
        updated.push({ chatId: op.chatId, messageId: op.existingId });
        return;
      } catch (err) {
        if (!isMessageNotFound(err)) {
          console.error(`Failed to edit card for ${op.chatId}:`, err.message);
          return;
        }
        // повідомлення видалено користувачем — надсилаємо нове
      }
    }
    try {
      const msg = await bot.sendRichMessage(op.chatId, { markdown: content });
      updated.push({ chatId: op.chatId, messageId: msg.message_id });
    } catch (err) {
      console.error(`Failed to send card to ${op.chatId}:`, err.message);
    }
  }, SEND_CONCURRENCY);

  for (const u of updated) {
    await upsertChatMessage(u.chatId, u.messageId, hash);
  }
}

// Нове 🚨-повідомлення: ураган/град завжди, решта — якщо подія
// починається в межах SUDDEN_MINUTES. Дедуп через sent_alerts
// (kind = kind події, ключ = годинний слот старту).
async function sendSuddenAlerts(bot, chatIds, analysis) {
  const now = analysis.now;
  for (const ev of analysis.imminent) {
    const isUrgent = ev.kind === 'urgent';
    const isSudden = ev.onset.getTime() - now.getTime() <= SUDDEN_MINUTES * 60000;
    if (!isUrgent && !isSudden) continue;

    const toNotify = await filterUnsentSubscribers(chatIds, ev.kind, ev.startTime);
    if (toNotify.length === 0) continue;

    const text = buildSuddenText(ev, now);
    const sent = await sendRichConcurrently(bot, toNotify, text);
    if (sent.length > 0) {
      await markAlertsSentBatch(sent, ev.kind, ev.startTime);
    }
  }
}

async function checkAndNotify(bot) {
  try {
    await cleanupOldData();

    const clusters = await getSubscriberClusters();
    if (clusters.length === 0) return;

    for (const cluster of clusters) {
      const { center_lat: lat, center_lon: lon, chat_ids: chatIds } = cluster;

      const forecast = await getForecast(lat, lon);
      if (!forecast) continue;

      const analysis = analyzeForecast(forecast);
      await updateCards(bot, chatIds, analysis);
      await sendSuddenAlerts(bot, chatIds, analysis);
    }
  } catch (err) {
    console.error('checkAndNotify error:', err);
  }
}

module.exports = { checkAndNotify, buildCardContent, buildSuddenText };