const TelegramBot = require('node-telegram-bot-api').TelegramBot;
const {
  upsertSubscriber,
  findSubscriber,
  removeSubscriber,
  getUserSettings,
  upsertUserSettings
} = require('./db');
const { getForecast, analyzeForecast } = require('./weather');
const { getRadarAnalysis } = require('./radar');
const { buildCardContent, KIND_META } = require('./alerts');
const log = require('./logger');

const TOKEN = process.env.BOT_TOKEN;
const USE_POLLING = process.env.USE_POLLING === 'true';

const bot = new TelegramBot(TOKEN, { polling: USE_POLLING });

// Примітивний антифlood: не більше RATE_LIMIT_MSGS повідомлень на хвилину з чату.
const RATE_LIMIT_MSGS = parseInt(process.env.RATE_LIMIT_MSGS || '20', 10);
const recentMsgs = new Map(); // chatId -> [timestampMs]
function allowMessage(chatId) {
  const now = Date.now();
  const arr = (recentMsgs.get(chatId) || []).filter((t) => now - t < 60000);
  if (arr.length >= RATE_LIMIT_MSGS) {
    recentMsgs.set(chatId, arr);
    return false;
  }
  arr.push(now);
  recentMsgs.set(chatId, arr);
  return true;
}

// --- Налаштування: довідники для UI -----------------------------------

const CATEGORIES = [
  { key: 'precip', label: '🌧 Опади (дощ/сніг/ожеледиця)' },
  { key: 'storm',  label: '⛈ Гроза та град' },
  { key: 'wind',   label: '💨 Сильний вітер' },
  { key: 'temp',   label: '🌡 Спека / мороз' },
  { key: 'other',  label: '🌫 Туман / УФ-індекс' }
];

const MIN_SEVERITY_CYCLE = [1, 2, 3];
const MIN_SEVERITY_LABEL = {
  1: '🟡 усі рівні небезпеки',
  2: '🟠 оранжевий і червоний',
  3: '🔴 лише червоний'
};

// Пресети тихих годин у порядку циклу кнопки; після останнього — вимкнено
const QUIET_PRESETS = [
  { start: 23, end: 7 },
  { start: 22, end: 8 },
  { start: 0,  end: 6 }
];

function hh(h) {
  return `${String(h).padStart(2, '0')}:00`;
}

// --- Клавіатури -------------------------------------------------------

const mainKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '☔ Погода зараз' }, { text: '⚙️ Налаштування' }],
      [{ text: '🔔 Підписатися на сповіщення' }, { text: '🔕 Відписатися' }]
    ],
    resize_keyboard: true
  }
};

const locationKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '📍 Надіслати мою геолокацію', request_location: true }],
      [{ text: '🔕 Відписатися' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  }
};

// Меню команд (кнопка ≡ у чаті). Реєструється один раз при старті.
function setupCommands() {
  bot.setMyCommands([
    { command: 'weather',    description: '☔ Погода зараз' },
    { command: 'subscribe',  description: '🔔 Підписатися на сповіщення' },
    { command: 'unsubscribe',description: '🔕 Відписатися' },
    { command: 'settings',   description: '⚙️ Налаштування сповіщень' },
    { command: 'help',       description: 'ℹ️ Довідка' }
  ]).catch((err) => log.warn('setMyCommands failed:', err.message));
}

// --- /settings --------------------------------------------------------

function settingsText(s) {
  const catsOn = s.cats.join(', ');
  const quiet = s.quiet_enabled
    ? `🌙 увімкнені (${hh(s.quiet_start)}–${hh(s.quiet_end)}, 🔴 проходять завжди)`
    : 'вимкнені';
  return (
    '*⚙️ Налаштування сповіщень*\n\n' +
    `Рівень попереджень: ${MIN_SEVERITY_LABEL[s.min_severity]}\n` +
    `Категорії явищ: ${catsOn}\n` +
    `Тихі години: ${quiet}`
  );
}

function settingsKeyboard(s) {
  const inline = {
    inline_keyboard: [
      ...CATEGORIES.map((c) => ([{
        text: `${c.label} ${s.cats.includes(c.key) ? '✅' : '❌'}`,
        callback_data: `cat:${c.key}`
      }])),
      [{
        text: `Рівень: ${MIN_SEVERITY_LABEL[s.min_severity]}`,
        callback_data: 'minsev'
      }],
      [{
        text: s.quiet_enabled
          ? `🌙 Тихі години: ${hh(s.quiet_start)}–${hh(s.quiet_end)}`
          : '🌙 Тихі години: вимкнені',
        callback_data: 'quiet'
      }]
    ]
  };
  return { reply_markup: inline };
}

