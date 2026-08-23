-- =============================================================
-- Rain Alert Bot — схема PostgreSQL (Supabase)
-- PostGIS для геопросторових запитів, ENUM-типи, batch-дедублікація
-- сповіщень через масиви chat_id (замінює цикл по одному підписнику).
-- Сітка кластеризації укрупнена до ~12 км (0.11°) — компромісна точність
-- прогнозу, що різко зменшує кількість унікальних запитів до Open-Meteo.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS postgis;

DO $$ BEGIN
  CREATE TYPE chat_type_enum AS ENUM ('private', 'group', 'supergroup');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE alert_kind_enum AS ENUM ('rain', 'thunder', 'urgent');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------
-- Підписники: GEOGRAPHY(POINT, 4326) + GIST-індекс для KNN-пошуку
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscribers (
  chat_id      BIGINT PRIMARY KEY,
  chat_type    chat_type_enum NOT NULL DEFAULT 'private',
  location     GEOGRAPHY(POINT, 4326) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscribers_location
  ON subscribers USING GIST (location);

-- ---------------------------------------------------------------
-- Історія надісланих сповіщень. UNIQUE constraint лишається як
-- гарантія на рівні БД, але тепер додатково є індекс під
-- batch-вибірку "хто з цього масиву chat_id вже отримав alert_key".
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sent_alerts (
  id           BIGSERIAL PRIMARY KEY,
  chat_id      BIGINT NOT NULL REFERENCES subscribers(chat_id) ON DELETE CASCADE,
  alert_kind   alert_kind_enum NOT NULL,
  event_start  TIMESTAMPTZ NOT NULL,
  message_id   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, alert_kind, event_start)
);

-- Композитний індекс саме під batch-запит: WHERE chat_id = ANY($1)
-- AND alert_kind = $2 AND event_start = $3 — покриває фільтр повністю.
CREATE INDEX IF NOT EXISTS idx_sent_alerts_lookup
  ON sent_alerts (alert_kind, event_start, chat_id);

CREATE INDEX IF NOT EXISTS idx_sent_alerts_created ON sent_alerts (created_at);

