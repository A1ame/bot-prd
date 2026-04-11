/**
 * VK Bridge Module
 *
 * Механизм работы:
 * 1. TG канал → новый пост → публикуется на стену ВК
 * 2. ВК стена → новый пост (wall_post_new) → дублируется в TG каналы  [через Long Poll]
 * 3. ВК предложка (post_type=suggest) → уведомление TG админу         [через Long Poll]
 * 4. Админ принимает в TG → публикует пост в ВК + дублирует в TG
 *
 * ВАЖНО: wall.get требует пользовательский токен — polling не используется.
 * Всё работает через groups.getLongPollServer (групповой токен).
 * Требования к токену: стена (wall) + управление сообществом (manage)
 * Long Poll события: "Записи на стене → Добавление" должно быть включено.
 */

const https = require("https")
const http = require("http")
const logger = require("../utils/logger")
const config = require("../config/config")

class VKBridge {
  constructor(bot) {
    this.bot = bot
    this.vkToken = config.vkToken
    this.vkGroupId = config.vkGroupId

    // Дедупликация
    this.processedVkPosts = new Set()
    this.processedTgPosts = new Set()

    // Предложения из ВК, ожидающие решения
    this.pendingVkSuggestions = new Map()
    this.handledSuggestIds = new Set()

    // Long Poll
    this.lpServer = null
    this.lpKey = null
    this.lpTs = null
    this.lpRunning = false

    // Статистика (для отладки)
    this._stats = { eventsReceived: 0, wallPostsNew: 0, suggestsNew: 0, tgPosts: 0, vkPosts: 0 }
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
  // HTTP GET (для Long Poll)
  // ─────────────────────────────────────────────
  async httpGet(url) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const protocol = parsed.protocol === "https:" ? https : http

      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "GET",
        timeout: 35000,
      }

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
      req.on("timeout", () => {
        req.destroy()
        reject(new Error("Long Poll request timeout"))
      })
      req.end()
    })
  }

  // ─────────────────────────────────────────────
  // Скачать файл → Buffer
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
  // Загрузить фото на стену ВК
  // ─────────────────────────────────────────────
  async uploadPhotoToVk(fileBuffer, filename = "photo.jpg") {
    try {
      const uploadServer = await this.vkApi("photos.getWallUploadServer", { group_id: this.vkGroupId })
      const uploaded = await this.multipartUpload(uploadServer.upload_url, fileBuffer, filename)
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
          try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
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
  async postToVk(text, photoBuffers = [], dedupeKey = null) {
    try {
      if (dedupeKey && this.processedTgPosts.has(dedupeKey)) {
        logger.info(`postToVk: already processed ${dedupeKey}, skip`)
        return null
      }

      const attachments = []
      for (const { buffer, filename } of photoBuffers) {
        const att = await this.uploadPhotoToVk(buffer, filename)
        if (att) attachments.push(att)
      }

      const params = {
        owner_id: `-${this.vkGroupId}`,
        from_group: 1,
        message: text || "",
      }
      if (attachments.length > 0) params.attachments = attachments.join(",")

      const result = await this.vkApi("wall.post", params)

      if (dedupeKey) {
        this.processedTgPosts.add(dedupeKey)
        // Пометить VK post чтобы Long Poll не вернул его в TG
        this.processedVkPosts.add(String(result.post_id))
        setTimeout(() => {
          this.processedTgPosts.delete(dedupeKey)
          this.processedVkPosts.delete(String(result.post_id))
        }, 10 * 60 * 1000)
      }

      this._stats.vkPosts++
      logger.info(`Posted to VK wall: post_id=${result.post_id} | total vk posts: ${this._stats.vkPosts}`)
      return result.post_id
    } catch (error) {
      logger.error("Error posting to VK:", error)
      return null
    }
  }

  // ─────────────────────────────────────────────
  // ПУБЛИКАЦИЯ В TELEGRAM (из VK)
  // ─────────────────────────────────────────────
  async postToTelegram(text, photoUrls = [], dedupeKey = null) {
    try {
      const db = require("../database/database")
      const channels = await db.getChannels()

      if (channels.length === 0) {
        logger.warn("postToTelegram: no TG channels configured")
        return
      }

      const key = dedupeKey !== null ? String(dedupeKey) : null
      if (key && this.processedVkPosts.has(key)) {
        logger.info(`postToTelegram: already processed key=${key}, skip`)
        return
      }

      for (const channel of channels) {
        try {
          if (photoUrls.length === 0) {
            await this.bot.sendMessage(channel.chat_id, text || "Новый пост из ВКонтакте", { parse_mode: "HTML" })
          } else if (photoUrls.length === 1) {
            await this.bot.sendPhoto(channel.chat_id, photoUrls[0], { caption: text || "", parse_mode: "HTML" })
          } else {
            const media = photoUrls.slice(0, 10).map((url, idx) => ({
              type: "photo",
              media: url,
              caption: idx === 0 ? (text || "") : undefined,
              parse_mode: "HTML",
            }))
            await this.bot.sendMediaGroup(channel.chat_id, media)
          }
          logger.info(`VK->TG: posted to channel ${channel.chat_id}`)
        } catch (err) {
          logger.error(`VK->TG: error posting to channel ${channel.chat_id}:`, err)
        }
      }

      if (key) {
        this.processedVkPosts.add(key)
        setTimeout(() => this.processedVkPosts.delete(key), 10 * 60 * 1000)
      }

      this._stats.tgPosts++
    } catch (error) {
      logger.error("Error in postToTelegram:", error)
    }
  }

  // ─────────────────────────────────────────────
  // TG канал → новый пост → в ВК
  // ─────────────────────────────────────────────
  async handleTelegramChannelPost(msg) {
    try {
      logger.info(`TG->VK: handleTelegramChannelPost called, chat_id=${msg.chat.id}, msg_id=${msg.message_id}`)

      const postKey = `tg_${msg.chat.id}_${msg.message_id}`
      if (this.processedTgPosts.has(postKey)) {
        logger.info(`TG->VK: duplicate, skip postKey=${postKey}`)
        return
      }
      this.processedTgPosts.add(postKey)
      setTimeout(() => this.processedTgPosts.delete(postKey), 10 * 60 * 1000)

      const text = msg.text || msg.caption || ""
      const photoBuffers = []

      if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1]
        try {
          const fileInfo = await this.bot.getFile(photo.file_id)
          const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${fileInfo.file_path}`
          const buffer = await this.downloadFile(fileUrl)
          photoBuffers.push({ buffer, filename: "photo.jpg" })
          logger.info(`TG->VK: downloaded photo for msg_id=${msg.message_id}`)
        } catch (err) {
          logger.error("handleTelegramChannelPost: error downloading photo:", err)
        }
      }

      logger.info(`TG->VK: calling postToVk, text_len=${text.length}, photos=${photoBuffers.length}`)
      const result = await this.postToVk(text, photoBuffers, postKey)
      logger.info(`TG->VK: postToVk result=${result}`)
    } catch (error) {
      logger.error("Error in handleTelegramChannelPost:", error)
    }
  }

  // ─────────────────────────────────────────────
  // LONG POLL — получить сервер
  // ─────────────────────────────────────────────
  async getLongPollServer() {
    const response = await this.vkApi("groups.getLongPollServer", { group_id: this.vkGroupId })
    this.lpServer = response.server
    this.lpKey = response.key
    this.lpTs = response.ts
    logger.info(`VK Long Poll server obtained: ts=${this.lpTs}`)
  }

  // ─────────────────────────────────────────────
  // LONG POLL — один запрос
  // ─────────────────────────────────────────────
  async longPollRequest() {
    const url = `${this.lpServer}?act=a_check&key=${this.lpKey}&ts=${this.lpTs}&wait=25`
    const data = await this.httpGet(url)

    if (data.ts) this.lpTs = data.ts

    if (data.failed) {
      if (data.failed === 1) {
        this.lpTs = data.ts
        logger.warn("VK Long Poll: ts expired, updated")
      } else if (data.failed === 2 || data.failed === 3) {
        logger.warn(`VK Long Poll: failed=${data.failed}, re-fetching server...`)
        await this.getLongPollServer()
      }
      return
    }

    if (data.updates && data.updates.length > 0) {
      this._stats.eventsReceived += data.updates.length
      logger.info(`VK Long Poll: received ${data.updates.length} event(s). Types: ${data.updates.map(u => u.type).join(", ")}`)
      for (const update of data.updates) {
        await this.handleVkUpdate(update)
      }
    }
  }

  // ─────────────────────────────────────────────
  // LONG POLL — обработка события
  // ─────────────────────────────────────────────
  async handleVkUpdate(update) {
    try {
      const type = update.type
      const obj = update.object

      // Логируем ВСЕ входящие события для отладки
      logger.info(`VK event: type=${type} | object keys: ${Object.keys(obj || {}).join(",")}`)

      if (type === "wall_post_new") {
        // В VK Long Poll API объект может быть либо { post: {...} } либо сам пост
        const post = (obj && obj.post) ? obj.post : obj

        logger.info(`VK wall_post_new: post_id=${post.id}, post_type=${post.post_type}, from_id=${post.from_id}`)

        // Пост опубликован нами — пропускаем (нет петли TG→VK→TG)
        if (this.processedVkPosts.has(String(post.id))) {
          logger.info(`VK Long Poll: skip own post id=${post.id}`)
          return
        }

        if (post.post_type === "suggest") {
          // Предложенный пост
          this._stats.suggestsNew++
          if (!this.handledSuggestIds.has(post.id) && !this.pendingVkSuggestions.has(post.id)) {
            logger.info(`VK: new suggest post id=${post.id}, sending to admin...`)
            await this.handleNewVkSuggest(post)
          }
          return
        }

        // Обычный опубликованный пост → в TG
        this._stats.wallPostsNew++
        logger.info(`VK: new wall post id=${post.id}, forwarding to TG...`)
        const text = this.formatVkPostText(post)
        const photoUrls = this.extractVkPhotoUrls(post)
        await this.postToTelegram(text, photoUrls, String(post.id))
      }
    } catch (error) {
      logger.error("Error handling VK update:", error)
    }
  }

  // ─────────────────────────────────────────────
  // Новая предложка из ВК → TG админам
  // ─────────────────────────────────────────────
  async handleNewVkSuggest(post) {
    try {
      if (this.pendingVkSuggestions.has(post.id)) return
      this.pendingVkSuggestions.set(post.id, "processing")

      const text = this.formatVkPostText(post)
      const photoUrls = this.extractVkPhotoUrls(post)

      let authorInfo = "Неизвестный пользователь"
      if (post.from_id && post.from_id > 0) {
        try {
          const users = await this.vkApi("users.get", { user_ids: post.from_id, fields: "screen_name" })
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
        (text ? `📝 Текст:\n${text}\n\n` : `📝 Текст: отсутствует\n\n`) +
        `Примите или отклоните публикацию:`

      const keyboard = {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Принять (ТГ + ВК)", callback_data: `vk_approve_${post.id}` },
            { text: "❌ Отклонить", callback_data: `vk_reject_${post.id}` },
          ]],
        },
      }

      if (photoUrls.length === 0) {
        await this.bot.sendMessage(config.adminChatId, adminMessage, { parse_mode: "Markdown", ...keyboard })
      } else if (photoUrls.length === 1) {
        await this.bot.sendPhoto(config.adminChatId, photoUrls[0], { caption: adminMessage, parse_mode: "Markdown", ...keyboard })
      } else {
        const media = photoUrls.slice(0, 10).map((url, idx) => ({
          type: "photo",
          media: url,
          caption: idx === 0 ? (text || "") : undefined,
        }))
        await this.bot.sendMediaGroup(config.adminChatId, media)
        await this.bot.sendMessage(config.adminChatId, adminMessage, { parse_mode: "Markdown", ...keyboard })
      }

      this.pendingVkSuggestions.set(post.id, { status: "pending", text, photoUrls, authorInfo, post })
      this.handledSuggestIds.add(post.id)
      logger.info(`VK suggest ${post.id} sent to admin chat`)
    } catch (error) {
      logger.error("Error in handleNewVkSuggest:", error)
      this.pendingVkSuggestions.delete(post.id)
    }
  }

  // ─────────────────────────────────────────────
  // ПРИНЯТЬ предложку из ВК
  // ─────────────────────────────────────────────
  async approveVkSuggest(postId, callbackQuery) {
    try {
      const suggestionData = this.pendingVkSuggestions.get(postId)

      if (!suggestionData || typeof suggestionData === "string") {
        await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение не найдено или уже обработано" })
        return
      }

      // Шаг 1: опубликовать в ВК
      let vkPublished = false
      try {
        // Пробуем опубликовать существующий предложенный пост
        await this.vkApi("wall.post", {
          owner_id: `-${this.vkGroupId}`,
          post_id: postId,
          from_group: 1,
        })
        this.processedVkPosts.add(String(postId))
        setTimeout(() => this.processedVkPosts.delete(String(postId)), 10 * 60 * 1000)
        vkPublished = true
        logger.info(`VK suggest ${postId}: published via wall.post(post_id)`)
      } catch (publishErr) {
        // Fallback: создаём новый пост
        logger.warn(`wall.post(post_id=${postId}) failed: ${publishErr.message} — fallback to re-upload`)
        const photoBuffers = []
        for (const url of suggestionData.photoUrls) {
          try {
            const buffer = await this.downloadFile(url)
            photoBuffers.push({ buffer, filename: "photo.jpg" })
          } catch (err) {
            logger.error("Error downloading photo for re-upload:", err)
          }
        }
        const newPostId = await this.postToVk(suggestionData.text, photoBuffers)
        if (newPostId) {
          vkPublished = true
          logger.info(`VK suggest ${postId}: published as new post ${newPostId}`)
        }
      }

      // Шаг 2: дублировать в TG каналы
      await this.postToTelegram(suggestionData.text, suggestionData.photoUrls, `vk_suggest_approved_${postId}`)

      // Шаг 3: обновить кнопки
      try {
        const label = vkPublished ? "✅ ПРИНЯТО (ТГ + ВК)" : "✅ ПРИНЯТО (только ТГ)"
        await this.bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: label, callback_data: "noop" }]] },
          { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }
        )
      } catch (e) { /* ignore */ }

      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "✅ Опубликовано в ТГ и ВК!" })
      this.pendingVkSuggestions.delete(postId)
      logger.info(`VK suggest ${postId} approved`)
    } catch (error) {
      logger.error("Error approving VK suggest:", error)
      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка при публикации" })
    }
  }

  // ─────────────────────────────────────────────
  // ОТКЛОНИТЬ предложку из ВК
  // ─────────────────────────────────────────────
  async rejectVkSuggest(postId, callbackQuery) {
    try {
      try {
        await this.vkApi("wall.delete", { owner_id: `-${this.vkGroupId}`, post_id: postId })
        logger.info(`VK suggest ${postId}: deleted from wall`)
      } catch (err) {
        logger.warn(`Could not delete VK suggest ${postId}: ${err.message}`)
      }

      try {
        await this.bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: "❌ ОТКЛОНЕНО", callback_data: "noop" }]] },
          { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }
        )
      } catch (e) { /* ignore */ }

      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "❌ Предложение отклонено" })
      this.pendingVkSuggestions.delete(postId)
      this.handledSuggestIds.add(postId)
      logger.info(`VK suggest ${postId} rejected`)
    } catch (error) {
      logger.error("Error rejecting VK suggest:", error)
      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка при отклонении" })
    }
  }

  // ─────────────────────────────────────────────
  // Вспомогательные
  // ─────────────────────────────────────────────
  formatVkPostText(post) {
    let text = post.text || ""
    if (text.length > 1000) text = text.substring(0, 997) + "..."
    return text
  }

  extractVkPhotoUrls(post) {
    const urls = []
    if (!post.attachments) return urls
    for (const att of post.attachments) {
      if (att.type === "photo" && att.photo) {
        const sizes = att.photo.sizes || []
        const sorted = sizes.sort((a, b) => (b.width || 0) - (a.width || 0))
        if (sorted.length > 0) urls.push(sorted[0].url)
      }
    }
    return urls
  }

  // ─────────────────────────────────────────────
  // ЗАПУСК
  // ─────────────────────────────────────────────
  async startPolling() {
    if (this.lpRunning) return
    this.lpRunning = true

    logger.info("VK Bridge: starting Long Poll...")
    logger.info("VK Bridge: NOTE — wall.get requires user token, so polling is disabled.")
    logger.info("VK Bridge: Using Long Poll only. Ensure 'wall_post_new' event is enabled in VK group settings.")

    try {
      await this.getLongPollServer()
      logger.info("VK Long Poll: active and listening for events (wall posts, suggests, etc.)")
      this._runLoop()
    } catch (error) {
      logger.error("VK Long Poll: failed to start:", error)
      this.lpRunning = false
      setTimeout(() => this.startPolling(), 30000)
    }
  }

  async _runLoop() {
    while (this.lpRunning) {
      try {
        await this.longPollRequest()
      } catch (error) {
        if (error.message && error.message.includes("timeout")) continue
        logger.error("VK Long Poll loop error:", error)
        await new Promise((r) => setTimeout(r, 10000))
        try {
          await this.getLongPollServer()
        } catch (e) {
          logger.error("VK Long Poll: re-fetch server failed:", e)
        }
      }
    }
  }

  stopPolling() {
    this.lpRunning = false
    logger.info("VK Long Poll stopped")
  }
}

module.exports = VKBridge
