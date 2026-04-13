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
        this.bot = new TelegramBot(config.botToken, {
            polling: {
                params: {
                    allowed_updates: [
                        "message",
                        "edited_message",
                        "channel_post",
                        "edited_channel_post",
                        "callback_query",
                        "chat_member",
                        "my_chat_member"
                    ]
                }
            }
        })
        this.channelManager = new ChannelManager(this.bot)
        this.schedulerManager = null
        this.floodTracker = new Map()
        this.unbanStates = new Map()  // userId -> waiting_unban_id

        // Инициализация VK Bridge(s) — поддержка нескольких ВК групп
        this.vkBridges = []  // все активные мосты
        this.vkBridge = null  // основной (первый) для обратной совместимости

        // Собираем все пары VK_GROUP_ID_N / VK_TOKEN_N из env
        const vkPairs = []

        // Сначала проверяем нумерованные: VK_GROUP_ID_1, VK_GROUP_ID_2, ...
        for (let i = 1; i <= 30; i++) {
            const groupId = process.env[`VK_GROUP_ID_${i}`]
            const token = process.env[`VK_TOKEN_${i}`]
            const userToken = process.env[`VK_USER_TOKEN_${i}`]
            if (groupId && token) {
                vkPairs.push({ groupId, token, userToken, index: i })
            }
        }

        // Если нет нумерованных — используем старые VK_GROUP_ID / VK_TOKEN
        if (vkPairs.length === 0 && config.vkToken && config.vkGroupId && config.vkGroupId !== "YOUR_VK_GROUP_ID_HERE") {
            vkPairs.push({ groupId: config.vkGroupId, token: config.vkToken, userToken: process.env.VK_USER_TOKEN, index: 0 })
        }

        for (const pair of vkPairs) {
            try {
                const bridge = new VKBridge(this.bot, pair.groupId, pair.token, pair.userToken)
                bridge.startPolling()
                this.vkBridges.push(bridge)
                if (!this.vkBridge) this.vkBridge = bridge  // первый = основной
                logger.info(`VK Bridge #${pair.index} initialized for group ${pair.groupId}`)
            } catch (e) {
                logger.error(`VK Bridge #${pair.index} init failed:`, e)
            }
        }

        if (this.vkBridges.length === 0) {
            logger.warn("VK Bridge disabled: no VK_GROUP_ID/VK_TOKEN found in .env")
        }

        // SuggestionsManager получает все vkBridges для маршрутизации по каналам
        this.suggestionsManager = new SuggestionsManager(this.bot, this.vkBridges)

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
                // Обработка ввода ID для разбана
                const unbanState = this.unbanStates.get(userId)
                if ((unbanState === "waiting_unban_tg" || unbanState === "waiting_unban_vk") && msg.text) {
                    const input = msg.text.trim()

                    if (unbanState === "waiting_unban_tg") {
                        const bannedList = await db.getBannedUsers()
                        logger.info(`TG unban attempt: input="${input}", banned=${JSON.stringify(bannedList)}`)
                        const changes = await db.unbanUser(input)
                        if (changes > 0) {
                            await this.bot.sendMessage(chatId, `✅ TG пользователь ${input} разбанен — теперь может писать боту.`)
                            if (!input.startsWith("@")) {
                                const targetId = parseInt(input)
                                if (!isNaN(targetId)) {
                                    try { await this.bot.sendMessage(targetId, "✅ Вы разблокированы и снова можете отправлять предложения.") } catch (e) {}
                                }
                            }
                        } else {
                            let listMsg = `❌ TG пользователь *${input}* не найден в списке забаненных.\n\n`
                            if (bannedList.length === 0) {
                                listMsg += `Список забаненных пуст.`
                            } else {
                                listMsg += `*Забаненные TG пользователи:*\n`
                                bannedList.forEach(u => {
                                    listMsg += `• ID: \`${u.user_id}\`${u.username ? ` (@${u.username})` : ""}\n`
                                })
                            }
                            await this.bot.sendMessage(chatId, listMsg, { parse_mode: "Markdown" })
                        }
                    } else if (unbanState === "waiting_unban_vk") {
                        const vkId = parseInt(input)
                        if (isNaN(vkId) || vkId <= 0) {
                            await this.bot.sendMessage(chatId, `❌ Неверный формат. Введите числовой VK ID (например: 123456789)`)
                            this.unbanStates.delete(userId)
                            return
                        }
                        if (this.vkBridge) {
                            const wasBanned = this.vkBridge.bannedVkUsers.has(vkId)
                            this.vkBridge.bannedVkUsers.delete(vkId)
                            // Также разбаниваем в группе ВК через API
                            try {
                                await this.vkBridge.vkApi("groups.unban", {
                                    group_id: this.vkBridge.vkGroupId,
                                    owner_id: vkId,
                                })
                                await this.bot.sendMessage(chatId, `✅ VK пользователь ${vkId} разбанен в группе ВКонтакте.`)
                                logger.info(`VK user ${vkId} unbanned via groups.unban`)
                            } catch (e) {
                                if (wasBanned) {
                                    await this.bot.sendMessage(chatId, `✅ VK пользователь ${vkId} удалён из локального бан-листа.\n⚠️ groups.unban не сработал: ${e.message}`)
                                } else {
                                    await this.bot.sendMessage(chatId, `⚠️ VK пользователь ${vkId} не найден в локальном бан-листе.\nПопробую разбанить в группе ВК...`)
                                    try {
                                        await this.vkBridge.vkApi("groups.unban", { group_id: this.vkBridge.vkGroupId, owner_id: vkId })
                                        await this.bot.sendMessage(chatId, `✅ VK пользователь ${vkId} разбанен в группе ВКонтакте.`)
                                    } catch (e2) {
                                        await this.bot.sendMessage(chatId, `❌ Не удалось разбанить VK пользователя ${vkId}: ${e2.message}`)
                                    }
                                }
                            }
                        } else {
                            await this.bot.sendMessage(chatId, "❌ VK Bridge не подключён.")
                        }
                    }

                    this.unbanStates.delete(userId)
                    return
                }

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

            if (msg.chat.type === "private") {
                await this.suggestionsManager.handlePrivateSuggestion(msg)
            }
        } catch (error) {
            logger.error("Error handling message:", error)
        }
    }

    async handleChannelPost(msg) {
        try {
            const chatId = msg.chat.id.toString()
            logger.info(`TG channel_post received: chatId=${chatId}`)

            const channels = await db.getChannels()
            const channel = channels.find((ch) => ch.chat_id === chatId)
            if (!channel) {
                logger.warn(`channel_post: chatId=${chatId} NOT in DB`)
                return
            }

            // ✅ Кросс-постинг: новый пост в TG канале → ВК
            // Ищем VKBridge привязанный к этому TG каналу
            const vkBridgeForChannel = this.vkBridges.find(b => {
                // channel.vk_group_id должен совпадать с b.vkGroupId
                return channel.vk_group_id && String(channel.vk_group_id) === String(b.vkGroupId)
            }) || this.vkBridge  // fallback на основной

            if (vkBridgeForChannel) {
                if (!msg.media_group_id) {
                    // Одиночное сообщение
                    await vkBridgeForChannel.handleTelegramChannelPost(msg)
                } else {
                    // Медиагруппа — собираем ВСЕ сообщения, потом отправляем
                    if (!this._tgMediaGroupCache) this._tgMediaGroupCache = new Map()

                    if (!this._tgMediaGroupCache.has(msg.media_group_id)) {
                        this._tgMediaGroupCache.set(msg.media_group_id, { msgs: [], bridge: vkBridgeForChannel })
                        setTimeout(async () => {
                            const entry = this._tgMediaGroupCache.get(msg.media_group_id)
                            if (entry && entry.msgs.length > 0 && entry.bridge) {
                                await entry.bridge.handleTelegramMediaGroup(entry.msgs)
                            }
                            this._tgMediaGroupCache.delete(msg.media_group_id)
                        }, 2500)
                    }
                    this._tgMediaGroupCache.get(msg.media_group_id).msgs.push(msg)
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
            if (data.startsWith("vk_approve_guide_") || data.startsWith("vk_approve_") ||
                data.startsWith("vk_reject_") || data.startsWith("vk_ban_") || data.startsWith("vk_forward_")) {
                // Находим нужный bridge по postId (ищем в pendingVkSuggestions всех bridge)
                let postId, targetBridge = null
                if (data.startsWith("vk_approve_guide_")) postId = parseInt(data.replace("vk_approve_guide_", ""))
                else if (data.startsWith("vk_approve_")) postId = parseInt(data.replace("vk_approve_", ""))
                else if (data.startsWith("vk_reject_")) postId = parseInt(data.replace("vk_reject_", ""))
                else if (data.startsWith("vk_ban_")) postId = parseInt(data.replace("vk_ban_", ""))
                else if (data.startsWith("vk_forward_")) postId = parseInt(data.replace("vk_forward_", ""))

                for (const b of this.vkBridges) {
                    if (b.pendingVkSuggestions.has(postId)) { targetBridge = b; break }
                }
                if (!targetBridge) targetBridge = this.vkBridge

                if (!targetBridge) {
                    await this.bot.answerCallbackQuery(query.id, { text: "VK Bridge не инициализирован" })
                    return
                }

                if (data.startsWith("vk_approve_guide_")) await targetBridge.approveVkSuggestWithGuide(postId, query)
                else if (data.startsWith("vk_approve_")) await targetBridge.approveVkSuggest(postId, query)
                else if (data.startsWith("vk_reject_")) await targetBridge.rejectVkSuggest(postId, query)
                else if (data.startsWith("vk_ban_")) await targetBridge.banVkSuggestAuthor(postId, query)
                else if (data.startsWith("vk_forward_")) await targetBridge.forwardVkSuggestToMainAdmin(postId, query)
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

            if (data === "start_unban_tg") {
                this.unbanStates.set(userId, "waiting_unban_tg")
                await this.bot.answerCallbackQuery(query.id)
                const bannedList = await db.getBannedUsers()
                let msg = "🔓 *Разбан Telegram пользователя*\n\n"
                if (bannedList.length === 0) {
                    msg += "Список забаненных TG пользователей пуст.\n\n"
                } else {
                    msg += "*Забаненные TG пользователи:*\n"
                    bannedList.forEach(u => {
                        msg += "• ID: " + u.user_id + (u.username ? " (@" + u.username + ")" : "") + "\n"
                    })
                    msg += "\n"
                }
                msg += "Введите ID или @username для разбана:"
                await this.bot.sendMessage(chatId, msg)
                return
            }
            
            if (data === "start_unban_vk") {
                this.unbanStates.set(userId, "waiting_unban_vk")
                await this.bot.answerCallbackQuery(query.id)
                let lines = ["🔓 Разбан ВКонтакте пользователя", ""]
                if (this.vkBridge && this.vkBridge.bannedVkUsers.size > 0) {
                    lines.push("Локально забаненные VK пользователи (ID):")
                    this.vkBridge.bannedVkUsers.forEach(id => lines.push("• " + id))
                    lines.push("")
                } else {
                    lines.push("Список локально забаненных VK пользователей пуст.")
                    lines.push("")
                }
                lines.push("Введите VK ID пользователя для разбана (например: 123456789):")
                await this.bot.sendMessage(chatId, lines.join("\n"))
                return
            }

            if (data.startsWith("unban_bot_")) {
                const userId = parseInt(data.replace("unban_bot_", ""))
                try {
                    await db.unbanUser(userId)
                    await this.bot.answerCallbackQuery(query.id, { text: "✅ Пользователь разбанен" })
                    await this.bot.sendMessage(chatId, `✅ Пользователь ${userId} разбанен — теперь может писать боту`)
                    try {
                        await this.bot.sendMessage(userId, "✅ Вы разблокированы и снова можете отправлять предложения.")
                    } catch (e) {}
                } catch (e) {
                    await this.bot.answerCallbackQuery(query.id, { text: "Ошибка при разбане" })
                }
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
                    if (data.startsWith("link_vk_")) {
                        // link_vk_{channelId}_{vkGroupId}
                        const parts = data.split("_")
                        const channelDbId = parts[2]
                        const vkGroupId = parts[3]
                        const channels = await db.getChannels()
                        const channel = channels.find(c => c.id === parseInt(channelDbId))
                        if (channel) {
                            await db.setChannelVkGroup(channel.chat_id, vkGroupId)
                            await this.bot.sendMessage(chatId,
                                `✅ Канал *${channel.title || channel.username}* привязан к ВК группе vk.com/club${vkGroupId}`,
                                { parse_mode: "Markdown", ...keyboards.backToMain }
                            )
                            logger.info(`Channel ${channel.chat_id} linked to VK group ${vkGroupId}`)
                        }
                    } else if (data.startsWith("settings_")) {
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

        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    ...(keyboards.adminMain?.reply_markup?.inline_keyboard || []),
                    [
                        { text: "🔓 Разбанить TG пользователя", callback_data: "start_unban_tg" },
                        { text: "🔓 Разбанить VK пользователя", callback_data: "start_unban_vk" },
                    ],
                ]
            }
        }

        await this.bot.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            ...keyboard,
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

            let vkBridgesStatus = ""
            if (this.vkBridges.length > 1) {
                vkBridgesStatus = "\n\n*Активные VK группы:*\n"
                this.vkBridges.forEach((b, i) => {
                    const linked = channels.find(c => c.vk_group_id === String(b.vkGroupId))
                    vkBridgesStatus += `${i+1}. vk.com/club${b.vkGroupId} → ${linked ? (linked.title || linked.username) : "не привязан"}\n`
                })
            }

            const message =
                `📊 *Статистика бота*\n\n` +
                `📋 Каналов подключено: ${channels.length}\n` +
                `🛡️ Модерация активна: ${channels.filter((c) => c.moderation_enabled).length}\n` +
                `📝 Предложения активны: ${channels.filter((c) => c.suggestions_enabled).length}\n\n` +
                `🔵 *ВКонтакте:* ${vkStatus}` + vkBridgesStatus

            await this.bot.sendMessage(chatId, message, {
                parse_mode: "Markdown",
                ...keyboards.backToMain,
            })
        } catch (error) {
            logger.error("Error showing stats:", error)
        }
    }

    async showSuggestions(chatId) {
        try {
            const channels = await db.getChannels()
            if (channels.length === 0) {
                await this.bot.sendMessage(chatId, "📋 Каналы не добавлены. Сначала добавьте каналы.", keyboards.backToMain)
                return
            }
            const botInfo = await this.bot.getMe()
            let message = "📝 *Предложения — ссылки для пользователей:*\n\n"
            channels.forEach((channel, index) => {
                const cleanId = Math.abs(Number(channel.chat_id))
                const link = `https://t.me/${botInfo.username}?start=${cleanId}_channel`
                message += `${index + 1}. *${channel.title || channel.username}*\n`
                message += `   🔗 ${link}\n\n`
            })
            message += `Отправьте эти ссылки пользователям — через них они смогут предлагать посты.`
            await this.bot.sendMessage(chatId, message, { parse_mode: "Markdown", ...keyboards.backToMain })
        } catch (error) {
            logger.error("Error showing suggestions:", error)
        }
    }

    async showModeration(chatId) {
        try {
            const channels = await db.getChannels()
            const message =
                `🛡️ *Модерация*\n\n` +
                `Каналов с модерацией: ${channels.filter(c => c.moderation_enabled).length} из ${channels.length}\n\n` +
                `Автоматически:\n` +
                `• Удаляет сообщения с нарушениями\n` +
                `• Выдаёт предупреждения\n` +
                `• После ${config.maxWarnings} предупреждений — бан\n\n` +
                `Для настройки: *Каналы → Настройки канала*`
            await this.bot.sendMessage(chatId, message, { parse_mode: "Markdown", ...keyboards.backToMain })
        } catch (error) {
            logger.error("Error showing moderation:", error)
        }
    }

    async showSpecificChannelSettings(chatId, channelId) {
        try {
            const channels = await db.getChannels()
            const channel = channels.find(c => c.id === parseInt(channelId))
            if (!channel) {
                await this.bot.sendMessage(chatId, "❌ Канал не найден", keyboards.backToMain)
                return
            }

            const linkedVk = channel.vk_group_id
                ? `🔗 Привязана ВК группа: vk.com/club${channel.vk_group_id}`
                : `🔗 ВК группа: не привязана`

            // Показываем доступные VK группы для привязки
            const vkButtons = this.vkBridges.map(b => ([{
                text: `🔗 Привязать vk.com/club${b.vkGroupId}`,
                callback_data: `link_vk_${channelId}_${b.vkGroupId}`
            }]))

            const keyboard = {
                reply_markup: {
                    inline_keyboard: [
                        ...vkButtons,
                        [{ text: "🔙 Назад", callback_data: "admin_channels" }]
                    ]
                }
            }

            await this.bot.sendMessage(chatId,
                `⚙️ *Настройки канала: ${channel.title || channel.username}*\n\n${linkedVk}\n\nВыберите ВК группу для привязки:`,
                { parse_mode: "Markdown", ...keyboard }
            )
        } catch (e) {
            logger.error("showSpecificChannelSettings error:", e)
        }
    }

    async _resolveUsername(usernameWithAt) {
        try {
            // Telegram позволяет получить chat/user по username через getChat
            const chat = await this.bot.getChat(usernameWithAt)
            return chat?.id || null
        } catch (e) {
            logger.warn(`_resolveUsername: could not resolve ${usernameWithAt}: ${e.message}`)
            return null
        }
    }

    isAdmin(userId) {
        return config.adminUserIds.includes(userId)
    }
}

new AdminBot()
