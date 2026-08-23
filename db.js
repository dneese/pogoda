const { Pool } = require('pg');
const log = require('./logger');

// Supabase pgbouncer (transaction pooling) — правильний режим для
// serverless/багатоінстансних деплоїв, не прямий порт 5432.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: parseInt(process.env.PG_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  log.error('Unexpected PG pool error:', err);
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// --- Підписники ---------------------------------------------------

async function upsertSubscriber(chatId, chatType, lat, lon) {
  const sql = `
    INSERT INTO subscribers (chat_id, chat_type, location)
    VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)
    ON CONFLICT (chat_id) DO UPDATE SET
      chat_type = EXCLUDED.chat_type,
      location = EXCLUDED.location
  `;
  // ST_MakePoint(lon, lat) — PostGIS очікує (X=lon, Y=lat), не навпаки
  await query(sql, [chatId, chatType, lon, lat]);
}

async function findSubscriber(chatId) {
  const sql = `
    SELECT
      chat_id,
      chat_type,
      ST_Y(location::geometry) AS lat,
      ST_X(location::geometry) AS lon,
      created_at,
      updated_at
    FROM subscribers
    WHERE chat_id = $1
  `;
  const { rows } = await query(sql, [chatId]);
  return rows[0] || null;
}

async function removeSubscriber(chatId) {
  const { rowCount } = await query('DELETE FROM subscribers WHERE chat_id = $1', [chatId]);
  return rowCount > 0;
}

// Для /health та /metrics
async function getSubscriberCount() {
  const { rows } = await query('SELECT count(*)::int AS n FROM subscribers');
  return rows[0] ? rows[0].n : 0;
}

// Кластеризація підписників по сітці ~12 км (0.11°, дефолт функції в БД).
// Груба сітка => менше унікальних кластерів => менше запитів до Open-Meteo
// (безкоштовний ліміт 10 000/добу), без відчутної втрати точності для дощу.
const CLUSTER_GRID_DEG = parseFloat(process.env.CLUSTER_GRID_DEG || '0.11');

async function getSubscriberClusters(gridDeg = CLUSTER_GRID_DEG) {
  const { rows } = await query('SELECT * FROM cluster_subscribers($1)', [gridDeg]);
  return rows; // [{ cluster_key, center_lat, center_lon, chat_ids: [...] }]
}

// KNN: підписники в радіусі N метрів від точки (для майбутніх фіч).
async function findSubscribersNear(lat, lon, radiusMeters = 5000) {
  const sql = `
    SELECT chat_id, chat_type,
           ST_Y(location::geometry) AS lat,
           ST_X(location::geometry) AS lon,
           ST_Distance(location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_m
    FROM subscribers
    WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)
    ORDER BY location <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
  `;
  const { rows } = await query(sql, [lat, lon, radiusMeters]);
  return rows;
}

// --- Сповіщення: BATCH-дедублікація замість циклу по одному chat_id ---
//
// Було (N запитів на N підписників кластера):
//   for (const chatId of chatIds) {
//     if (await wasAlertSent(chatId, kind, start)) continue;
//     ... sendMessage ...
//     await markAlertSent(chatId, kind, start, msgId);
//   }
//
// Стало (2 запити на ВЕСЬ кластер, незалежно від його розміру):
//   const toSend = await filterUnsentSubscribers(chatIds, kind, start);
//   ... sendMessage кожному з toSend ...
//   await markAlertsSentBatch(sentChatIds, kind, start);
//
// Це знижує кількість SQL-звернень з O(N) до O(1) на кластер і є
// головним важелем зниження навантаження на БД при мільйонах підписників.

async function filterUnsentSubscribers(chatIds, alertKind, eventStart) {
  if (!chatIds || chatIds.length === 0) return [];
  const sql = 'SELECT filter_unsent_subscribers($1, $2, $3) AS chat_ids';
  const { rows } = await query(sql, [chatIds, alertKind, eventStart]);
  return rows[0] && rows[0].chat_ids ? rows[0].chat_ids : [];
}

async function markAlertsSentBatch(chatIds, alertKind, eventStart) {
  if (!chatIds || chatIds.length === 0) return;
  await query('SELECT mark_alerts_sent_batch($1, $2, $3)', [chatIds, alertKind, eventStart]);
}

// --- Кеш прогнозів у БД (переживає рестарт/redeploy, спільний для
// усіх інстансів бота при горизонтальному масштабуванні) -----------

async function getCachedForecast(clusterKey, ttlMinutes = 60) {
  const entry = await getForecastEntry(clusterKey, ttlMinutes);
  return entry ? entry.payload : null;
}

// Кеш з метаданими: потрібно, щоб вирішити — чи «освіжати» прогноз
// біля події (точність часу старту важливіша за економію запитів).
async function getForecastEntry(clusterKey, ttlMinutes = 60) {
  const sql = `
    SELECT payload, fetched_at FROM forecast_cache
    WHERE cluster_key = $1 AND fetched_at > now() - ($2 || ' minutes')::interval
  `;
  const { rows } = await query(sql, [clusterKey, ttlMinutes]);
  return rows[0] || null;
}

async function setCachedForecast(clusterKey, lat, lon, payload) {
  const sql = `
    INSERT INTO forecast_cache (cluster_key, location, payload, fetched_at)
    VALUES ($1, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, $4, now())
    ON CONFLICT (cluster_key) DO UPDATE SET
      payload = EXCLUDED.payload,
      fetched_at = now()
  `;
  await query(sql, [clusterKey, lat, lon, JSON.stringify(payload)]);
}

async function cleanupOldData() {
  await query('SELECT cleanup_old_data()');
}

// --- Прогноз-повідомлення (rich card) ---------------------------------
// Одне повідомлення на чат, яке бот РЕДАГУЄ у місці, коли прогноз
// змінюється. content_hash дозволяє не редагувати без змін контенту.

async function getChatMessages(chatIds) {
  if (!chatIds || chatIds.length === 0) return [];
  const sql = `
    SELECT chat_id, message_id, content_hash
    FROM chat_messages
    WHERE chat_id = ANY($1)
  `;
  const { rows } = await query(sql, [chatIds]);
  return rows;
}

async function upsertChatMessage(chatId, messageId, contentHash) {
  const sql = `
    INSERT INTO chat_messages (chat_id, message_id, content_hash)
    VALUES ($1, $2, $3)
    ON CONFLICT (chat_id) DO UPDATE SET
      message_id = EXCLUDED.message_id,
      content_hash = EXCLUDED.content_hash,
      updated_at = now()
  `;
  await query(sql, [chatId, messageId, contentHash]);
}

async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  CLUSTER_GRID_DEG,
  upsertSubscriber,
  findSubscriber,
  removeSubscriber,
  getSubscriberCount,
  getSubscriberClusters,
  findSubscribersNear,
  filterUnsentSubscribers,
  markAlertsSentBatch,
  getCachedForecast,
  getForecastEntry,
  setCachedForecast,
  getChatMessages,
  upsertChatMessage,
  cleanupOldData,
  closePool
};
