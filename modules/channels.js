const db = require("../database/database")
const keyboards = require("../utils/keyboards")
const logger = require("../utils/logger")
const config = require("../config/config")

class ChannelManager {
  constructor(bot) {
    this.bot = bot
    this.userStates = new Map()
  }

  async handleAddChannel(chatId, userId) {
    this.userStates.set(userId, { action: "waiting_channel_username", chatId })

    await this.bot.sendMessage(
      chatId,
      "📝 Введите username канала (например: @darthmaxou):\n\n" +
        "⚠️ Убедитесь, что бот добавлен в канал как администратор!",
    )
  }

  async deleteChannel(chatId, channelId) {
    try {
      await db.deleteChannel(channelId);
      await this.bot.sendMessage(chatId, `✅ Канал с ID ${channelId} удалён`, keyboards.channelManagement);
    } catch (error) {
      logger.error("Error deleting channel:", error);
      await this.bot.sendMessage(chatId, `❌ Ошибка при удалении канала: ${error.message}`, keyboards.channelManagement);
    }
  }

  async processChannelUsername(msg) {
    try {
      const userId = msg.from.id
      const userState = this.userStates.get(userId)

      if (!userState || userState.action !== "waiting_channel_username") {
        return false
      }

      const username = msg.text.trim()

      if (!username.startsWith("@")) {
        await this.bot.sendMessage(
          msg.chat.id,
          "❌ Неверный формат! Username должен начинаться с @\n\nПример: @darthmaxou",
        )
        return true
      }

      const channelUsername = username.substring(1)

      try {
        const chat = await this.bot.getChat(`@${channelUsername}`)
        const botInfo = await this.bot.getMe()
        const chatMember = await this.bot.getChatMember(chat.id, botInfo.id)

        if (!["administrator", "creator"].includes(chatMember.status)) {
          await this.bot.sendMessage(
            msg.chat.id,
            "❌ Бот не является администратором в этом канале!\n\n" +
              "Добавьте бота в канал как администратора и попробуйте снова.",
          )
          return true
        }

        const userMember = await this.bot.getChatMember(chat.id, userId)

        if (!["administrator", "creator"].includes(userMember.status)) {
          await this.bot.sendMessage(
            msg.chat.id,
            "❌ Вы не являетесь администратором этого канала!\n\n" +
              "Только администраторы канала могут добавлять его в бота.",
          )
          return true
        }

        await db.addChannel(chat.id.toString(), username, chat.title, chat.type)

        const channelId = Math.abs(chat.id).toString()
        const suggestionLink = `https://t.me/${botInfo.username}?start=${channelId}_channel`

        await this.bot.sendMessage(
          msg.chat.id,
          `✅ Канал успешно добавлен!\n\n` +
            `📍 Название: ${chat.title}\n` +
            `🔗 Username: ${username}\n` +
            `🆔 ID: ${chat.id}\n\n` +
            `📝 Ссылка для предложений:\n` +
            `${suggestionLink}\n\n` +
            `Пользователи могут отправлять предложения по этой ссылке.\n` +
            `Теперь вы можете настроить модерацию и другие функции для этого канала.`,
          {
            ...keyboards.channelManagement,
          },
        )

        logger.info(`Channel ${username} (${chat.id}) added by user ${userId}`)
      } catch (error) {
        if (error.response) {

          if (error.response.statusCode === 400) {
            await this.bot.sendMessage(
              msg.chat.id,
              "❌ Канал не найден!\n\n" +
                "Возможные причины:\n" +
                "• Неправильный username канала\n" +
                "• Канал приватный и бот не добавлен\n" +
                "• Канал не существует\n\n" +
                `Проверьте username: ${username}`,
            )
          } else if (error.response.statusCode === 403) {
            await this.bot.sendMessage(
              msg.chat.id,
              "❌ Нет доступа к каналу!\n\n" +
                "Убедитесь, что:\n" +
                "• Канал публичный или бот добавлен в него\n" +
                "• Бот имеет права администратора\n" +
                "• Username указан правильно",
            )
          } else {
            await this.bot.sendMessage(
              msg.chat.id,
              `❌ Ошибка API: ${error.response.statusCode}\n\n` + "Попробуйте еще раз или обратитесь к администратору.",
            )
          }
        } else if (error.code === "ETELEGRAM") {
          await this.bot.sendMessage(
            msg.chat.id,
            "❌ Ошиб��а Telegram API!\n\n" +
              "Возможные причины:\n" +
              "• Канал не найден\n" +
              "• Нет доступа к каналу\n" +
              "• Бот не добавлен в канал\n\n" +
              "Проверьте настройки канала и попробуйте снова.",
          )
        } else {
          throw error
        }
      }

      this.userStates.delete(userId)
      return true
    } catch (error) {
      logger.error("Error processing channel username:", error)
      await this.bot.sendMessage(
        msg.chat.id,
        `❌ Произошла неожиданная ошибка: ${error.message}\n\nПопробуйте позже или обратитесь к администратору.`,
      )
      const userId = msg.from.id
      this.userStates.delete(userId)
      return true
    }
  }

  async listChannels(chatId) {
    try {
      const channels = await db.getChannels()

      if (channels.length === 0) {
        await this.bot.sendMessage(
          chatId,
          '📋 Каналы не добавлены\n\nИспользуйте кнопку "Добавить канал" для добавления.',
          keyboards.channelManagement
        )
        return
      }

      let message = "📋 Список каналов:\n\n"
      channels.forEach((channel, index) => {
        const title = channel.title || channel.username
        const username = channel.username || ''
        const chatIdStr = Math.abs(Number(channel.chat_id))

        message += `${index + 1}. ${title}\n`
        message += `   🔗 ${username}\n`
        message += `   🆔 ${chatIdStr}\n`
        message += `   📨 Предложка: https://t.me/${config.botName}?start=${chatIdStr}_channel\n\n`
      })

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            ...channels.map((channel) => [
              { text: `🗑️ Удалить ${channel.title || channel.username}`, callback_data: `delete_${channel.id}` }
            ]),
            [{ text: "🔙 Назад", callback_data: "admin_channels" }]
          ]
        }
      }

      await this.bot.sendMessage(chatId, message, keyboard)

    } catch (error) {
      logger.error("Error listing channels:", error)
      await this.bot.sendMessage(chatId, "❌ Ошибка при получении списка каналов", keyboards.backToMain)
    }
  }

  async showChannelSettings(chatId) {
    try {
      const channels = await db.getChannels()

      if (channels.length === 0) {
        await this.bot.sendMessage(
          chatId,
          "📋 Каналы не добавлены\n\nСначала добавьте каналы.",
          keyboards.channelManagement,
        )
        return
      }

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            ...channels.map((channel) => [
              {
                text: `⚙️ ${channel.title || channel.username}`,
                callback_data: `settings_${channel.id}`,
              },
              {
                text: `🗑️ Удалить`,
                callback_data: `delete_${channel.id}`,
              }
            ]),
            [{ text: "🔙 Назад", callback_data: "admin_channels" }],
          ],
        },
      }

      await this.bot.sendMessage(chatId, "⚙️ Выберите канал для настройки:", keyboard)
    } catch (error) {
      logger.error("Error showing channel settings:", error)
    }
  }

  isProcessingMessage(userId) {
    return this.userStates.has(userId)
  }
}

module.exports = ChannelManager
