const TelegramBot = require('node-telegram-bot-api').TelegramBot;
const {
  upsertSubscriber,
  findSubscriber,
  removeSubscriber
} = require('./db');
const { getForecast, analyzeForecast } = require('./weather');
const { buildCardContent } = require('./alerts');
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

const mainKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '🔔 Підписатися на дощ' }, { text: '☔ Поточний прогноз' }],
      [{ text: '🔕 Відписатися' }]
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

async function sendWeatherCard(chatId) {
  const sub = await findSubscriber(chatId);
  if (!sub) {
    await bot.sendMessage(
      chatId,
      'Спочатку збережіть локацію 📍 — натисніть «🔔 Підписатися на дощ».',
      locationKeyboard
    );
    return;
  }

  const forecast = await getForecast(sub.lat, sub.lon);
  if (!forecast) {
    await bot.sendMessage(chatId, '😵 Сервіс прогнозу зараз недоступний, спробуйте за хвилину.');
    return;
  }

  const analysis = analyzeForecast(forecast);
  const markdown = buildCardContent(analysis);
  await bot.sendRichMessage(chatId, { markdown });
}

function registerHandlers() {
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
          `📍 Локація збережена: ${latR}, ${lonR}\n\n✅ Підписка активна! Попереджу, коли наближатиметься дощ.\n\nСпробуйте «☔ Поточний прогноз» — покажу картку одразу.`,
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
          'Привіт! Я попереджаю про наближення дощу, грози та шквалів заздалегідь.\n\n' +
          '• Натисніть «🔔 Підписатися на дощ» і надішліть геолокацію\n' +
          '• «☔ Поточний прогноз» — свіжa картка погоди одразу\n' +
          '• За 3 години до дощу надішлю точне попередження',
          mainKeyboard
        );
        return;
      }

      if (command === '/help') {
        await bot.sendMessage(
          chatId,
          '/start — почати роботу\n' +
          '/weather — поточний прогноз для збереженої локації\n' +
          '/subscribe — підписатися на попередження про дощ\n' +
          '/unsubscribe — скасувати підписку\n\n' +
          'Або користуйтесь кнопками клавіатури.'
        );
        return;
      }

      if (command === '/weather' || text === '☔ Поточний прогноз') {
        await sendWeatherCard(chatId);
        return;
      }

      if (command === '/subscribe' || text === '🔔 Підписатися на дощ') {
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
          'Надішліть вашу геолокацію 📍 — і я попереджатиму про дощ саме для цього місця.',
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
}

module.exports = { bot, registerHandlers };
