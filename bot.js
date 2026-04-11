const TelegramBot = require("node-telegram-bot-api")
const config = require("./config/config")
const db = require("./database/database")
const keyboards = require("./utils/keyboards")
const logger = require("./utils/logger")
const ChannelManager = require("./modules/channels")
const SuggestionsManager = require("./modules/suggestions")

class AdminBot {
    constructor() {
        this.bot = new TelegramBot(config.botToken, { polling: true })
        this.channelManager = new ChannelManager(this.bot)
        this.suggestionsManager = new SuggestionsManager(this.bot)
        this.schedulerManager = null
        this.floodTracker = new Map()

        this.setupHandlers()
        logger.info("Admin bot started successfully")
    }

    setupHandlers() {

        this.bot.on("message", (msg) => {
            this.handleMessage(msg)
        })

        this.bot.on("channel_post", (msg) => {
            this.handleChannelPost(msg)
        })

        this.bot.on("callback_query", (query) => {
            this.handleCallbackQuery(query)
        })
    }

    async handleMessage(msg) {
        try {
            const chatId = msg.chat.id
            const userId = msg.from?.id
            const isAdmin = userId ? this.isAdmin(userId) : false
            const isAdminChat = chatId.toString() === config.adminChatId

            if (!userId) {
                await this.handleChannelPost(msg)
                return
            }

            if (this.channelManager.isProcessingMessage(userId)) {
                const processed = await this.channelManager.processChannelUsername(msg)
                if (processed) return
            }

            if (this.schedulerManager && this.schedulerManager.isProcessingMessage(userId)) {
                const processed = await this.schedulerManager.processScheduledMessage(msg)
                if (processed) return
            }

            if (msg.text && msg.text.startsWith("/start")) {
                const startParam = msg.text.split(" ")[1]
                if (startParam && startParam.includes("_channel")) {
                    const channelId = startParam.replace("_channel", "")
                    await this.suggestionsManager.handleStartForSuggestions(msg, channelId)
                    return
                }
            }

            // Добавлена обработка команды /mysuggest
            if (msg.text && msg.text.startsWith("/mysuggest")) {
                await this.suggestionsManager.handleMySuggestCommand(msg)
                return
            }

            if (isAdmin && isAdminChat) {
                if (msg.text === "/start" || msg.text === "/admin") {
                    await this.showAdminPanel(chatId)
                    return
                }

                if (msg.text.startsWith("/resetwarnings")) {
                    const args = msg.text.split(" ")
                    if (args[1]) {
                        let targetId = null
                        const target = args[1]

                        if (target.startsWith("@")) {
                            try {
                                const member = await this.bot.getChatMember(chatId, target)
                                targetId = member.user.id
                            } catch {
                                await this.bot.sendMessage(chatId, `❌ Пользователь ${target} не найден`)
                                return
                            }
                        } else {
                            targetId = parseInt(target)
                        }

                        if (targetId) {
                            await db.resetWarnings(targetId, chatId)
                            await this.bot.sendMessage(chatId, `✅ Предупреждения пользователя ${target} сброшены`)
                        }
                    } else {
                        await this.bot.sendMessage(chatId, `Использование: /resetwarnings <userId|@username>`)
                    }
                    return
                }
            }

            if (["supergroup", "group"].includes(msg.chat.type)) {
                await this.handleChannelMessage(msg)
            }

            if (msg.chat.type === "private" && !isAdminChat) {
                await this.suggestionsManager.handlePrivateSuggestion(msg)
            }
        } catch (error) {
            logger.error("Error handling message:", error)
        }
    }

  async handleChannelPost(msg) {
    try {
      const chatId = msg.chat.id.toString();

      const channels = await db.getChannels();
      const channel = channels.find((ch) => ch.chat_id === chatId);
      if (!channel) return;

    } catch (error) {
      logger.error("Error handling channel post:", error);
    }
  }