async function showSettings(chatId) {
  const sub = await findSubscriber(chatId);
  if (!sub) {
    await bot.sendMessage(
      chatId,
      'Спочатку збережіть локацію 📍 — натисніть «🔔 Підписатися на сповіщення».',
      locationKeyboard
    );
    return;
  }
  const s = await getUserSettings(chatId);
  await bot.sendMessage(chatId, settingsText(s), settingsKeyboard(s));
}

// Застосовує зміну з inline-кнопки й повертає оновлені налаштування
async function applySettingToggle(chatId, data) {
  const s = await getUserSettings(chatId);

  if (data === 'minsev') {
    const idx = MIN_SEVERITY_CYCLE.indexOf(s.min_severity);
    const next = MIN_SEVERITY_CYCLE[(idx + 1) % MIN_SEVERITY_CYCLE.length];
    return upsertUserSettings(chatId, { min_severity: next });
  }

  if (data === 'quiet') {
    if (!s.quiet_enabled) {
      // перший дозвін — типовий нічний пресет 23–7
      return upsertUserSettings(chatId, { quiet_enabled: true });
    }
    // шукаємо поточний пресет у циклі; наступний за ним або вимикання
    const idx = QUIET_PRESETS.findIndex(
      (p) => p.start === s.quiet_start && p.end === s.quiet_end
    );
    if (idx === -1 || idx === QUIET_PRESETS.length - 1) {
      return upsertUserSettings(chatId, { quiet_enabled: false });
    }
    return upsertUserSettings(chatId, QUIET_PRESETS[idx + 1]);
  }

  if (data.startsWith('cat:')) {
    const key = data.slice(4);
    const cats = s.cats.includes(key)
      ? s.cats.filter((c) => c !== key)
      : [...s.cats, key];
    if (cats.length === 0) {
      // не даємо вимкнути все — інакше бот мовчатиме назавжди
      return null;
    }
    return upsertUserSettings(chatId, { cats });
  }

  return null;
}

// --- Картка погоди ----------------------------------------------------

async function sendWeatherCard(chatId) {
  const sub = await findSubscriber(chatId);
  if (!sub) {
    await bot.sendMessage(
      chatId,
      'Спочатку збережіть локацію 📍 — натисніть «🔔 Підписатися на сповіщення».',
      locationKeyboard
    );
    return;
  }

  const forecast = await getForecast(sub.lat, sub.lon);
  if (!forecast) {
    await bot.sendMessage(chatId, '😵 Сервіс прогнозу зараз недоступний, спробуйте за хвилину.');
    return;
  }

  let radarData = null;
  try {
    radarData = await getRadarAnalysis(sub.lat, sub.lon, forecast);
  } catch (_) { /* радар опціональний */ }

  const analysis = analyzeForecast(forecast, { radarData });
  const markdown = buildCardContent(analysis);
  await bot.sendRichMessage(chatId, { markdown });
}

// --- Реєстрація обробників --------------------------------------------

