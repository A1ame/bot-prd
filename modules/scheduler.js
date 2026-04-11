const db = require("../database/database")
const keyboards = require("../utils/keyboards")
const logger = require("../utils/logger")
const config = require("../config/config")

class SchedulerManager {
  constructor(bot) {
    this.bot = bot
    this.userStates = new Map()
    this.scheduledJobs = new Map()
    this.mediaGroupCache = new Map()

    setInterval(() => this.checkScheduledMessages(), 60000)
  }

  async handleCreateScheduled(chatId, userId) {
    this.userStates.set(userId, {
      action: "waiting_message_to_schedule",
      chatId: chatId,
    })

    await this.bot.sendMessage(
      chatId,
      "📝 *Создание отложенного сообщения*\n\n" +
        "Отправьте сообщение, которое нужно запланировать (текст, фото, видео и т.д.)",
      { parse_mode: "Markdown" },
    )
  }

  async processScheduledMessage(msg) {
    try {
      const userId = msg.from.id
      const userState = this.userStates.get(userId)

      if (!userState) return false

      if (msg.media_group_id) {
        if (!this.mediaGroupCache.has(msg.media_group_id)) {
          this.mediaGroupCache.set(msg.media_group_id, { 
            userId, 
            messages: [],
            timestamp: Date.now()
          })
          
          setTimeout(async () => {
            const groupData = this.mediaGroupCache.get(msg.media_group_id)
            if (!groupData) return
            
            await this._processMediaGroupSchedule(groupData)
            this.mediaGroupCache.delete(msg.media_group_id)
          }, 1500)
        }
        
        this.mediaGroupCache.get(msg.media_group_id).messages.push(msg)
        return true
      }

      if (userState.action === "waiting_message_to_schedule") {
        userState.messageId = msg.message_id
        userState.mediaGroupId = null
        userState.allMessageIds = [msg.message_id]
        
        userState.mediaFiles = [{
          type: this._getContentType(msg),
          file_id: this._getFileId(msg),
          caption: msg.caption || msg.text || null
        }]
        
        userState.action = "waiting_schedule_time"

        await this.bot.sendMessage(
          msg.chat.id,
          "⏰ *Когда отправить сообщение?*\n\n" +
            "Введите дату и время в формате:\n" +
            "• `2024-12-25 15:30` (дата время)\n" +
            "• `завтра 10:00`\n" +
            "• `через 2 часа`\n" +
            "• `понедельник 9:00`",
          { parse_mode: "Markdown" },
        )
        return true
      } else if (userState.action === "waiting_schedule_time") {
        const scheduleTime = this.parseScheduleTime(msg.text)

        if (!scheduleTime) {
          await this.bot.sendMessage(
            msg.chat.id,
            "❌ Неверный формат времени. Попробуйте еще раз.\n\n" +
              "Примеры: `2024-12-25 15:30`, `завтра 10:00`, `через 2 часа`",
            { parse_mode: "Markdown" },
          )
          return true
        }

        userState.scheduleTime = scheduleTime
        userState.action = "waiting_target_channels"

        const channels = await db.getChannels()
        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📢 Все каналы", callback_data: "schedule_all_channels" }],
              ...channels.map((channel) => [
                {
                  text: `📍 ${channel.title || channel.username}`,
                  callback_data: `schedule_channel_${channel.id}`,
                },
              ]),
              [{ text: "❌ Отмена", callback_data: "admin_scheduled" }],
            ],
          },
        }

