require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');

const { bot, registerHandlers } = require('./bot');
const { checkAndNotify } = require('./alerts');
const { pool, closePool, getSubscriberCount } = require('./db');
const stats = require('./stats');
const log = require('./logger');

// Fail-fast: без токена/БД немає сенсу стартувати — читаємо помилку одразу
// в логах деплою, а не ловимо загадкові падіння пізніше.
if (!process.env.BOT_TOKEN) {
  console.error('FATAL: BOT_TOKEN is not set');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set');
  process.exit(1);
}

const VERSION = require('./package.json').version;
const PORT = process.env.PORT || 3000;
const USE_POLLING = process.env.USE_POLLING === 'true';
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ||
  (WEBHOOK_URL ? crypto.randomBytes(24).toString('hex') : null);

registerHandlers();

const app = express();
app.use(express.json());

if (!USE_POLLING) {
  app.post('/webhook', (req, res) => {
    // Telegram підписує кожен update секретом, який ми передали в setWebHook.
    if (WEBHOOK_SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) {
      return res.sendStatus(401);
    }
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

app.get('/', (req, res) => {
  res.json({ service: 'rain-alert-bot', version: VERSION, status: 'ok' });
});

// Health-check також перевіряє з'єднання з БД. Зворотна сумісність:
// ключі status/db/time збережені (UptimeRobot-пінги перевіряють лише HTTP 200).
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const subscribers = await getSubscriberCount().catch(() => null);
    res.json({
      status: 'ok',
      db: 'connected',
      time: new Date().toISOString(),
      version: VERSION,
      uptime_seconds: Math.floor(process.uptime()),
      subscribers
    });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

app.get('/metrics', (req, res) => {
  res.json(stats.snapshot());
});

const server = app.listen(PORT, async () => {
  log.info(`rain-alert-bot v${VERSION} listening on port ${PORT}`);

  if (!USE_POLLING && WEBHOOK_URL) {
    try {
      const opts = WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : {};
      await bot.setWebhook(`${WEBHOOK_URL}/webhook`, opts);
      log.info('Webhook встановлено:', `${WEBHOOK_URL}/webhook`);
    } catch (err) {
      log.error('Помилка встановлення webhook:', err.message);
    }
  } else if (USE_POLLING) {
    log.info('Бот працює в режимі polling (для локальної розробки)');
  }
});

let cronJob = null;
// Інтервал перевірки конфігурується через env CHECK_CRON (node-cron format).
// За замовчуванням — раз на 15 хвилин, достатньо для погоди і в рази дешевше
// ніж кожні 5 хв (менше активних CPU-секунд = менший рахунок).
const CHECK_CRON = process.env.CHECK_CRON || '*/15 * * * *';
cronJob = cron.schedule(CHECK_CRON, () => {
  log.debug('[cron] Перевірка погоди для всіх підписників...');
  checkAndNotify(bot).catch((err) => log.error('[cron] cycle failed:', err.message));
});

checkAndNotify(bot).catch((err) => log.error('[startup] initial cycle failed:', err.message));

async function shutdown(signal) {
  log.info(`${signal} отримано, завершення роботи...`);
  if (cronJob) cronJob.stop();
  if (!USE_POLLING) {
    try { await bot.deleteWebhook(); } catch (_) { /* вже знято */ }
  } else {
    try { await bot.stopPolling(); } catch (_) { /* вже зупинено */ }
  }
  server.close();
  setTimeout(() => process.exit(0), 5000).unref(); // страховка від зависання
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err);
  shutdown('UNCAUGHT_EXCEPTION').catch(() => process.exit(1));
});