function registerHandlers() {
  setupCommands();

  bot.on('message', async (msg) => {
    try {
      const chatId = msg.chat.id;
      const chatType = msg.chat.type; // 'private' | 'group' | 'supergroup' — збігається з ENUM у БД

      if (!allowMessage(chatId)) return;

      if (msg.location) {
        const { latitude, longitude } = msg.location;
        const latR = Math.round(latitude * 10000) / 10000;
        const lonR = Math.round(longitude * 10000) / 10000;
        await upsertSubscriber(chatId, chatType, latR, lonR);
        await bot.sendMessage(
          chatId,
          `📍 Локація збережена: ${latR}, ${lonR}\n\n✅ Підписка активна! Попереджатиму про дощ, грози, шквали, ожеледицю, спеку та інші небезпечні явища.\n\nСпробуйте «☔ Погода зараз» — покажу картку одразу.`,
          mainKeyboard
        );
        return;
      }

      const text = msg.text;
      if (!text) return;
      const command = text.split('@')[0]; // /weather@RainNot_bot → /weather

      if (command.startsWith('/start')) {
        await bot.sendMessage(
          chatId,
          'Привіт! Я попереджаю про небезпечні погодні явища заздалегідь:\n\n' +
          '🌧 дощ і зливи · ⛈ грози · 🌨 град · 💨 шквали\n' +
          '🧊 ожеледиця · ❄️ снігопади · 🌡 спека й мороз\n\n' +
          '• Натисніть «🔔 Підписатися на сповіщення» і надішліть геолокацію\n' +
          '• «☔ Погода зараз» — свіжа картка одразу\n' +
          '• За 3 години до події надішлю точне попередження\n' +
          '• «⚙️ Налаштування» — виберіть явища, рівень тривоги й тихі години',
          mainKeyboard
        );
        return;
      }

      if (command === '/help') {
        await bot.sendMessage(
          chatId,
          '/start — почати роботу\n' +
          '/weather — погода зараз для збереженої локації\n' +
          '/subscribe — підписатися на сповіщення\n' +
          '/unsubscribe — скасувати підписку\n' +
          '/settings — явища, рівні небезпеки, тихі години\n\n' +
          'Рівні небезпеки (як в офіційних попередженнях):\n' +
          '🟡 жовтий — будьте уважні\n' +
          '🟠 оранжевий — небезпечно\n' +
          '🔴 червоний — надзвичайна небезпека (завжди пробиває тихі години)\n\n' +
          'Або користуйтесь кнопками клавіатури.'
        );
        return;
      }

      if (command === '/settings' || text === '⚙️ Налаштування') {
        await showSettings(chatId);
        return;
      }

      if (command === '/weather' || text === '☔ Погода зараз' ||
          text === '☔ Поточний прогноз') { // сумісність зі старою кнопкою
        await sendWeatherCard(chatId);
        return;
      }

      if (command === '/subscribe' || text === '🔔 Підписатися на сповіщення' ||
          text === '🔔 Підписатися на дощ') {
        const sub = await findSubscriber(chatId);
        if (sub) {
          await bot.sendMessage(
            chatId,
            `✅ Підписка вже активна (${sub.lat.toFixed(4)}, ${sub.lon.toFixed(4)}). Щоб змінити місце — надішліть нову геолокацію.`,
            mainKeyboard
          );
          return;
        }
        await bot.sendMessage(
          chatId,
          'Надішліть вашу геолокацію 📍 — і я попереджатиму про небезпечні явища саме для цього місця.',
          locationKeyboard
        );
        return;
      }

      if (command === '/unsubscribe' || text === '🔕 Відписатися') {
        const removed = await removeSubscriber(chatId);
        await bot.sendMessage(
          chatId,
          removed ? '🔕 Підписку скасовано.' : 'ℹ️ Ви не були підписані.',
          mainKeyboard
        );
        return;
      }

      // Невідомі команди — м'яка підказка; звичайний текст ігноруємо.
      if (text.startsWith('/')) {
        await bot.sendMessage(chatId, 'Не знаю такої команди. Спробуйте /help');
      }
    } catch (err) {
      log.error('Error in message handler:', err);
      try {
        await bot.sendMessage(msg.chat.id, '😅 Щось пішло не так. Спробуйте ще раз за хвилину.');
      } catch (_) { /* чат недоступний — ігноруємо */ }
    }
  });

  // Inline-кнопки /settings
  bot.on('callback_query', async (q) => {
    const chatId = q.message && q.message.chat && q.message.chat.id;
    const data = q.data;
    if (!chatId || !data) {
      try { await bot.answerCallbackQuery(q.id); } catch (_) {}
      return;
    }
    try {
      if (!allowMessage(chatId)) {
        await bot.answerCallbackQuery(q.id, { text: 'Занадто часто, зачекайте хвилину' });
        return;
      }
      const updated = await applySettingToggle(chatId, data);
      if (!updated) {
        await bot.answerCallbackQuery(q.id, { text: 'Хоча б одна категорія має бути ввімкнена' });
        return;
      }
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, settingsText(updated), settingsKeyboard(updated));
    } catch (err) {
      log.error('Error in callback handler:', err);
      try { await bot.answerCallbackQuery(q.id, { text: 'Помилка, спробуйте ще раз' }); } catch (_) {}
    }
  });
}

module.exports = { bot, registerHandlers };
