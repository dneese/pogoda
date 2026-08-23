# Rain Alert Bot — PostgreSQL/PostGIS (Supabase)

**[@RainNot_bot](https://t.me/RainNot_bot)** → [t.me/RainNot_bot](https://t.me/RainNot_bot)

Telegram-бот на Node.js, що попереджає про **небезпечні метеорологічні явища**
для збереженої геолокації. Використовує **PostgreSQL (Supabase) з PostGIS**:

- **`GEOGRAPHY(POINT, 4326)`** замість пари `lat`/`lon` float — правильний тип для координат на сфері.
- **GIST-індекс** на локацію — швидкий просторовий пошук.
- **KNN-оператор `<->`** та `ST_DWithin` — індексований пошук найближчих підписників
  (функція `findSubscribersNear`).
- **SQL-функція `cluster_subscribers()`** — кластеризація підписників по сітці ~12 км (0.11°)
  прямо в БД (`GROUP BY`), а не циклом у JS.
- **ENUM типи** (`chat_type_enum`, `alert_kind_enum`) — БД відхиляє некоректні значення.
- **UNIQUE constraint** на `(chat_id, alert_kind, event_start)` — дедублікація на рівні БД.
- **Batch-дедублікація** через `filter_unsent_subscribers()` / `mark_alerts_sent_batch()`
  — 2 SQL-запити на кластер замість N запитів на кожного підписника.
- **Тригер `set_updated_at()`** — автоматичне оновлення `updated_at`.
- **`forecast_cache` таблиця** — кеш прогнозів у БД (переживає рестарт/redeploy,
  спільний для кількох інстансів бота).
- **Connection pooling (`pg.Pool`)** — Supabase direct (5432) або pgbouncer (6543).

## Що нового у v2.2

- **Повний набір екстремальних явищ** (замість лише дощу): гроза, град,
  шквали, снігопад/хуртовина, ожеледиця (крижаний дощ), спека та мороз
  за відчуваюаною температурою, туман, високий УФ-індекс.
- **Рівні небезпеки за моделлю CAP/MeteoAlarm**: 🟡 жовтий / 🟠 оранжевий /
  🔴 червоний — з індивідуальними порогами для кожного явища (`WIND_*`, `RAIN_*`,
  `SNOW_*`, `HEAT_*`, `COLD_*`, `UV_*`).
- **Поради з безпеки в кожному сповіщенні** — що робити, а не лише що відбувається.
- **`/settings`** — індивідуальні налаштування через inline-клавіатуру:
  категорії явищ, мінімальний рівень небезпеки, тихі години (🔴 пробиває завжди).
- **Меню команд** (`setMyCommands`) + оновлені кнопки клавіатури.

## Що нового у v2.1

- **Команда `/weather`** («☔ Поточний прогноз») — свіжа прогноз-картка на запит, без очікування циклу.
- **`/help`, `/subscribe`, `/unsubscribe`** — повний набір команд + підказка на невідомі команди.
- **L1-кеш прогнозу в пам'яті** перед DB-кешем — менше round-trip'ів до Supabase.
- **Ретраї з backoff та таймаутом** для Open-Meteo (нативний `fetch`, залежність `node-fetch` прибрана).
- **Структурний логер** (`logger.js`) з рівнями (`LOG_LEVEL=debug|info|warn|error`).
- **`/metrics`** — лічильники runtime (fetch/кеш/помилки/розсилки) у JSON.
- **Розширений `/health`**: uptime, версія, кількість підписників (старі ключі збережені).
- **Секрет вебхуку** (`TELEGRAM_WEBHOOK_SECRET`, генерується автоматично) + перевірка заголовка Telegram.
- **Антифlood** — обмеження повідомлень з одного чату (`RATE_LIMIT_MSGS`).
- **Авточистка мертвих чатів**: заблокували бота → підписник видаляється, помилки не повторюються.
- **Захист від накладання cron-циклів**, `cleanupOldData()` раз на годину замість кожні 5 хв.
- **Fail-fast валідація конфігу** при старті; коректний graceful shutdown (зняття вебхуку, стоп polling).

## Команди бота

| Команда | Дія |
|---|---|
| `/start` | Привітання + клавіатура |
| `/weather` | Картка погоди для збереженої локації |
| `/settings` | Явища, рівень небезпеки, тихі години |
| `/help` | Список команд |
| `/subscribe` | Підписка (запит геолокації) |
| `/unsubscribe` | Скасувати підписку |

## Структура проєкту

```
rain-bot/
├── package.json
├── schema.sql          # виконати один раз у Supabase SQL Editor або через supabase db push
├── .env                # створи з .env.example
├── .gitignore
├── index.js            # Express-сервер, webhook, cron, /health, /metrics, graceful shutdown
├── bot.js              # Обробка команд і геолокації, антифlood
├── alerts.js           # Перевірка погоди й розсилка (batch-дедублікація)
├── weather.js          # Open-Meteo: нативний fetch + ретраї, L1+L2 кеші
├── db.js               # Увесь SQL: pool, upsert, KNN, кластеризація
├── logger.js           # Мінімалістичний структурний логер
└── stats.js            # Лічильники для /health та /metrics
```

## Налаштування Supabase

1. Створи проєкт на [supabase.com](https://supabase.com).
2. Застосуй схему одним зі способів:
   - **Supabase SQL Editor** → встав увесь вміст `schema.sql` → Run.
   - Або через **Supabase CLI**:
     ```bash
     supabase login
     supabase init
     supabase link --project-ref <project-ref>
     supabase db push
     ```
   PostGIS активується автоматично (`CREATE EXTENSION IF NOT EXISTS postgis`).
3. `DATABASE_URL` — з **Project Settings → Database → Connection string**
   (пряме з'єднання, порт 5432, або pooler Transaction mode, порт 6543).

## Локальний запуск

```bash
npm install
cp .env.example .env
# заповни BOT_TOKEN і DATABASE_URL
# для локального тесту USE_POLLING=true (без webhook і тунелю)
npm run dev
```

При `USE_POLLING=true` бот сам опитує Telegram, webhook/тунель не потрібен.

## Деплой на Render / Railway / Koyeb

1. Запуш репозиторій у GitHub.
2. Створи Web Service, команда старту: `npm start`.
3. Додай змінні середовища з `.env.example` (BOT_TOKEN, DATABASE_URL, WEBHOOK_URL,
   USE_POLLING=false).
4. При старті бот сам зареєструє webhook (`bot.setWebHook`).

⚠️ **Render free tier** засинає після ~15 хв без вхідних HTTP-запитів — це зіб'є регулярність
cron-перевірки. Тримай сервіс «теплим» через UptimeRobot-пінг на `/health` (він же перевіряє
з'єднання з Supabase), або обери Railway/Koyeb з always-on контейнером.

## Змінні середовища

| Змінна | Опис | Дефолт |
|---|---|---|
| `BOT_TOKEN` | Токен від @BotFather | — |
| `DATABASE_URL` | Supabase connection string | — |
| `PG_POOL_MAX` | Максимум з'єднань у пулі | `10` |
| `WEBHOOK_URL` | Публічний URL сервісу (без `/webhook`) | — |
| `USE_POLLING` | `true` локально, `false` у продакшені | `false` |
| `SOON_WINDOW_HOURS` | За скільки годин попереджати про дощ | `3` |
| `RAIN_THRESHOLD_MM` | Межа інтенсивності "справжнього" дощу (мм/год) | `0.3` |
| `TIMEZONE` | Часовий пояс для форматування часу | `Europe/Kyiv` |
| `CLUSTER_GRID_DEG` | Сітка кластеризації підписників (°) | `0.11` |
| `FORECAST_CACHE_TTL_MIN` | TTL кешу прогнозу в БД (хв) | `60` |
| `SEND_CONCURRENCY` | Паралельних воркерів розсилки | `10` |
| `LOG_LEVEL` | Рівень логування `debug/info/warn/error` | `info` |
| `TELEGRAM_WEBHOOK_SECRET` | Секрет перевірки вебхуку; порожньо = автогенерація | — |
| `OPEN_METEO_TIMEOUT_MS` | Таймаут запиту до Open-Meteo | `15000` |
| `OPEN_METEO_RETRIES` | Кількість ретраїв Open-Meteo | `2` |
| `RATE_LIMIT_MSGS` | Максимум повідомлень з чату за хвилину | `20` |
| `URGENT_WIND_MS` | Пориви вітру (м/с) для класу «ураган» | `25` |