  async postChannelRules(chatId, channel, msg = null, replyToMessageId = null) {
    console.log(chatId, msg?.message_id, msg?.media_group_id)
    try {
      if (msg?.media_group_id) {
        if (!this.mediaGroupCache) this.mediaGroupCache = new Set();

        if (this.mediaGroupCache.has(msg.media_group_id)) {
          console.log('MEDIA GROUP ALREADY PROCESSED:', msg.media_group_id);
          return;
        }

        this.mediaGroupCache.add(msg.media_group_id);
        console.log('MEDIA GROUP ADDED TO CACHE:', msg.media_group_id);

        setTimeout(() => {
          this.mediaGroupCache.delete(msg.media_group_id);
          console.log('MEDIA GROUP REMOVED FROM CACHE:', msg.media_group_id);
        }, 10000);
      }

      const rulesMessage =
        channel.rules_message ||
        `📋 *Правила канала:*\n\n` +
        `• Будьте вежливы и уважительны\n` +
        `• Не спамьте и не флудите\n` +
        `• Запрещена реклама без разрешения\n` +
        `• Соблюдайте тематику канала\n\n` +
        `⚠️ За нарушения выдаются предупреждения, после ${channel.max_warnings || 3} предупреждений - бан`;

      const messageOptions = {
        parse_mode: "Markdown",
        reply_to_message_id: replyToMessageId || msg?.message_id
      };

      await this.bot.sendMessage(chatId, rulesMessage, messageOptions);
      logger.info(`Rules sent successfully to chat: ${chatId}`);

    } catch (error) {
      logger.error("Error posting rules:", error);
    }
  }

  async handleChannelMessage(msg) {
    try {
      const chatId = msg.chat.id.toString()

      let channel = null
      const channels = await db.getChannels()

      channel = channels.find((ch) => ch.chat_id === chatId)

      if (!channel && (msg.chat.type === "supergroup" || msg.chat.type === "group")) {
        for (const ch of channels) {
          try {
            const channelInfo = await this.bot.getChat(ch.chat_id)
            if (channelInfo.linked_chat_id && channelInfo.linked_chat_id.toString() === chatId) {
              channel = ch
              break
            }
          } catch (error) {
            console.log("Error checking channel info for", ch.chat_id, ":", error.message)
          }
        }
      }

      if (!channel) return

      if (msg.from && msg.from.id) {
        await this.moderateComment(msg, channel)
      }
    } catch (error) {
      logger.error("Error handling channel message:", error)
    }
  }

  async moderateComment(msg, channel) {
    try {
      const userId = msg.from.id
      const text = msg.text || msg.caption || ""

      if (userId === 777000) {
        return await this.postChannelRules(msg.chat.id, channel, msg || null, msg.message_id)
      }

      const violations = []

      if (text.length > 500) violations.push("Слишком длинное сообщение")
      if (text.match(/[А-ЯA-Z]{10,}/)) violations.push("Капс")
      if (text.match(/(.)\1{5,}/)) violations.push("Спам символами")

      const badWords = ["реклама", "продам", "куплю"]
      if (badWords.some((word) => text.toLowerCase().includes(word))) {
        violations.push("Запрещенные слова")
      }

      const userKey = `flood_${userId}_${msg.chat.id}`
      const now = Date.now()
      const userMessages = this.floodTracker.get(userKey) || []
      const recentMessages = userMessages.filter((time) => now - time < 60000)
      recentMessages.push(now)
      this.floodTracker.set(userKey, recentMessages)

      if (recentMessages.length > 5) {
        violations.push("Флуд")
      }

      if (violations.length > 0) {
        const warnings = await db.addWarning(userId, msg.chat.id, violations.join(", "))
        if (warnings >= (channel.max_warnings || 3)) {
          await this.bot.sendMessage(
            msg.chat.id,
            `🚫 Пользователь ${msg.from.first_name} заблокирован за нарушения\n` +
            `Причина: ${violations.join(", ")}\n` +
            `Всего предупреждений: ${warnings}`
          )
          await this.bot.banChatMember(msg.chat.id, userId)
          logger.info(`User ${userId} banned in ${msg.chat.id} for ${warnings} warnings`)
        } else {
          await this.bot.sendMessage(
            msg.chat.id,
            `⚠️ Предупреждение пользователю ${msg.from.first_name}\n` +
            `Причина: ${violations.join(", ")}\n` +
            `Предупреждений: ${warnings}/${channel.max_warnings || 3}`,
            {
              reply_to_message_id: msg.message_id
            }
          )
        }

        setTimeout(async () => {
          try {
            await this.bot.deleteMessage(msg.chat.id, msg.message_id)
          } catch (e) {
            logger.error("Error deleting message:", e)
          }
        }, 1000)

        logger.info(`Moderated message from user ${userId} in ${msg.chat.id}: ${violations.join(", ")}`)
      }
    } catch (error) {
      logger.error("Error moderating comment:", error)
    }
  }