        await this.bot.sendMessage(msg.chat.id, "📍 *Выберите каналы для публикации:*", {
          parse_mode: "Markdown",
          ...keyboard,
        })
        return true
      }

      return false
    } catch (error) {
      logger.error("Error processing scheduled message:", error)
      return false
    }
  }

  async _processMediaGroupSchedule(groupData) {
    try {
      const { userId, messages } = groupData
      const userState = this.userStates.get(userId)
      
      if (!userState) return

      userState.messageId = messages[0].message_id
      userState.mediaGroupId = messages[0].media_group_id
      userState.allMessageIds = messages.map(m => m.message_id)
      
      userState.mediaFiles = messages.map(m => {
        if (m.photo) return { 
          type: "photo", 
          file_id: m.photo[m.photo.length - 1].file_id, 
          caption: m.caption || null 
        }
        if (m.video) return { 
          type: "video", 
          file_id: m.video.file_id, 
          caption: m.caption || null 
        }
        if (m.document) return { 
          type: "document", 
          file_id: m.document.file_id, 
          caption: m.caption || null 
        }
        return null
      }).filter(Boolean)

      userState.action = "waiting_schedule_time"

      await this.bot.sendMessage(
        messages[0].chat.id,
        "⏰ *Когда отправить сообщение?*\n\n" +
          "Введите дату и время в формате:\n" +
          "• `2024-12-25 15:30` (дата время)\n" +
          "• `завтра 10:00`\n" +
          "• `через 2 часа`\n" +
          "• `понедельник 9:00`",
        { parse_mode: "Markdown" },
      )
    } catch (error) {
      logger.error("Error processing media group schedule:", error)
    }
  }

  _getContentType(msg) {
    if (msg.photo) return "photo"
    if (msg.video) return "video"
    if (msg.document) return "document"
    if (msg.audio) return "audio"
    return "text"
  }

  _getFileId(msg) {
    if (msg.photo) return msg.photo[msg.photo.length - 1].file_id
    if (msg.video) return msg.video.file_id
    if (msg.document) return msg.document.file_id
    if (msg.audio) return msg.audio.file_id
    return null
  }

  parseScheduleTime(timeString) {
    const now = new Date()
    const text = timeString.toLowerCase().trim()

    const dateTimeMatch = text.match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/)
    if (dateTimeMatch) {
      const [, date, hours, minutes] = dateTimeMatch
      return new Date(`${date}T${hours.padStart(2, "0")}:${minutes}:00`)
    }

    if (text.includes("завтра")) {
      const timeMatch = text.match(/(\d{1,2}):(\d{2})/)
      if (timeMatch) {
        const tomorrow = new Date(now)
        tomorrow.setDate(tomorrow.getDate() + 1)
        tomorrow.setHours(Number.parseInt(timeMatch[1]), Number.parseInt(timeMatch[2]), 0, 0)
        return tomorrow
      }
    }

    const relativeMatch = text.match(/через\s+(\d+)\s+(час|часа|часов|минут|минуты|минуту)/)
    if (relativeMatch) {
      const [, amount, unit] = relativeMatch
      const future = new Date(now)

      if (unit.includes("час")) {
        future.setHours(future.getHours() + Number.parseInt(amount))
      } else if (unit.includes("минут")) {
        future.setMinutes(future.getMinutes() + Number.parseInt(amount))
      }

      return future
    }

    return null
  }

  async checkScheduledMessages() {
    try {
      const now = new Date()
      const scheduledMessages = await db.getScheduledMessages()

      for (const scheduled of scheduledMessages) {
        const scheduleTime = new Date(scheduled.schedule_time)

        if (scheduleTime <= now && scheduled.status === "pending") {
          await this.executeScheduledMessage(scheduled)
        }
      }
    } catch (error) {
      logger.error("Error checking scheduled messages:", error)
    }
  }

  async executeScheduledMessage(scheduled) {
    try {
      const channels =
        scheduled.target_channels === "all"
          ? await db.getChannels()
          : await db
              .getChannels()
              .then((chs) => chs.filter((ch) => scheduled.target_channels.split(",").includes(ch.id.toString())))

      for (const channel of channels) {
        if (scheduled.media_group_id && scheduled.media_files) {
          const mediaFiles = JSON.parse(scheduled.media_files)
          
          const media = mediaFiles.map((file, index) => ({
            type: file.type,
            media: file.file_id,
            caption: index === 0 ? file.caption : undefined
          }))

          if (media.length > 0) {
            const sentMessages = await this.bot.sendMediaGroup(channel.chat_id, media)
            
            if (scheduled.pin_duration > 0) {
              await this.bot.pinChatMessage(channel.chat_id, sentMessages[0].message_id)
              
              setTimeout(
                async () => {
                  try {
                    await this.bot.unpinChatMessage(channel.chat_id, sentMessages[0].message_id)
                  } catch (error) {
                    logger.error("Error unpinning message:", error)
                  }
                },
                scheduled.pin_duration * 60 * 1000,
              )
            }
          }
        } else {
          const sentMessage = await this.bot.copyMessage(channel.chat_id, config.adminChatId, scheduled.message_id)

          if (scheduled.pin_duration > 0) {
            await this.bot.pinChatMessage(channel.chat_id, sentMessage.message_id)

            setTimeout(
              async () => {
                try {
                  await this.bot.unpinChatMessage(channel.chat_id, sentMessage.message_id)
                } catch (error) {
                  logger.error("Error unpinning message:", error)
                }
              },
              scheduled.pin_duration * 60 * 1000,
            )
          }
        }
      }

      await db.updateScheduledMessageStatus(scheduled.id, "sent")
      logger.info(`Scheduled message ${scheduled.id} executed`)
    } catch (error) {
      logger.error("Error executing scheduled message:", error)
      await db.updateScheduledMessageStatus(scheduled.id, "failed")
    }
  }

  async listScheduledMessages(chatId) {
    try {
        const scheduled = (await db.getScheduledMessages()).filter((msg) => msg.status === "pending");

        if (scheduled.length === 0) {
        await this.bot.sendMessage(
            chatId,
            "📅 Отложенных сообщений нет\n\nИспользуйте кнопку 'Создать сообщение' для планирования публикаций.",
            keyboards.scheduledMessages,
        );
        return;
        }

        let message = "📅 *Отложенные сообщения:*\n\n";

        scheduled.forEach((msg, index) => {
        const scheduleTime = new Date(msg.schedule_time);
        const status = "⏳";

        message += `${index + 1}. ${status} ${scheduleTime.toLocaleString("ru-RU")}\n`;
        message += `   📍 Каналы: ${msg.target_channels === "all" ? "Все" : "Выбранные"}\n`;
        message += `   📦 Тип: ${msg.media_group_id ? "Медиагруппа" : "Одиночное"}\n\n`;
        });

        const inlineKeyboard = scheduled.map((msg) => [
        {
            text: `❌ Отменить ${new Date(msg.schedule_time).toLocaleString("ru-RU")}`,
            callback_data: `cancel_scheduled_${msg.id}`,
        },
        ]);

        await this.bot.sendMessage(chatId, message, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: inlineKeyboard.length ? inlineKeyboard : [[]] },
        });
    } catch (error) {
        logger.error("Error listing scheduled messages:", error);
    }
  }

  async handleCancelScheduledMessage(query) {
    try {
        const scheduledId = query.data.replace("cancel_scheduled_", "");

        await db.updateScheduledMessageStatus(scheduledId, "cancelled");

        await this.bot.editMessageText(`✅ Запланированное сообщение отменено`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: "Markdown",
        });

        await this.bot.answerCallbackQuery(query.id, { text: "Сообщение отменено!" });

        logger.info(`Scheduled message ${scheduledId} cancelled`);
    } catch (error) {
        logger.error("Error cancelling scheduled message:", error);
        await this.bot.answerCallbackQuery(query.id, { text: "Ошибка при отмене сообщения" });
    }
  }

  isProcessingMessage(userId) {
    return this.userStates.has(userId)
  }

  async handleChannelSelection(query) {
    try {
      const userId = query.from.id
      const data = query.data
      const chatId = query.message.chat.id
      const userState = this.userStates.get(userId)

      if (!userState || userState.action !== "waiting_target_channels") {
        await this.bot.answerCallbackQuery(query.id, { text: "Сессия истекла" })
        return
      }

      let targetChannels = "all"
      let channelText = "Все каналы"

      if (data === "schedule_all_channels") {
        targetChannels = "all"
        channelText = "Все каналы"
      } else if (data.startsWith("schedule_channel_")) {
        const channelId = data.replace("schedule_channel_", "")
        const channels = await db.getChannels()
        const selectedChannel = channels.find((ch) => ch.id.toString() === channelId)

        if (selectedChannel) {
          targetChannels = channelId
          channelText = selectedChannel.title || selectedChannel.username
        }
      }

      const scheduledId = await db.addScheduledMessage(
        userState.messageId,
        targetChannels,
        userState.scheduleTime,
        0,
        userId,
        userState.mediaGroupId,
        JSON.stringify(userState.allMessageIds || [userState.messageId]),
        JSON.stringify(userState.mediaFiles || [])
      )

      this.userStates.delete(userId)

      const scheduleTimeStr = userState.scheduleTime.toLocaleString("ru-RU")

      await this.bot.editMessageText(
        `✅ *Сообщение запланировано!*\n\n` +
          `⏰ Время: ${scheduleTimeStr}\n` +
          `📍 Каналы: ${channelText}\n` +
          `📦 Тип: ${userState.mediaGroupId ? "Медиагруппа" : "Одиночное"}\n\n` +
          `Сообщение будет автоматически отправлено в указанное время.`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🔙 Назад к отложенным", callback_data: "admin_scheduled" }]],
          },
        },
      )

      await this.bot.answerCallbackQuery(query.id, { text: "Сообщение запланировано!" })

      logger.info(`Scheduled message created: ID ${scheduledId}, time: ${scheduleTimeStr}`)
    } catch (error) {
      logger.error("Error handling channel selection:", error)
      await this.bot.answerCallbackQuery(query.id, { text: "Ошибка при планировании" })
    }
  }
}

module.exports = (bot) => new SchedulerManager(bot)