-- ---------------------------------------------------------------
-- Кеш прогнозів по кластерах локацій
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forecast_cache (
  cluster_key   TEXT PRIMARY KEY,
  location      GEOGRAPHY(POINT, 4326) NOT NULL,
  payload       JSONB NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forecast_cache_fetched ON forecast_cache (fetched_at);

-- ---------------------------------------------------------------
-- Прогноз-повідомлення (rich card): одне повідомлення на чат, яке
-- бот редагує у місці, коли прогноз змінюється. content_hash
-- дозволяє не редагувати без змін контенту (анти-спам «edited»).
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
  chat_id      BIGINT PRIMARY KEY REFERENCES subscribers(chat_id) ON DELETE CASCADE,
  message_id   BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Тригер автооновлення updated_at
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_subscribers_updated_at ON subscribers;
CREATE TRIGGER trg_subscribers_updated_at
  BEFORE UPDATE ON subscribers
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------
-- Кластеризація підписників по сітці ~12 км (0.11°, дефолт).
-- Груба сітка => менше унікальних кластерів => менше запитів до
-- Open-Meteo (безкоштовний ліміт 10 000/добу) при мінімальній
-- втраті точності прогнозу для локального дощу.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION cluster_subscribers(grid_deg NUMERIC DEFAULT 0.11)
RETURNS TABLE (
  cluster_key TEXT,
  center_lat  DOUBLE PRECISION,
  center_lon  DOUBLE PRECISION,
  chat_ids    BIGINT[]
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (floor(ST_Y(location::geometry) / grid_deg) * grid_deg)::TEXT || '_' ||
      (floor(ST_X(location::geometry) / grid_deg) * grid_deg)::TEXT AS cluster_key,
    avg(ST_Y(location::geometry)) AS center_lat,
    avg(ST_X(location::geometry)) AS center_lon,
    array_agg(chat_id) AS chat_ids
  FROM subscribers
  GROUP BY 1;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------
-- BATCH-дедублікація: повертає підмножину chat_ids з переданого
-- масиву, яким подія alert_kind/event_start ЩЕ НЕ надсилалась.
-- Один запит на весь кластер замість N запитів на кожного підписника.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION filter_unsent_subscribers(
  p_chat_ids BIGINT[],
  p_alert_kind alert_kind_enum,
  p_event_start TIMESTAMPTZ
)
RETURNS BIGINT[] AS $$
DECLARE
  result BIGINT[];
BEGIN
  SELECT array_agg(cid) INTO result
  FROM unnest(p_chat_ids) AS cid
  WHERE cid NOT IN (
    SELECT chat_id FROM sent_alerts
    WHERE alert_kind = p_alert_kind
      AND event_start = p_event_start
      AND chat_id = ANY(p_chat_ids)
  );
  RETURN COALESCE(result, ARRAY[]::BIGINT[]);
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------
-- BATCH-запис: одним INSERT позначає всіх переданих chat_id як
-- "сповіщення надіслано" для конкретної події. ON CONFLICT DO NOTHING
-- зберігає ідемпотентність навіть при паралельних запусках.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_alerts_sent_batch(
  p_chat_ids BIGINT[],
  p_alert_kind alert_kind_enum,
  p_event_start TIMESTAMPTZ
)
RETURNS void AS $$
BEGIN
  INSERT INTO sent_alerts (chat_id, alert_kind, event_start)
  SELECT cid, p_alert_kind, p_event_start
  FROM unnest(p_chat_ids) AS cid
  ON CONFLICT (chat_id, alert_kind, event_start) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------
-- Автоочистка старих сповіщень і кешу прогнозів
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION cleanup_old_data()
RETURNS void AS $$
BEGIN
  DELETE FROM sent_alerts WHERE created_at < now() - INTERVAL '2 days';
  DELETE FROM forecast_cache WHERE fetched_at < now() - INTERVAL '2 hours';
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- v2.2 — Severe weather: розширення ENUM явищ + налаштування
-- користувача (категорії, рівень небезпеки, тихі години).
-- =============================================================

ALTER TYPE alert_kind_enum ADD VALUE IF NOT EXISTS 'hail';
ALTER TYPE alert_kind_enum ADD VALUE IF NOT EXISTS 'wind';
ALTER TYPE alert_kind_enum ADD VALUE IF NOT EXISTS 'snow';
ALTER TYPE alert_kind_enum ADD VALUE IF NOT EXISTS 'ice';
ALTER TYPE alert_kind_enum ADD VALUE IF NOT EXISTS 'heat';
ALTER TYPE alert_kind_enum ADD VALUE IF NOT EXISTS 'cold';
ALTER TYPE alert_kind_enum ADD VALUE IF NOT EXISTS 'fog';
ALTER TYPE alert_kind_enum ADD VALUE IF NOT EXISTS 'uv';

CREATE TABLE IF NOT EXISTS user_settings (
  chat_id       BIGINT PRIMARY KEY REFERENCES subscribers(chat_id) ON DELETE CASCADE,
  min_severity  SMALLINT NOT NULL DEFAULT 1 CHECK (min_severity BETWEEN 1 AND 3),
  quiet_enabled BOOLEAN  NOT NULL DEFAULT false,
  quiet_start   SMALLINT NOT NULL DEFAULT 23 CHECK (quiet_start BETWEEN 0 AND 23),
  quiet_end     SMALLINT NOT NULL DEFAULT 7  CHECK (quiet_end BETWEEN 0 AND 23),
  cats          TEXT[]   NOT NULL DEFAULT '{precip,storm,wind,temp,other}',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_user_settings_updated_at ON user_settings;
CREATE TRIGGER trg_user_settings_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
