const db = require("../database/database")
const keyboards = require("../utils/keyboards")
const logger = require("../utils/logger")
const config = require("../config/config")

class SuggestionsManager {
    constructor(bot, vkBridge = null) {
        this.bot = bot
        this.vkBridge = vkBridge
        this.userStates = new Map()
        this.mediaGroupCache = new Map()
        this.cancelMessages = new Map()
        this.lastUserChannels = new Map() // Храним последний выбранный канал для каждого пользователя
    }

    // Исправляем метод handleForwardToMainAdmin
    async handleForwardToMainAdmin(callbackQuery) {
            try {
                const data = callbackQuery.data;
                const parts = data.split("_");
                const suggestionId = parts[4]; // Используем тот же индекс

                const suggestion = await db.getSuggestion(suggestionId);

                if (!suggestion) {
                    await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение не найдено" });
                    return;
                }

                // ... остальной код без изменений


            // Отправляем сообщение пользователю
            try {
                await this.bot.sendMessage(
                    suggestion.user_id,
                    "Поэтому вопросу обращайтесь к главному админу @ktozachemi",
                    { reply_to_message_id: suggestion.original_message_id }
                );
            } catch (error) {
                await this.bot.sendMessage(
                    suggestion.user_id,
                    "Поэтому вопросу обращайтесь к главному админу @ktozachemi"
                );
            }

            // Обновляем статус в админском чате
            await this.bot.editMessageReplyMarkup(
                { inline_keyboard: [[{ text: "➡️ ОТПРАВЛЕНО К ГЛАВНОМУ АДМИНУ", callback_data: "noop" }]] },
                { chat_id: config.adminChatId, message_id: suggestion.admin_message_id }
            );

            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Пользователь направлен к главному админу!" });
            } catch (error) {
                logger.error("Error forwarding to main admin:", error);
                await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка при выполнении действия" });
            }
    }



