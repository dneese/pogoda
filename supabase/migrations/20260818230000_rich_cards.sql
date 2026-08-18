-- Прогноз-повідомлення (rich card): одне повідомлення на чат, яке
-- бот редагує у місці, коли прогноз змінюється. content_hash
-- дозволяє не редагувати без змін контенту (анти-спам «edited»).
CREATE TABLE IF NOT EXISTS chat_messages (
  chat_id      BIGINT PRIMARY KEY REFERENCES subscribers(chat_id) ON DELETE CASCADE,
  message_id   BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);