    async handleCallbackQuery(query) {
        try {
            const chatId = query.message.chat.id
            const userId = query.from.id
            const data = query.data

            if (!this.isAdmin(userId)) {
                await this.bot.answerCallbackQuery(query.id, { text: "Доступ запрещен" })
                return
            }

            if (data === "cancel_suggestion") {
                this.suggestionsManager.userStates.delete(userId)
                await this.bot.answerCallbackQuery(query.id, { text: "❌ Отправка предложения отменена" })
                await this.bot.deleteMessage(chatId, query.message.message_id)
                return
            }

            // УДАЛЯЕМ этот блок - он дублируется
            // if (data.startsWith("forward_to_main_admin_")) {
            //     await this.suggestionsManager.handleForwardToMainAdmin(query);
            //     return;
            // }

            if (data.startsWith("approve_") || data.startsWith("reject_") || data.startsWith("ban_") || data.startsWith("forward_to_main_admin_")) {
                await this.suggestionsManager.handleSuggestionAction(query)
                return
            }

            // ... остальной код без изменений


      if (data.startsWith("delete_")) {
          const channelId = Number(data.split("_")[1])
          await this.channelManager.deleteChannel(chatId, channelId)
      }


      if (data.startsWith("cancel_scheduled_")) {
        if (!this.schedulerManager) {
            this.schedulerManager = require("./modules/scheduler")(this.bot);
        }
        await this.schedulerManager.handleCancelScheduledMessage(query);
        return;
      }

      if (data.startsWith("remove_warnings_") || data.startsWith("unban_user_")) {
        await this.handleModerationAction(query)
        return
      }

      if (data.startsWith("schedule_all_channels") || data.startsWith("schedule_channel_")) {
        if (!this.schedulerManager) {
          this.schedulerManager = require("./modules/scheduler")(this.bot)
        }
        await this.schedulerManager.handleChannelSelection(query)
        return
      }
      switch (data) {
        case "admin_main":
          await this.showAdminPanel(chatId)
          break

        case "admin_channels":
          await this.showChannelManagement(chatId)
          break

        case "add_channel":
          await this.channelManager.handleAddChannel(chatId, userId)
          break

        case "list_channels":
          await this.channelManager.listChannels(chatId)
          break

        case "channel_settings":
          await this.channelManager.showChannelSettings(chatId)
          break

        case "admin_scheduled":
          await this.showScheduledMessages(chatId)
          break

        case "create_scheduled":
          if (!this.schedulerManager) {
            this.schedulerManager = require("./modules/scheduler")(this.bot)
          }
          await this.schedulerManager.handleCreateScheduled(chatId, userId)
          break

        case "list_scheduled":
          if (!this.schedulerManager) {
            this.schedulerManager = require("./modules/scheduler")(this.bot)
          }
          await this.schedulerManager.listScheduledMessages(chatId)
          break

        case "admin_suggestions":
          await this.showSuggestions(chatId)
          break

        case "admin_moderation":
          await this.showModeration(chatId)
          break

        case "admin_stats":
          await this.showStats(chatId)
          break

        case "user_management":
          await this.showUserManagement(chatId)
          break

        default:
          if (data.startsWith("settings_")) {
            const channelId = data.split("_")[1]
            await this.showSpecificChannelSettings(chatId, channelId)
          }
      }

      await this.bot.answerCallbackQuery(query.id)
    } catch (error) {
      logger.error("Error handling callback query:", error)
      await this.bot.answerCallbackQuery(query.id, { text: "Произошла ошибка" })
    }
  }