    async handleStartForSuggestions(msg, channelId) {
        try {
            const userId = msg.from.id
            const chatId = msg.chat.id
            const fullChannelId = `-${channelId}`

            // Сохраняем последний выбранный канал пользователя
            this.lastUserChannels.set(userId, fullChannelId)

            this.userStates.set(userId, {
                action: "waiting_suggestion",
                targetChannelId: fullChannelId,
                chatId: chatId,
            })

            const channels = await db.getChannels()
            const channel = channels.find((ch) => ch.chat_id === fullChannelId)

            if (!channel || !channel.suggestions_enabled) {
                await this.bot.sendMessage(chatId, "❌ Канал не найден или предложения отключены.")
                return
            }

            const sentMessage = await this.bot.sendMessage(
                chatId,
                `📝 *Предложить контент в канал*\n\n` +
                `📍 Вы отправляете сообщение в канал *${channel.title || channel.username}*\n\n` +
                `⚠️ Ваше предложение будет отправлено на модерацию администраторам.\n\n` +
                `Теперь вы можете просто отправлять сообщения - они будут автоматически направляться в этот канал.\n` +
                `Используйте /mysuggest чтобы изменить канал или посмотреть текущий.\n\n` +
                `created by • [elscripts](https://t.me/wwhyumadbro)`,
                {
                    parse_mode: "Markdown",
                    disable_web_page_preview: true,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "❌ Отменить", callback_data: "cancel_suggestion" }],
                        ],
                    },
                },
            )
            this.cancelMessages.set(userId, sentMessage.message_id)
        } catch (error) {
            logger.error("Error handling start for suggestions:", error)
        }
    }

    // Новый метод: обработка команды /mysuggest
    async handleMySuggestCommand(msg) {
        try {
            const userId = msg.from.id
            const lastChannelId = this.lastUserChannels.get(userId)

            if (!lastChannelId) {
                await this.bot.sendMessage(
                    msg.chat.id,
                    "🤔 Вы еще не выбирали канал для предложений.\n\n" +
                    "Используйте ссылку из канала, куда хотите предложить контент, или попросите администратора предоставить ссылку."
                )
                return
            }

            const channels = await db.getChannels()
            const channel = channels.find((ch) => ch.chat_id === lastChannelId)

            if (!channel) {
                await this.bot.sendMessage(msg.chat.id, "❌ Канал не найден. Используйте новую ссылку.")
                this.lastUserChannels.delete(userId)
                return
            }

            const botInfo = await this.bot.getMe()
            const cleanChannelId = channel.chat_id.startsWith('-') ? channel.chat_id.slice(1) : channel.chat_id
            const suggestLink = `https://t.me/${botInfo.username}?start=${cleanChannelId}_channel`

            await this.bot.sendMessage(
                msg.chat.id,
                `📋 *Текущий канал для предложений:*\n\n` +
                `📍 ${channel.title || channel.username}\n` +
                `🔗 ${channel.username || `ID: ${cleanChannelId}`}\n\n` +
                `✏️ Просто отправляйте сообщения - они будут автоматически направляться в этот канал.\n\n` +
                `🔄 Чтобы изменить канал, используйте другую ссылку:\n` +
                `${suggestLink}\n\n` +
                `📝 Или попросите администратора предоставить ссылку для другого канала.`,
                {
                    parse_mode: "Markdown",
                    disable_web_page_preview: true
                }
            )

        } catch (error) {
            logger.error("Error handling /mysuggest command:", error)
        }
    }

    async handlePrivateSuggestion(msg) {
        try {
            const userId = msg.from.id

            // Проверяем бан
            const isBanned = await db.isUserBanned(userId)
            if (isBanned) {
                await this.bot.sendMessage(msg.chat.id, "🚫 Вы заблокированы и не можете отправлять предложения.")
                return
            }

            // Проверяем, есть ли сохраненный канал для пользователя
            const lastChannelId = this.lastUserChannels.get(userId)

            // Если есть сохраненный канал, используем его
            if (lastChannelId) {
                const channels = await db.getChannels()
                const channel = channels.find((ch) => ch.chat_id === lastChannelId)

                if (channel && channel.suggestions_enabled) {
                    // Создаем временную сессию для обработки сообщения
                    this.userStates.set(userId, {
                        action: "waiting_suggestion",
                        targetChannelId: lastChannelId,
                        chatId: msg.chat.id,
                    })
                }
            }

            const userState = this.userStates.get(userId)
            if (!userState || userState.action !== "waiting_suggestion") {
                // Если нет активной сессии и нет сохраненного канала
                if (!lastChannelId) {
                    await this.bot.sendMessage(
                        msg.chat.id,
                        "🤔 Сначала выберите канал для предложений!\n\n" +
                        "Используйте ссылку из канала, куда хотите предложить контент, или попросите администратора предоставить ссылку.\n\n" +
                        "Пример ссылки: https://t.me/YourBotName?start=12345_channel"
                    )
                }
                return
            }

            const username = msg.from.username || msg.from.first_name
            const targetChannelId = userState.targetChannelId
            const channels = await db.getChannels()
            const channel = channels.find((ch) => ch.chat_id === targetChannelId)

            if (!channel) {
                await this.bot.sendMessage(msg.chat.id, "❌ Канал не найден. Используйте новую ссылку.")
                this.userStates.delete(userId)
                this.lastUserChannels.delete(userId)
                return
            }

            if (msg.media_group_id) {
                if (!this.mediaGroupCache.has(msg.media_group_id)) {
                    this.mediaGroupCache.set(msg.media_group_id, { userId, username, chatId: msg.chat.id, channel, messages: [] })
                    setTimeout(async () => {
                        const groupData = this.mediaGroupCache.get(msg.media_group_id)
                        if (!groupData) return
                        await this._forwardAlbum(groupData, true)
                        this.mediaGroupCache.delete(msg.media_group_id)
                    }, 1500)
                }
                this.mediaGroupCache.get(msg.media_group_id).messages.push(msg)
                return
            }

            await this._forwardPrivateSingleSuggestion(msg, userId, username, channel)
            this.userStates.delete(userId)
        } catch (error) {
            logger.error("Error handling private suggestion:", error)
        }
    }

    // Остальные методы остаются без изменений
    async handleSuggestion(msg) {
        try {
            const userId = msg.from.id
            const username = msg.from.username || msg.from.first_name
            const chatId = msg.chat.id.toString()

            const channels = await db.getChannels()
            const channel = channels.find((ch) => ch.chat_id === chatId && ch.suggestions_enabled)
            if (!channel) return

            if (msg.media_group_id) {
                if (!this.mediaGroupCache.has(msg.media_group_id)) {
                    this.mediaGroupCache.set(msg.media_group_id, { userId, username, chatId, channel, messages: [] })
                    setTimeout(async () => {
                        const groupData = this.mediaGroupCache.get(msg.media_group_id)
                        if (!groupData) return
                        await this._forwardAlbum(groupData)
                        this.mediaGroupCache.delete(msg.media_group_id)
                    }, 1500)
                }
                this.mediaGroupCache.get(msg.media_group_id).messages.push(msg)
                return
            }

            await this._forwardSingleSuggestion(msg, userId, username, chatId, channel)
        } catch (error) {
            logger.error("Error handling suggestion:", error)
        }
    }

    _getContentType(msg) {
        if (msg.photo) return "photo"
        if (msg.video) return "video"
        if (msg.document) return "document"
        if (msg.audio) return "audio"
        if (msg.voice) return "voice"
        if (msg.sticker) return "sticker"
        if (msg.animation) return "animation"
        return "text"
    }

    async _forwardSingleSuggestion(msg, userId, username, chatId, channel) {
        const contentType = this._getContentType(msg)

        if (msg.text === "/start") return

        const suggestionId = await db.addSuggestion(
            userId,
            username,
            chatId,
            msg.message_id,
            contentType,
            null,
            null,
            msg.text || msg.caption || null,
        );

        const cleanChannelId = channel.chat_id.startsWith('-') ? channel.chat_id.slice(1) : channel.chat_id
        const replyMarkup = keyboards.suggestionActions(suggestionId, cleanChannelId).reply_markup

        if (contentType === "text") {
            const adminMessage = await this.bot.sendMessage(
                config.adminChatId,
                `📝 Новое предложение #${suggestionId}\n👤 От: @${username} (${userId})\n📍 Канал: ${channel.title || channel.username}\n\n${msg.text}`,
                { reply_markup: replyMarkup }
            )
            await db.updateSuggestionStatus(suggestionId, "pending", adminMessage.message_id)
        } else {
            const adminMessage = await this.bot.copyMessage(
                config.adminChatId,
                chatId,
                msg.message_id,
                {
                    caption: `📝 Новое предложение #${suggestionId}\n👤 От: @${username} (${userId})\n📍 Канал: ${channel.title || channel.username}\n\n${msg.caption || ""}`,
                    reply_markup: replyMarkup
                }
            )
            await db.updateSuggestionStatus(suggestionId, "pending", adminMessage.message_id)
        }

        this.userStates.delete(userId)
        const cancelMessageId = this.cancelMessages.get(userId)
        if (cancelMessageId) {
            try {
                await this.bot.deleteMessage(msg.chat.id, cancelMessageId)
            } catch (error) {
            }
            this.cancelMessages.delete(userId)
        }

        await this.bot.sendMessage(userId, "✅ Ваше сообщение отправлено на модерацию!", {
            reply_to_message_id: msg.message_id
        });
    }

    async _forwardPrivateSingleSuggestion(msg, userId, username, channel) {
        const contentType = this._getContentType(msg)

        if (msg.text === "/start" || msg.text === "/mysuggest") return

        const suggestionId = await db.addSuggestion(
            userId,
            username,
            channel.chat_id,
            msg.message_id,
            contentType,
            msg.chat.id,
            null,
            msg.text || msg.caption || null
        )

        const cleanChannelId = channel.chat_id.startsWith('-') ? channel.chat_id.slice(1) : channel.chat_id
        const replyMarkup = keyboards.suggestionActions(suggestionId, cleanChannelId).reply_markup

        if (contentType === "text") {
            const adminMessage = await this.bot.sendMessage(
                config.adminChatId,
                `📝 Новое предложение #${suggestionId}\n👤 От: @${username} (${userId})\n📍 Канал: ${channel.title || channel.username}\n\n${msg.text}`,
                { reply_markup: replyMarkup }
            )
            await db.updateSuggestionWithMessageInfo(suggestionId, "pending", adminMessage.message_id, msg.chat.id, msg.message_id)
        } else {
            const adminMessage = await this.bot.copyMessage(config.adminChatId, msg.chat.id, msg.message_id, {
                caption: `📝 Новое предложение #${suggestionId}\n👤 От: @${username} (${userId})\n📍 Канал: ${channel.title || channel.username}\n\n${msg.caption || ""}`,
                reply_markup: replyMarkup
            })
            await db.updateSuggestionWithMessageInfo(suggestionId, "pending", adminMessage.message_id, msg.chat.id, msg.message_id)
        }

        const cancelMessageId = this.cancelMessages.get(userId)
        if (cancelMessageId) {
            try {
                await this.bot.deleteMessage(msg.chat.id, cancelMessageId)
            } catch (error) {
            }
            this.cancelMessages.delete(userId)
        }

        try {
            await this.bot.sendMessage(userId, "✅ Ваше сообщение отправлено на модерацию!", {
                reply_to_message_id: msg.message_id
            });
        } catch(error) {
            await this.bot.sendMessage(userId, "✅ Ваше сообщение отправлено на модерацию!");
        }
    }

    async handleCancelSuggestion(callbackQuery) {
        try {
            const userId = callbackQuery.from.id
            const chatId = callbackQuery.message.chat.id

            this.userStates.delete(userId)

            const cancelMessageId = this.cancelMessages.get(userId)
            if (cancelMessageId) {
                try {
                    await this.bot.deleteMessage(chatId, cancelMessageId)
                } catch (error) {
                }
                this.cancelMessages.delete(userId)
            }

            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение отменено" })
        } catch (error) {
            logger.error("Error handling cancel suggestion:", error)
        }
    }

    async _forwardAlbum(groupData, isPrivate = false) {
        const { userId, username, chatId, channel, messages } = groupData

        const media = messages
            .map((m) => {
                if (m.photo) return { type: "photo", media: m.photo[m.photo.length - 1].file_id }
                if (m.video) return { type: "video", media: m.video.file_id }
                return null
            })
            .filter(Boolean)

        const userText = messages[0].caption || ""

        const suggestionId = await db.addSuggestion(
            userId,
            username,
            channel.chat_id,
            messages[0].message_id,
            "album",
            isPrivate ? chatId : null,
            media.map((m) => m.media),
            messages[0].caption || ""
        )

        const cleanChannelId = channel.chat_id.startsWith('-') ? channel.chat_id.slice(1) : channel.chat_id
        const replyMarkup = keyboards.suggestionActions(suggestionId, cleanChannelId).reply_markup

        const adminGroup = await this.bot.sendMediaGroup(
            config.adminChatId,
            media.map((m, idx) => ({
                ...m,
                caption: idx === 0 ? userText : undefined
            }))
        )

        const adminControls = await this.bot.sendMessage(
            config.adminChatId,
            `📝 Новое предложение #${suggestionId}\n👤 От: @${username} (${userId})\n📍 Канал: ${channel.title || channel.username}\n\n${userText}`,
            {
                reply_to_message_id: adminGroup[0].message_id,
                reply_markup: replyMarkup
            }
        )

        await db.updateSuggestionWithMessageInfo(
            suggestionId,
            "pending",
            adminControls.message_id,
            chatId,
            messages[0].message_id
        )

        try {
            await this.bot.sendMessage(userId, "✅ Ваше сообщение отправлено на модерацию!", {
                reply_to_message_id: messages[0].message_id
            });
        } catch(error) {
            await this.bot.sendMessage(userId, "✅ Ваше сообщение отправлено на модерацию!");
        }
    }

    async handleSuggestionAction(callbackQuery) {
        try {
            const data = callbackQuery.data;
            console.log("Callback data:", data);
            const channels = await db.getChannels();

            if (data.startsWith("approve_guide_")) {
                const parts = data.split("_");
                console.log("Approve guide parts:", parts);
                const suggestionId = parts[2];
                const channelIdFromButton = parts[3];

                const suggestion = await db.getSuggestion(suggestionId);
                if (!suggestion) {
                    await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение не найдено" });
                    return;
                }

                const channel = channels.find(ch => {
                    const chId = ch.chat_id.startsWith('-') ? ch.chat_id.slice(1) : ch.chat_id;
                    return chId === channelIdFromButton;
                });

                if (!channel) {
                    await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Канал для предложения не найден!" });
                    return;
                }

                await this.approveSuggestionWithGuide(suggestion, channel, callbackQuery);
                return;
            }

            // Обработка forward_to_main_admin
            if (data.startsWith("forward_to_main_admin_")) {
                const parts = data.split("_");
                console.log("Parts:", parts);
                const suggestionId = parts[4];
                console.log("Suggestion ID:", suggestionId);

                const suggestion = await db.getSuggestion(suggestionId);
                console.log("Found suggestion:", suggestion);

                if (!suggestion) {
                    await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение не найдено" });
                    return;
                }

                await this.handleForwardToMainAdmin(callbackQuery);
                return;
            }

            // Обработка остальных действий (approve, reject, ban)
            const [action, suggestionId] = data.split("_");
            const suggestion = await db.getSuggestion(suggestionId);
            if (!suggestion) {
                await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение не найдено" });
                return;
            }

            const channel = channels.find(ch => {
                const chId = ch.chat_id.startsWith('-') ? ch.chat_id.slice(1) : ch.chat_id;
                const sugId = suggestion.chat_id.startsWith('-') ? suggestion.chat_id.slice(1) : suggestion.chat_id;
                return chId === sugId;
            });

            if (!channel) {
                await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Канал для предложения не найден!" });
                return;
            }

            switch (action) {
                case "approve":
                    await this.approveSuggestion(suggestion, channel, callbackQuery);
                    break;
                case "reject":
                    await this.rejectSuggestion(suggestion, callbackQuery);
                    break;
                case "ban":
                    await this.banSuggestionAuthor(suggestion, channel, callbackQuery);
                    break;
            }

        } catch (error) {
            console.error("Error handling suggestion action:", error);
            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Произошла ошибка" });
        }
    }

    // Отправить одобренное предложение в ВК
    async _postSuggestionToVk(suggestion, extraText = "") {
        if (!this.vkBridge) return
        try {
            const text = (suggestion.caption || "") + (extraText ? "\n\n" + extraText : "")
            const photoBuffers = []

            if (suggestion.content_type === "album" && suggestion.file_ids) {
                for (const fileId of suggestion.file_ids) {
                    try {
                        const fileInfo = await this.bot.getFile(fileId)
                        const fileUrl = `https://api.telegram.org/file/bot${require("../config/config").botToken}/${fileInfo.file_path}`
                        const buffer = await this.vkBridge.downloadFile(fileUrl)
                        photoBuffers.push({ buffer, filename: "photo.jpg" })
                    } catch (e) {
                        logger.error("_postSuggestionToVk: error downloading album photo:", e)
                    }
                }
            } else if (suggestion.content_type === "photo" && suggestion.original_message_id && suggestion.original_chat_id) {
                try {
                    // Получаем file_id из оригинального сообщения через forwardMessage trick
                    const fwd = await this.bot.forwardMessage(require("../config/config").adminChatId, suggestion.original_chat_id, suggestion.original_message_id)
                    if (fwd.photo) {
                        const photo = fwd.photo[fwd.photo.length - 1]
                        const fileInfo = await this.bot.getFile(photo.file_id)
                        const fileUrl = `https://api.telegram.org/file/bot${require("../config/config").botToken}/${fileInfo.file_path}`
                        const buffer = await this.vkBridge.downloadFile(fileUrl)
                        photoBuffers.push({ buffer, filename: "photo.jpg" })
                        // Удаляем пересланное сообщение
                        try { await this.bot.deleteMessage(require("../config/config").adminChatId, fwd.message_id) } catch(e) {}
                    }
                } catch (e) {
                    logger.error("_postSuggestionToVk: error forwarding photo:", e)
                }
            }

            const dedupeKey = `suggest_approved_${suggestion.id}`
            await this.vkBridge.postToVk(text, photoBuffers, dedupeKey)
            logger.info(`Suggestion #${suggestion.id} posted to VK`)
        } catch (error) {
            logger.error("_postSuggestionToVk error:", error)
        }
    }

    async approveSuggestionWithGuide(suggestion, channel, callbackQuery) {
        try {
            const cleanChannelId = channel.chat_id.startsWith('-') ? channel.chat_id.slice(1) : channel.chat_id;
            const suggestLink = `https://t.me/${config.botName}?start=${cleanChannelId}_channel`;
            const textToSend = (suggestion.caption || "") +`\n\n📒 Хочешь чтобы твое сообщение попало в канал, пиши сюда <a href="${suggestLink}">сюда</a>\n Эту ссылку так же можно найти в описании канала`;

            if (suggestion.content_type === "album" && suggestion.file_ids) {
                const media = suggestion.file_ids.map((file_id, idx) => ({
                    type: "photo",
                    media: file_id,
                    caption: idx === 0 ? textToSend : undefined,
                    parse_mode: "HTML"
                }));
                await this.bot.sendMediaGroup(suggestion.chat_id, media);
            } else if (suggestion.content_type === "text") {
                await this.bot.sendMessage(suggestion.chat_id, textToSend, {
                    parse_mode: "HTML",
                });
            } else {
                await this.bot.copyMessage(
                    suggestion.chat_id,
                    suggestion.original_chat_id,
                    suggestion.original_message_id,
                    { caption: textToSend, parse_mode: "HTML" }
                );
            }

            await db.updateSuggestionStatus(suggestion.id, "approved");

            await this.bot.editMessageReplyMarkup(
                { inline_keyboard: [[{ text: "✅ ОДОБРЕНО С ГАЙДОМ", callback_data: "noop" }]] },
                { chat_id: config.adminChatId, message_id: suggestion.admin_message_id }
            );

            try {
                await this.bot.sendMessage(suggestion.user_id, "✅ Ваше предложение было одобрено и опубликовано!", {
                    reply_to_message_id: suggestion.original_message_id
                });
            } catch(error) {
                await this.bot.sendMessage(suggestion.user_id, "✅ Ваше предложение было одобрено и опубликовано!");
            }

            // Публикуем в ВК
            await this._postSuggestionToVk(suggestion)
            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение одобрено с гайдом!" });
        } catch (error) {
            console.error("Error approving suggestion with guide:", error);
            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка при одобрении с гайдом" });
        }
    }

    async approveSuggestion(suggestion, channel, callbackQuery) {
        try {
            if (suggestion.content_type === "album" && suggestion.file_ids) {
                const media = suggestion.file_ids.map((file_id, idx) => ({
                    type: "photo",
                    media: file_id,
                    caption: idx === 0 ? suggestion.caption || "" : undefined
                }));
                await this.bot.sendMediaGroup(suggestion.chat_id, media);
            } else if (suggestion.content_type === "text") {
                await this.bot.sendMessage(suggestion.chat_id, suggestion.caption || "");
            } else {
                await this.bot.copyMessage(
                    suggestion.chat_id,
                    suggestion.original_chat_id,
                    suggestion.original_message_id,
                    { caption: suggestion.caption || "" }
                );
            }

            await db.updateSuggestionStatus(suggestion.id, "approved");

            await this.bot.editMessageReplyMarkup(
                { inline_keyboard: [[{ text: "✅ ОДОБРЕНО", callback_data: "noop" }]] },
                { chat_id: config.adminChatId, message_id: suggestion.admin_message_id }
            );

            try {
                await this.bot.sendMessage(suggestion.user_id, "✅ Ваше предложение было одобрено и опубликовано!", {
                    reply_to_message_id: suggestion.original_message_id
                });
            } catch(error) {
                await this.bot.sendMessage(suggestion.user_id, "✅ Ваше предложение было одобрено и опубликовано!");
            }

            // Публикуем в ВК
            await this._postSuggestionToVk(suggestion)
            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение одобрено!" });
        } catch (error) {
            logger.error("Error approving suggestion:", error);
            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка при одобрении" });
        }
    }

    async rejectSuggestion(suggestion, callbackQuery) {
        try {
            await db.updateSuggestionStatus(suggestion.id, "rejected");

            await this.bot.editMessageReplyMarkup(
                { inline_keyboard: [[{ text: "❌ ОТКЛОНЕНО", callback_data: "noop" }]] },
                { chat_id: config.adminChatId, message_id: suggestion.admin_message_id }
            );

            try {
                await this.bot.sendMessage(suggestion.user_id, "❌ Ваше предложение было отклонено администрацией.", {
                    reply_to_message_id: suggestion.original_message_id
                });
            } catch(error) {
                await this.bot.sendMessage(suggestion.user_id, "❌ Ваше предложение было отклонено администрацией.");
            }

            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение отклонено!" });
        } catch (error) {
            logger.error("Error rejecting suggestion:", error);
            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка при отклонении" });
        }
    }

    async banSuggestionAuthor(suggestion, channel, callbackQuery) {
        try {
            // Баним пользователя в боте (через БД) — он больше не сможет писать боту
            const usernameToSave = suggestion.username ? suggestion.username.replace("@", "").toLowerCase() : null
            await db.banUser(suggestion.user_id, usernameToSave);
            await db.updateSuggestionStatus(suggestion.id, "banned");

            await this.bot.editMessageReplyMarkup(
                { inline_keyboard: [[{ text: "🚫 АВТОР ЗАБАНЕН В БОТЕ", callback_data: "noop" }]] },
                { chat_id: config.adminChatId, message_id: suggestion.admin_message_id }
            );

            try {
                await this.bot.sendMessage(
                    suggestion.user_id,
                    `🚫 Вы заблокированы и больше не можете отправлять предложения.`
                );
            } catch (error) { /* пользователь мог заблокировать бота */ }

            // Кнопка разбана в сообщении админа
            try {
                await this.bot.editMessageReplyMarkup(
                    {
                        inline_keyboard: [[
                            { text: "🚫 АВТОР ЗАБАНЕН В БОТЕ", callback_data: "noop" },
                            { text: "🔓 Разбанить", callback_data: `unban_bot_${suggestion.user_id}` }
                        ]]
                    },
                    { chat_id: config.adminChatId, message_id: suggestion.admin_message_id }
                )
            } catch (e) {}

            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "🚫 Автор забанен в боте!" });
        } catch (error) {
            logger.error("Error banning suggestion author:", error);
            await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка при бане" });
        }
    }
}

module.exports = SuggestionsManager