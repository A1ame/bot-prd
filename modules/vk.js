/**
 * VK Bridge Module
 * Handles cross-posting between VK and Telegram:
 * 1. TG channel post → VK group wall
 * 2. VK group post → TG channel
 * 3. VK suggest (предложка) → TG admin moderation
 * 4. TG suggest approved → VK group wall
 */

const https = require("https")
const http = require("http")
const fs = require("fs")
const path = require("path")
const logger = require("../utils/logger")
const config = require("../config/config")

class VKBridge {
  constructor(bot) {
    this.bot = bot
    this.vkToken = config.vkToken
    this.vkGroupId = config.vkGroupId
    this.vkConfirmationCode = config.vkConfirmationCode
    this.vkSecretKey = config.vkSecretKey

    // Кэш для дедупликации (чтобы пост не зациклился TG→VK→TG)
    this.processedVkPosts = new Set()
    this.processedTgPosts = new Set()

    // Хранилище ожидающих предложений из ВК
    this.pendingVkSuggestions = new Map()

    // Polling интервал для ВК (fallback если нет webhook)
    this.pollingInterval = null
    this.lastVkPostId = null
    this.lastVkSuggestId = null
  }

  // ─────────────────────────────────────────────
  // VK API helper
  // ─────────────────────────────────────────────
  async vkApi(method, params = {}) {
    return new Promise((resolve, reject) => {
      const query = new URLSearchParams({
        ...params,
        access_token: this.vkToken,
        v: "5.131",
      }).toString()

      const options = {
        hostname: "api.vk.com",
        path: `/method/${method}?${query}`,
        method: "GET",
      }

      const req = https.request(options, (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => {
          try {
            const json = JSON.parse(data)
            if (json.error) {
              reject(new Error(`VK API error [${json.error.error_code}]: ${json.error.error_msg}`))
            } else {
              resolve(json.response)
            }
          } catch (e) {
            reject(e)
          }
        })
      })

      req.on("error", reject)
      req.end()
    })
  }

  // ─────────────────────────────────────────────
  // Скачать файл по URL и вернуть Buffer
  // ─────────────────────────────────────────────
  async downloadFile(url) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith("https") ? https : http
      const chunks = []
      protocol.get(url, (res) => {
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () => resolve(Buffer.concat(chunks)))
        res.on("error", reject)
      }).on("error", reject)
    })
  }

  // ─────────────────────────────────────────────
  // Загрузить фото на сервер ВК
  // ─────────────────────────────────────────────
  async uploadPhotoToVk(fileBuffer, filename = "photo.jpg") {
    try {
      // 1. Получаем сервер загрузки
      const uploadServer = await this.vkApi("photos.getWallUploadServer", {
        group_id: this.vkGroupId,
      })

      // 2. Загружаем файл
      const uploaded = await this.multipartUpload(uploadServer.upload_url, fileBuffer, filename)

      // 3. Сохраняем фото
      const saved = await this.vkApi("photos.saveWallPhoto", {
        group_id: this.vkGroupId,
        photo: uploaded.photo,
        server: uploaded.server,
        hash: uploaded.hash,
      })

      return `photo${saved[0].owner_id}_${saved[0].id}`
    } catch (error) {
      logger.error("Error uploading photo to VK:", error)
      return null
    }
  }

  // ─────────────────────────────────────────────
  // Multipart upload helper
  // ─────────────────────────────────────────────
  async multipartUpload(uploadUrl, fileBuffer, filename) {
    return new Promise((resolve, reject) => {
      const boundary = `----FormBoundary${Date.now()}`
      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`
      )
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`)
      const body = Buffer.concat([header, fileBuffer, footer])

      const url = new URL(uploadUrl)
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      }

      const protocol = url.protocol === "https:" ? https : http
      const req = protocol.request(options, (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
      })

      req.on("error", reject)
      req.write(body)
      req.end()
    })
  }

  // ─────────────────────────────────────────────
  // ПУБЛИКАЦИЯ В ВК (из Telegram)
  // ─────────────────────────────────────────────
  async postToVk(text, photoBuffers = [], fromTgPostId = null) {
    try {
      // Дедупликация
      if (fromTgPostId && this.processedTgPosts.has(fromTgPostId)) {
        logger.info(`TG post ${fromTgPostId} already processed, skipping VK post`)
        return null
      }

      const attachments = []

      // Загружаем фото
      for (const { buffer, filename } of photoBuffers) {
        const attachment = await this.uploadPhotoToVk(buffer, filename)
        if (attachment) attachments.push(attachment)
      }

      const params = {
        owner_id: `-${this.vkGroupId}`,
        from_group: 1,
        message: text || "",
        attachments: attachments.join(","),
      }

      const result = await this.vkApi("wall.post", params)

      if (fromTgPostId) {
        this.processedTgPosts.add(fromTgPostId)
        // Удаляем из кэша через 5 минут
        setTimeout(() => this.processedTgPosts.delete(fromTgPostId), 5 * 60 * 1000)
      }

      logger.info(`Posted to VK wall: post_id=${result.post_id}`)
      return result.post_id
    } catch (error) {
      logger.error("Error posting to VK:", error)
      return null
    }
  }

  // ─────────────────────────────────────────────
  // ПУБЛИКАЦИЯ В TELEGRAM (из VK)
  // ─────────────────────────────────────────────
  async postToTelegram(text, photoUrls = [], fromVkPostId = null) {
    try {
      const db = require("../database/database")
      const channels = await db.getChannels()

      if (channels.length === 0) {
        logger.warn("No Telegram channels configured, skipping VK→TG post")
        return
      }

      // Дедупликация
      if (fromVkPostId && this.processedVkPosts.has(fromVkPostId)) {
        logger.info(`VK post ${fromVkPostId} already processed, skipping TG post`)
        return
      }

      for (const channel of channels) {
        try {
          if (photoUrls.length === 0) {
            // Только текст
            await this.bot.sendMessage(channel.chat_id, text || "📌 Новый пост из ВКонтакте", {
              parse_mode: "HTML",
            })
          } else if (photoUrls.length === 1) {
            // Одно фото
            await this.bot.sendPhoto(channel.chat_id, photoUrls[0], {
              caption: text || "",
              parse_mode: "HTML",
            })
          } else {
            // Альбом
            const media = photoUrls.map((url, idx) => ({
              type: "photo",
              media: url,
              caption: idx === 0 ? (text || "") : undefined,
              parse_mode: "HTML",
            }))
            await this.bot.sendMediaGroup(channel.chat_id, media)
          }

          logger.info(`VK post published to TG channel ${channel.chat_id}`)
        } catch (err) {
          logger.error(`Error posting to TG channel ${channel.chat_id}:`, err)
        }
      }

      if (fromVkPostId) {
        this.processedVkPosts.add(fromVkPostId)
        setTimeout(() => this.processedVkPosts.delete(fromVkPostId), 5 * 60 * 1000)
      }
    } catch (error) {
      logger.error("Error posting to Telegram:", error)
    }
  }

  // ─────────────────────────────────────────────
  // ОБРАБОТКА НОВОГО ПОСТА В TG КАНАЛЕ → ВК
  // Вызывается из bot.js при handleChannelPost
  // ─────────────────────────────────────────────
  async handleTelegramChannelPost(msg) {
    try {
      const postKey = `tg_${msg.chat.id}_${msg.message_id}`
      if (this.processedTgPosts.has(postKey)) return
      this.processedTgPosts.add(postKey)
      setTimeout(() => this.processedTgPosts.delete(postKey), 5 * 60 * 1000)

      const text = msg.text || msg.caption || ""
      const photoBuffers = []

      if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1]
        try {
          const fileInfo = await this.bot.getFile(photo.file_id)
          const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${fileInfo.file_path}`
          const buffer = await this.downloadFile(fileUrl)
          photoBuffers.push({ buffer, filename: "photo.jpg" })
        } catch (err) {
          logger.error("Error downloading TG photo:", err)
        }
      }

      await this.postToVk(text, photoBuffers, postKey)
    } catch (error) {
      logger.error("Error in handleTelegramChannelPost:", error)
    }
  }

  // ─────────────────────────────────────────────
  // POLLING ВК — проверяем новые посты
  // ─────────────────────────────────────────────
  async pollVkWall() {
    try {
      const posts = await this.vkApi("wall.get", {
        owner_id: `-${this.vkGroupId}`,
        count: 5,
        filter: "owner",
      })

      if (!posts || !posts.items || posts.items.length === 0) return

      // Инициализируем lastVkPostId при первом запуске
      if (this.lastVkPostId === null) {
        this.lastVkPostId = posts.items[0].id
        logger.info(`VK wall polling initialized, last post ID: ${this.lastVkPostId}`)
        return
      }

      // Обрабатываем только новые посты (ID > lastVkPostId)
      const newPosts = posts.items.filter((p) => p.id > this.lastVkPostId)

      for (const post of newPosts.reverse()) {
        await this.handleNewVkPost(post)
        this.lastVkPostId = Math.max(this.lastVkPostId, post.id)
      }
    } catch (error) {
      logger.error("Error polling VK wall:", error)
    }
  }

  // ─────────────────────────────────────────────
  // POLLING ВК — проверяем предложку
  // ─────────────────────────────────────────────
  async pollVkSuggested() {
    try {
      const posts = await this.vkApi("wall.get", {
        owner_id: `-${this.vkGroupId}`,
        count: 10,
        filter: "suggests",
      })

      if (!posts || !posts.items || posts.items.length === 0) return

      if (this.lastVkSuggestId === null) {
        // При первом запуске — запоминаем все существующие
        posts.items.forEach((p) => this.pendingVkSuggestions.set(p.id, "known"))
        if (posts.items.length > 0) {
          this.lastVkSuggestId = Math.max(...posts.items.map((p) => p.id))
        } else {
          this.lastVkSuggestId = 0
        }
        logger.info(`VK suggests polling initialized, tracked ${posts.items.length} existing suggests`)
        return
      }

      const newSuggests = posts.items.filter(
        (p) => p.id > this.lastVkSuggestId && !this.pendingVkSuggestions.has(p.id)
      )

      for (const suggest of newSuggests.reverse()) {
        await this.handleNewVkSuggest(suggest)
        this.pendingVkSuggestions.set(suggest.id, "sent_to_admin")
        this.lastVkSuggestId = Math.max(this.lastVkSuggestId, suggest.id)
      }
    } catch (error) {
      // Если нет доступа к предложке — не ломаем polling
      if (!error.message.includes("15") && !error.message.includes("Access denied")) {
        logger.error("Error polling VK suggests:", error)
      }
    }
  }

  // ─────────────────────────────────────────────
  // Обработка нового поста на стене ВК → ТГ
  // ─────────────────────────────────────────────
  async handleNewVkPost(post) {
    try {
      logger.info(`New VK post detected: id=${post.id}`)

      const text = this.formatVkPostText(post)
      const photoUrls = this.extractVkPhotoUrls(post)

      await this.postToTelegram(text, photoUrls, `vk_${post.id}`)
    } catch (error) {
      logger.error("Error handling new VK post:", error)
    }
  }

  // ─────────────────────────────────────────────
  // Обработка новой предложки из ВК → ТГ админам
  // ─────────────────────────────────────────────
  async handleNewVkSuggest(post) {
    try {
      logger.info(`New VK suggest detected: id=${post.id}`)

      const text = this.formatVkPostText(post)
      const photoUrls = this.extractVkPhotoUrls(post)

      // Получаем инфо об авторе
      let authorInfo = "Неизвестный пользователь"
      if (post.from_id && post.from_id > 0) {
        try {
          const users = await this.vkApi("users.get", {
            user_ids: post.from_id,
            fields: "screen_name",
          })
          if (users && users.length > 0) {
            const u = users[0]
            authorInfo = `${u.first_name} ${u.last_name} (vk.com/${u.screen_name || u.id})`
          }
        } catch (e) {
          logger.error("Error getting VK user info:", e)
        }
      }

      const adminMessage =
        `📬 *Новое предложение из ВКонтакте*\n\n` +
        `👤 Автор: ${authorInfo}\n` +
        `🆔 ID поста в ВК: ${post.id}\n\n` +
        (text ? `📝 Текст:\n${text}\n\n` : "") +
        `Примите или отклоните публикацию:`

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Принять (ТГ + ВК)", callback_data: `vk_approve_${post.id}` },
              { text: "❌ Отклонить", callback_data: `vk_reject_${post.id}` },
            ],
          ],
        },
      }

      if (photoUrls.length === 0) {
        await this.bot.sendMessage(config.adminChatId, adminMessage, {
          parse_mode: "Markdown",
          ...keyboard,
        })
      } else if (photoUrls.length === 1) {
        await this.bot.sendPhoto(config.adminChatId, photoUrls[0], {
          caption: adminMessage,
          parse_mode: "Markdown",
          ...keyboard,
        })
      } else {
        // Отправляем альбом, потом отдельно кнопки
        const media = photoUrls.map((url, idx) => ({
          type: "photo",
          media: url,
          caption: idx === 0 ? (text || "") : undefined,
          parse_mode: "HTML",
        }))
        await this.bot.sendMediaGroup(config.adminChatId, media)
        await this.bot.sendMessage(config.adminChatId, adminMessage, {
          parse_mode: "Markdown",
          ...keyboard,
        })
      }

      // Сохраняем данные предложения для последующего принятия
      this.pendingVkSuggestions.set(post.id, {
        status: "pending",
        text: text,
        photoUrls: photoUrls,
        authorInfo: authorInfo,
        post: post,
      })
    } catch (error) {
      logger.error("Error handling new VK suggest:", error)
    }
  }

  // ─────────────────────────────────────────────
  // ПРИНЯТЬ предложение из ВК (callback от TG-бота)
  // ─────────────────────────────────────────────
  async approveVkSuggest(postId, callbackQuery) {
    try {
      const suggestionData = this.pendingVkSuggestions.get(postId)

      if (!suggestionData || typeof suggestionData === "string") {
        await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение не найдено" })
        return
      }

      // 1. Публикуем пост на стену ВК (подтверждаем предложку)
      let vkPostId = null
      try {
        const photoBuffers = []
        for (const url of suggestionData.photoUrls) {
          const buffer = await this.downloadFile(url)
          photoBuffers.push({ buffer, filename: "photo.jpg" })
        }
        vkPostId = await this.postToVk(suggestionData.text, photoBuffers)
      } catch (err) {
        logger.error("Error publishing VK suggest to wall:", err)
      }

      // 2. Публикуем в Telegram каналы
      await this.postToTelegram(
        suggestionData.text,
        suggestionData.photoUrls,
        `vk_suggest_${postId}`
      )

      // 3. Обновляем сообщение у админа
      await this.bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: "✅ ПРИНЯТО (ТГ + ВК)", callback_data: "noop" }]] },
        { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }
      )

      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "✅ Предложение опубликовано в ТГ и ВК!" })

      this.pendingVkSuggestions.delete(postId)

      logger.info(`VK suggest ${postId} approved and published`)
    } catch (error) {
      logger.error("Error approving VK suggest:", error)
      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка при публикации" })
    }
  }

  // ─────────────────────────────────────────────
  // ОТКЛОНИТЬ предложение из ВК
  // ─────────────────────────────────────────────
  async rejectVkSuggest(postId, callbackQuery) {
    try {
      // Удаляем пост из предложки ВК
      try {
        await this.vkApi("wall.delete", {
          owner_id: `-${this.vkGroupId}`,
          post_id: postId,
        })
      } catch (err) {
        logger.error("Error deleting VK suggest (may not have permission):", err)
      }

      await this.bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: "❌ ОТКЛОНЕНО", callback_data: "noop" }]] },
        { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }
      )

      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "❌ Предложение отклонено" })

      this.pendingVkSuggestions.delete(postId)

      logger.info(`VK suggest ${postId} rejected`)
    } catch (error) {
      logger.error("Error rejecting VK suggest:", error)
      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка при отклонении" })
    }
  }

  // ─────────────────────────────────────────────
  // Вспомогательные методы
  // ─────────────────────────────────────────────
  formatVkPostText(post) {
    let text = post.text || ""
    // Обрезаем до лимита Telegram caption (1024 символа)
    if (text.length > 1000) {
      text = text.substring(0, 997) + "..."
    }
    return text
  }

  extractVkPhotoUrls(post) {
    const urls = []
    if (!post.attachments) return urls

    for (const att of post.attachments) {
      if (att.type === "photo" && att.photo) {
        // Берём самый большой размер
        const sizes = att.photo.sizes || []
        const sorted = sizes.sort((a, b) => (b.width || 0) - (a.width || 0))
        if (sorted.length > 0) {
          urls.push(sorted[0].url)
        }
      }
    }
    return urls
  }

  // ─────────────────────────────────────────────
  // ЗАПУСК POLLING
  // ─────────────────────────────────────────────
  startPolling(intervalMs = 30000) {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval)
    }

    // Первая проверка через 5 секунд после старта
    setTimeout(async () => {
      await this.pollVkWall()
      await this.pollVkSuggested()
    }, 5000)

    this.pollingInterval = setInterval(async () => {
      await this.pollVkWall()
      await this.pollVkSuggested()
    }, intervalMs)

    logger.info(`VK polling started (interval: ${intervalMs}ms)`)
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval)
      this.pollingInterval = null
      logger.info("VK polling stopped")
    }
  }
}

module.exports = VKBridge
