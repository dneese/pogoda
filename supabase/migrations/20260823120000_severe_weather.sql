-- =============================================================
-- v2.2 — Severe weather: рівні небезпеки (CAP/MeteoAlarm) та
-- індивідуальні налаштування сповіщень.
--
-- 1) Розширюємо ENUM видів явищ: дощ/гроза/ураган → повний набір
--    (град, вітер, сніг, ожеледиця, спека, мороз, туман, УФ).
--    'urgent' лишається для зворотної сумісності старих записів
--    sent_alerts (новий код його не створює).
-- 2) user_settings — категорії явищ, мінімальний рівень небезпеки,
--    тихі години. Дефолти в коді; у БД лише явні зміни.
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
