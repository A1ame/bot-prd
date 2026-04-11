const TelegramBot = require("node-telegram-bot-api")
const config = require("./config/config")
const db = require("./database/database")
const keyboards = require("./utils/keyboards")
const logger = require("./utils/logger")
const ChannelManager = require("./modules/channels")
const SuggestionsManager = require("./modules/suggestions")
const VKBridge = require("./modules/vk")

class AdminBot {
    constructor() {
        this.bot = new TelegramBot(config.botToken, { polling: true })
        this.channelManager = new ChannelManager(this.bot)
        this.suggestionsManager = new SuggestionsManager(this.bot)
        this.schedulerManager = null
        this.floodTracker = new Map()

        // Инициализация VK Bridge
        if (config.vkToken && config.vkGroupId && config.vkGroupId !== "YOUR_VK_GROUP_ID_HERE") {
            this.vkBridge = new VKBridge(this.bot)
            this.vkBridge.startPolling()
            logger.info("VK Bridge initialized and Long Poll started")
        } else {
            this.vkBridge = null
            logger.warn("VK Bridge disabled: VK_TOKEN or VK_GROUP_ID not set in .env")
        }

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

            if (msg.text && msg.text.startsWith("/mysuggest")) {
                await this.suggestionsManager.handleMySuggestCommand(msg)
                return
            }

            if (isAdmin && isAdminChat) {
                if (msg.text === "/start" || msg.text === "/admin") {
                    await this.showAdminPanel(chatId)
                    return
                }

                if (msg.text && msg.text.startsWith("/resetwarnings")) {
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
            const chatId = msg.chat.id.toString()

            const channels = await db.getChannels()
            const channel = channels.find((ch) => ch.chat_id === chatId)
            if (!channel) return

            // ✅ Кросс-постинг: новый пост в TG канале → ВК
            if (this.vkBridge) {
                // Не обрабатываем медиагруппы частично — ждём первый элемент
                if (!msg.media_group_id) {
                    await this.vkBridge.handleTelegramChannelPost(msg)
                } else {
                    // Для медиагрупп берём только первое сообщение (с caption)
                    if (!this._tgMediaGroupCache) this._tgMediaGroupCache = new Map()

                    if (!this._tgMediaGroupCache.has(msg.media_group_id)) {
                        this._tgMediaGroupCache.set(msg.media_group_id, msg)

                        setTimeout(async () => {
                            const firstMsg = this._tgMediaGroupCache.get(msg.media_group_id)
                            if (firstMsg && this.vkBridge) {
                                await this.vkBridge.handleTelegramChannelPost(firstMsg)
                            }
                            this._tgMediaGroupCache.delete(msg.media_group_id)
                        }, 2000)
                    }
                }
            }
        } catch (error) {
            logger.error("Error handling channel post:", error)
        }
    }

    async postChannelRules(chatId, channel, msg = null, replyToMessageId = null) {
        console.log(chatId, msg?.message_id, msg?.media_group_id)
        try {
            if (msg?.media_group_id) {
                if (!this.mediaGroupCache) this.mediaGroupCache = new Set()

                if (this.mediaGroupCache.has(msg.media_group_id)) {
                    console.log('MEDIA GROUP ALREADY PROCESSED:', msg.media_group_id)
                    return
                }

                this.mediaGroupCache.add(msg.media_group_id)
                console.log('MEDIA GROUP ADDED TO CACHE:', msg.media_group_id)

                setTimeout(() => {
                    this.mediaGroupCache.delete(msg.media_group_id)
                    console.log('MEDIA GROUP REMOVED FROM CACHE:', msg.media_group_id)
                }, 10000)
            }

            const rulesMessage =
                channel.rules_message ||
                `📋 *Правила канала:*\n\n` +
                `• Будьте вежливы и уважительны\n` +
                `• Не спамьте и не флудите\n` +
                `• Запрещена реклама без разрешения\n` +
                `• Соблюдайте тематику канала\n\n` +
                `⚠️ За нарушения выдаются предупреждения, после ${channel.max_warnings || 3} предупреждений - бан`

            const messageOptions = {
                parse_mode: "Markdown",
                reply_to_message_id: replyToMessageId || msg?.message_id,
            }

            await this.bot.sendMessage(chatId, rulesMessage, messageOptions)
            logger.info(`Rules sent successfully to chat: ${chatId}`)
        } catch (error) {
            logger.error("Error posting rules:", error)
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

            if (recentMessages.length >= 5) violations.push("Флуд")

            recentMessages.push(now)
            this.floodTracker.set(userKey, recentMessages)

            if (violations.length > 0 && channel.moderation_enabled) {
                await this.handleViolation(msg, channel, violations)
            }
        } catch (error) {
            logger.error("Error moderating comment:", error)
        }
    }

    async handleViolation(msg, channel, violations) {
        try {
            const userId = msg.from.id
            const chatId = msg.chat.id

            await this.bot.deleteMessage(chatId, msg.message_id)

            const warningCount = await db.addWarning(userId, chatId, violations.join(", "))
            const maxWarnings = channel.max_warnings || config.maxWarnings

            if (warningCount >= maxWarnings) {
                await this.bot.banChatMember(chatId, userId)
                await this.bot.sendMessage(
                    chatId,
                    `🚫 Пользователь @${msg.from.username || msg.from.first_name} заблокирован за систематические нарушения.`,
                )

                await this.bot.sendMessage(
                    config.adminChatId,
                    `🚫 *Пользователь заблокирован*\n\n` +
                        `👤 ${msg.from.first_name} (@${msg.from.username || "нет"})\n` +
                        `🆔 ID: ${userId}\n` +
                        `📍 Чат: ${chatId}\n` +
                        `📋 Нарушения: ${violations.join(", ")}\n` +
                        `⚠️ Предупреждений: ${warningCount}/${maxWarnings}`,
                    {
                        parse_mode: "Markdown",
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "🔓 Разбанить", callback_data: `unban_user_${userId}_${chatId}` }],
                            ],
                        },
                    },
                )
            } else {
                try {
                    await this.bot.sendMessage(
                        chatId,
                        `⚠️ @${msg.from.username || msg.from.first_name}, предупреждение ${warningCount}/${maxWarnings}. Причина: ${violations.join(", ")}`,
                    )
                } catch (err) {
                    logger.error("Error sending warning message:", err)
                }
            }
        } catch (error) {
            logger.error("Error handling violation:", error)
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

            // ✅ Обработка действий с предложениями из ВК
            if (data.startsWith("vk_approve_")) {
                const postId = parseInt(data.replace("vk_approve_", ""))
                if (this.vkBridge) {
                    await this.vkBridge.approveVkSuggest(postId, query)
                } else {
                    await this.bot.answerCallbackQuery(query.id, { text: "VK Bridge не инициализирован" })
                }
                return
            }

            if (data.startsWith("vk_reject_")) {
                const postId = parseInt(data.replace("vk_reject_", ""))
                if (this.vkBridge) {
                    await this.vkBridge.rejectVkSuggest(postId, query)
                } else {
                    await this.bot.answerCallbackQuery(query.id, { text: "VK Bridge не инициализирован" })
                }
                return
            }

            if (data.startsWith("approve_") || data.startsWith("reject_") || data.startsWith("ban_") || data.startsWith("forward_to_main_admin_")) {
                await this.suggestionsManager.handleSuggestionAction(query)
                return
            }

            if (data.startsWith("delete_")) {
                const channelId = Number(data.split("_")[1])
                await this.channelManager.deleteChannel(chatId, channelId)
            }

            if (data.startsWith("cancel_scheduled_")) {
                if (!this.schedulerManager) {
                    this.schedulerManager = require("./modules/scheduler")(this.bot)
                }
                await this.schedulerManager.handleCancelScheduledMessage(query)
                return
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

                case "noop":
                    // Кнопка без действия (уже обработано)
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
            try {
                await this.bot.answerCallbackQuery(query.id, { text: "Произошла ошибка" })
            } catch (e) {}
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
        const vkStatus = this.vkBridge ? "🟢 ВК подключён" : "🔴 ВК не подключён"
        const message =
            `🤖 *Админ-панель бота*\n\n` +
            `${vkStatus}\n\n` +
            `Выберите раздел для управления:`

        await this.bot.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            ...keyboards.adminMain,
        })
    }

    async showChannelManagement(chatId) {
        const message =
            `📋 *Управление каналами*\n\n` +
            `Здесь вы можете добавлять каналы, настраивать модерацию и другие функции.`

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
            const vkStatus = this.vkBridge
                ? `✅ Подключён (группа ID: ${config.vkGroupId})`
                : `❌ Не подключён`

            const message =
                `📊 *Статистика бота*\n\n` +
                `📋 Каналов подключено: ${channels.length}\n` +
                `🛡️ Модерация активна: ${channels.filter((c) => c.moderation_enabled).length}\n` +
                `📝 Предложения активны: ${channels.filter((c) => c.suggestions_enabled).length}\n\n` +
                `🔵 *ВКонтакте:* ${vkStatus}`

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
