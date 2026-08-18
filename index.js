require('dotenv').config();
const express = require('express');
const cron = require('node-cron');

const { bot, registerHandlers } = require('./bot');
const { checkAndNotify } = require('./alerts');
const { pool, closePool } = require('./db');

const PORT = process.env.PORT || 3000;
const USE_POLLING = process.env.USE_POLLING === 'true';
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const app = express();
app.use(express.json());

registerHandlers();

if (!USE_POLLING) {
  app.post('/webhook', (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

app.get('/', (req, res) => {
  res.send('Rain alert bot (PostgreSQL) працює ✅');
});

// Health-check також перевіряє з'єднання з БД — корисно для UptimeRobot
// і для діагностики проблем з Supabase pooler.
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);

  if (!USE_POLLING && WEBHOOK_URL) {
    try {
      await bot.setWebHook(`${WEBHOOK_URL}/webhook`);
      console.log('Webhook встановлено:', `${WEBHOOK_URL}/webhook`);
    } catch (err) {
      console.error('Помилка встановлення webhook:', err.message);
    }
  } else if (USE_POLLING) {
    console.log('Бот працює в режимі polling (для локальної розробки)');
  }
});

cron.schedule('*/5 * * * *', () => {
  console.log('[cron] Перевірка погоди для всіх підписників...');
  checkAndNotify(bot);
});

checkAndNotify(bot);

async function shutdown(signal) {
  console.log(`${signal} отримано, завершення роботи...`);
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