  async handleModerationAction(query) {
    try {
      const data = query.data
      const chatId = query.message.chat.id

      if (data.startsWith("remove_warnings_")) {
        const userId = data.split("_")[2]
        const channelId = data.split("_")[3]

        await db.resetWarnings(userId, channelId)
        await this.bot.answerCallbackQuery(query.id, { text: "Предупреждения сняты" })
        await this.bot.sendMessage(chatId, `✅ Предупреждения сняты с пользователя ${userId}`)
      } else if (data.startsWith("unban_user_")) {
        const userId = data.split("_")[2]
        const channelId = data.split("_")[3]

        await this.bot.unbanChatMember(channelId, userId)
        await this.bot.answerCallbackQuery(query.id, { text: "Пользователь разбанен" })
        await this.bot.sendMessage(chatId, `✅ Пользователь ${userId} разбанен в канале ${channelId}`)
      }
    } catch (error) {
      logger.error("Error handling moderation action:", error)
      await this.bot.answerCallbackQuery(query.id, { text: "Ошибка выполнения действия" })
    }
  }

  async showUserManagement(chatId) {
    const message =
      `👥 *Управление пользователями*\n\n` +
      `Для снятия предупреждений или разбана пользователя:\n` +
      `• Ответьте на сообщение пользователя командой /remove_warnings\n` +
      `• Ответьте на сообщение пользователя командой /unban\n\n` +
      `Или используйте команды:\n` +
      `/remove_warnings [user_id] [channel_id]\n` +
      `/unban [user_id] [channel_id]`

    await this.bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      ...keyboards.backToMain,
    })
  }

  async showAdminPanel(chatId) {
    const message = `🤖 *Админ-панель бота*\n\n` + `Выберите раздел для управления:`

    await this.bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      ...keyboards.adminMain,
    })
  }

  async showChannelManagement(chatId) {
    const message =
      `📋 *Управление каналами*\n\n` + `Здесь вы можете добавлять каналы, настраивать модерацию и другие функции.`

    await this.bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      ...keyboards.channelManagement,
    })
  }

  async showScheduledMessages(chatId) {
    const message = `⏰ *Отложенные сообщения*\n\n` + `Управление отложенными публикациями в каналах.`

    await this.bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      ...keyboards.scheduledMessages,
    })
  }

  async showStats(chatId) {
    try {
      const channels = await db.getChannels()

      const message =
        `📊 *Статистика бота*\n\n` +
        `📋 Каналов подключено: ${channels.length}\n` +
        `🛡️ Модерация активна: ${channels.filter((c) => c.moderation_enabled).length}\n` +
        `📝 Предложения активны: ${channels.filter((c) => c.suggestions_enabled).length}`

      await this.bot.sendMessage(chatId, message, {
        parse_mode: "Markdown",
        ...keyboards.backToMain,
      })
    } catch (error) {
      logger.error("Error showing stats:", error)
    }
  }

  async showSpecificChannelSettings(chatId, channelId) {
    await this.bot.sendMessage(
      chatId,
      "⚙️ Настройки канала будут добавлены в следующем обновлении",
      keyboards.backToMain,
    )
  }

  isAdmin(userId) {
    return config.adminUserIds.includes(userId)
  }
}

new AdminBot()