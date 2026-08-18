const TelegramBot = require('node-telegram-bot-api').TelegramBot;
const {
  upsertSubscriber,
  findSubscriber,
  removeSubscriber
} = require('./db');

const TOKEN = process.env.BOT_TOKEN;
const USE_POLLING = process.env.USE_POLLING === 'true';

const bot = new TelegramBot(TOKEN, { polling: USE_POLLING });

const mainKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '🔔 Підписатися на дощ' }],
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

function registerHandlers() {
  bot.on('message', async (msg) => {
    try {
      const chatId = msg.chat.id;
      const chatType = msg.chat.type; // 'private' | 'group' | 'supergroup' — збігається з ENUM у БД

      if (msg.location) {
        const { latitude, longitude } = msg.location;
        const latR = Math.round(latitude * 10000) / 10000;
        const lonR = Math.round(longitude * 10000) / 10000;
        await upsertSubscriber(chatId, chatType, latR, lonR);
        await bot.sendMessage(
          chatId,
          `📍 Локація збережена: ${latR}, ${lonR}\n\n✅ Підписка активна! Попереджу, коли наближатиметься дощ.`,
          mainKeyboard
        );
        return;
      }

      const text = msg.text;
      if (!text) return;

      if (text.startsWith('/start')) {
        await bot.sendMessage(
          chatId,
          'Привіт! Я попереджаю про наближення дощу заздалегідь. Натисніть кнопку підписки і надішліть геолокацію — і я скажу, коли брати парасольку.',
          mainKeyboard
        );
        return;
      }

      if (text === '🔔 Підписатися на дощ') {
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

      if (text === '🔕 Відписатися') {
        const removed = await removeSubscriber(chatId);
        await bot.sendMessage(
          chatId,
          removed ? '🔕 Підписку скасовано.' : 'ℹ️ Ви не були підписані.',
          mainKeyboard
        );
        return;
      }
    } catch (err) {
      console.error('Error in message handler:', err);
    }
  });
}

module.exports = { bot, registerHandlers };
