/**
 * VK Bridge Module
 *
 * Логика:
 * 1. TG канал → новый пост → публикуется на стену ВК
 * 2. ВК стена → новый пост (wall_post_new) → дублируется в TG каналы
 *    Источник: Long Poll (реалтайм) + периодический wall.get (резервный)
 * 3. ВК предложка (post_type === "suggest") → уведомление в TG админу
 *    Источник: Long Poll + периодический wall.get?filter=suggests (резервный)
 * 4. Админ принимает в TG → публикует существующий предложенный пост ВК + дублирует в TG
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

    // Дедупликация (защита от двойного постинга TG→VK→TG)
    this.processedVkPosts = new Set()
    this.processedTgPosts = new Set()

    // Предложения из ВК, ожидающие решения админа
    // Map<postId, { status, text, photoUrls, authorInfo, post }>
    this.pendingVkSuggestions = new Map()

    // Отслеживание обработанных предложок (чтобы polling не дублировал)
    this.handledSuggestIds = new Set()

    // ID последнего известного поста на стене (для резервного polling)
    this.lastKnownWallPostId = null

    // Long Poll состояние
    this.lpServer = null
    this.lpKey = null
    this.lpTs = null
    this.lpRunning = false
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
  // HTTP GET helper (для Long Poll запросов)
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
  // Скачать файл по URL → Buffer
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
      const uploadServer = await this.vkApi("photos.getWallUploadServer", {
        group_id: this.vkGroupId,
      })

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
  async postToVk(text, photoBuffers = [], dedupeKey = null) {
    try {
      if (dedupeKey && this.processedTgPosts.has(dedupeKey)) {
        logger.info(`Already processed ${dedupeKey}, skipping VK post`)
        return null
      }

      const attachments = []
      for (const { buffer, filename } of photoBuffers) {
        const attachment = await this.uploadPhotoToVk(buffer, filename)
        if (attachment) attachments.push(attachment)
      }

      const params = {
        owner_id: `-${this.vkGroupId}`,
        from_group: 1,
        message: text || "",
      }
      if (attachments.length > 0) {
        params.attachments = attachments.join(",")
      }

      const result = await this.vkApi("wall.post", params)

      if (dedupeKey) {
        this.processedTgPosts.add(dedupeKey)
        // Помечаем VK post_id чтобы Long Poll не вернул его обратно в TG
        this.processedVkPosts.add(result.post_id)
        setTimeout(() => {
          this.processedTgPosts.delete(dedupeKey)
          this.processedVkPosts.delete(result.post_id)
        }, 10 * 60 * 1000)
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
  async postToTelegram(text, photoUrls = [], dedupeKey = null) {
    try {
      const db = require("../database/database")
      const channels = await db.getChannels()

      if (channels.length === 0) {
        logger.warn("No TG channels configured, skipping VK->TG post")
        return
      }

      const key = dedupeKey !== null ? String(dedupeKey) : null
      if (key && this.processedVkPosts.has(key)) {
        logger.info(`Already processed vk_post=${key}, skipping TG post`)
        return
      }

      for (const channel of channels) {
        try {
          if (photoUrls.length === 0) {
            await this.bot.sendMessage(channel.chat_id, text || "Новый пост из ВКонтакте", {
              parse_mode: "HTML",
            })
          } else if (photoUrls.length === 1) {
            await this.bot.sendPhoto(channel.chat_id, photoUrls[0], {
              caption: text || "",
              parse_mode: "HTML",
            })
          } else {
            const media = photoUrls.slice(0, 10).map((url, idx) => ({
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

      if (key) {
        this.processedVkPosts.add(key)
        setTimeout(() => this.processedVkPosts.delete(key), 10 * 60 * 1000)
      }
    } catch (error) {
      logger.error("Error posting to Telegram:", error)
    }
  }

  // ─────────────────────────────────────────────
  // Обработка нового поста в TG канале → ВК
  // ─────────────────────────────────────────────
  async handleTelegramChannelPost(msg) {
    try {
      const postKey = `tg_${msg.chat.id}_${msg.message_id}`
      if (this.processedTgPosts.has(postKey)) return
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
  // РЕЗЕРВНЫЙ POLLING: новые посты на стене ВК → TG
  // Срабатывает если Long Poll не доставил событие
  // ─────────────────────────────────────────────
  async pollVkWallPosts() {
    try {
      const result = await this.vkApi("wall.get", {
        owner_id: `-${this.vkGroupId}`,
        filter: "owner",
        count: 5,
      })

      if (!result || !result.items || result.items.length === 0) return

      const latestPost = result.items[0]

      // Первый запуск — просто запоминаем последний ID, не постим
      if (this.lastKnownWallPostId === null) {
        this.lastKnownWallPostId = latestPost.id
        logger.info(`VK wall poll: initialized lastKnownWallPostId=${latestPost.id}`)
        return
      }

      if (latestPost.id <= this.lastKnownWallPostId) return

      // Найдены новые посты
      const newPosts = result.items.filter(p => p.id > this.lastKnownWallPostId)
      // Публикуем в хронологическом порядке (старый → новый)
      newPosts.reverse()

      for (const post of newPosts) {
        const dedupe = String(post.id)
        if (this.processedVkPosts.has(dedupe)) {
          logger.info(`VK wall poll: skipping already-processed post id=${post.id}`)
          continue
        }
        logger.info(`VK wall poll: new post id=${post.id}`)
        const text = this.formatVkPostText(post)
        const photoUrls = this.extractVkPhotoUrls(post)
        await this.postToTelegram(text, photoUrls, dedupe)
      }

      this.lastKnownWallPostId = latestPost.id
    } catch (error) {
      logger.error("Error in pollVkWallPosts:", error)
    }
  }

  // ─────────────────────────────────────────────
  // РЕЗЕРВНЫЙ POLLING: предложки из ВК → TG админу
  // Основной источник, т.к. Long Poll нестабильно
  // доставляет предложенные посты
  // ─────────────────────────────────────────────
  async pollVkSuggests() {
    try {
      const result = await this.vkApi("wall.get", {
        owner_id: `-${this.vkGroupId}`,
        filter: "suggests",
        count: 20,
      })

      if (!result || !result.items || result.items.length === 0) return

      for (const post of result.items) {
        if (
          !this.handledSuggestIds.has(post.id) &&
          !this.pendingVkSuggestions.has(post.id)
        ) {
          logger.info(`VK suggest poll: found new suggest id=${post.id}`)
          await this.handleNewVkSuggest(post)
        }
      }
    } catch (error) {
      // Ошибка 15 = нет прав на просмотр предложек — логируем один раз
      if (error.message && error.message.includes("15")) {
        logger.warn("VK suggest poll: Access denied (error 15). Check group token permissions (wall scope needed).")
      } else {
        logger.error("Error in pollVkSuggests:", error)
      }
    }
  }

  // ─────────────────────────────────────────────
  // LONG POLL — получить параметры сервера
  // ─────────────────────────────────────────────
  async getLongPollServer() {
    const response = await this.vkApi("groups.getLongPollServer", {
      group_id: this.vkGroupId,
    })
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

    if (data.ts) {
      this.lpTs = data.ts
    }

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

      if (type === "wall_post_new") {
        const post = obj.post || obj

        // Пропускаем посты, опубликованные нами
        if (this.processedVkPosts.has(String(post.id))) {
          logger.info(`Skipping own VK post id=${post.id}`)
          return
        }

        // Предложка
        if (post.post_type === "suggest") {
          if (!this.handledSuggestIds.has(post.id) && !this.pendingVkSuggestions.has(post.id)) {
            await this.handleNewVkSuggest(post)
          }
          return
        }

        // Обычный пост → в TG
        logger.info(`Long Poll: new VK wall post id=${post.id}`)
        // Обновляем lastKnownWallPostId чтобы polling не задублировал
        if (this.lastKnownWallPostId === null || post.id > this.lastKnownWallPostId) {
          this.lastKnownWallPostId = post.id
        }
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
      // Временно помечаем "processing", чтобы параллельный polling не запустил дублирующую обработку
      this.pendingVkSuggestions.set(post.id, "processing")

      logger.info(`New VK suggest: id=${post.id}`)

      const text = this.formatVkPostText(post)
      const photoUrls = this.extractVkPhotoUrls(post)

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
        (text ? `📝 Текст:\n${text}\n\n` : `📝 Текст: отсутствует\n\n`) +
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
        const media = photoUrls.slice(0, 10).map((url, idx) => ({
          type: "photo",
          media: url,
          caption: idx === 0 ? (text || "") : undefined,
        }))
        await this.bot.sendMediaGroup(config.adminChatId, media)
        await this.bot.sendMessage(config.adminChatId, adminMessage, {
          parse_mode: "Markdown",
          ...keyboard,
        })
      }

      // Сохраняем данные для дальнейшей обработки
      this.pendingVkSuggestions.set(post.id, {
        status: "pending",
        text,
        photoUrls,
        authorInfo,
        post,
      })
      this.handledSuggestIds.add(post.id)
    } catch (error) {
      logger.error("Error handling new VK suggest:", error)
      this.pendingVkSuggestions.delete(post.id)
    }
  }

  // ─────────────────────────────────────────────
  // ПРИНЯТЬ предложение из ВК
  // ─────────────────────────────────────────────
  async approveVkSuggest(postId, callbackQuery) {
    try {
      const suggestionData = this.pendingVkSuggestions.get(postId)

      if (!suggestionData || typeof suggestionData === "string") {
        await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение не найдено или уже обработано" })
        return
      }

      // ── Шаг 1: Опубликовать предложенный пост на стене ВК ──────────────
      // Используем wall.post с post_id чтобы опубликовать существующий
      // предложенный пост (без перезалива фото)
      let vkPublished = false
      try {
        await this.vkApi("wall.post", {
          owner_id: `-${this.vkGroupId}`,
          post_id: postId,
          from_group: 1,
        })
        // Помечаем опубликованный пост, чтобы polling не задублировал его в TG
        this.processedVkPosts.add(String(postId))
        setTimeout(() => this.processedVkPosts.delete(String(postId)), 10 * 60 * 1000)
        vkPublished = true
        logger.info(`VK suggest ${postId} published via wall.post(post_id)`)
      } catch (publishErr) {
        // Fallback: создаём новый пост с текстом и перезалитыми фото
        logger.warn(`wall.post(post_id) failed (${publishErr.message}), falling back to re-upload...`)
        const photoBuffers = []
        for (const url of suggestionData.photoUrls) {
          try {
            const buffer = await this.downloadFile(url)
            photoBuffers.push({ buffer, filename: "photo.jpg" })
          } catch (err) {
            logger.error("Error downloading VK suggest photo:", err)
          }
        }
        const newPostId = await this.postToVk(suggestionData.text, photoBuffers)
        if (newPostId) {
          vkPublished = true
          logger.info(`VK suggest ${postId} published as new post ${newPostId}`)
        }
      }

      // ── Шаг 2: Дублировать в TG каналы ────────────────────────────────
      await this.postToTelegram(
        suggestionData.text,
        suggestionData.photoUrls,
        `vk_suggest_approved_${postId}`
      )

      // ── Шаг 3: Обновить кнопки в чате с админом ───────────────────────
      try {
        const label = vkPublished ? "✅ ПРИНЯТО (ТГ + ВК)" : "✅ ПРИНЯТО (только ТГ)"
        await this.bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: label, callback_data: "noop" }]] },
          { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }
        )
      } catch (e) { /* ignore markup edit errors */ }

      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "✅ Опубликовано в ТГ и ВК!" })
      this.pendingVkSuggestions.delete(postId)
      logger.info(`VK suggest ${postId} approved`)
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
      // Удаляем предложенный пост из очереди ВК
      try {
        await this.vkApi("wall.delete", {
          owner_id: `-${this.vkGroupId}`,
          post_id: postId,
        })
        logger.info(`VK suggest ${postId} deleted from wall`)
      } catch (err) {
        logger.warn(`Could not delete VK suggest post ${postId}: ${err.message}`)
      }

      try {
        await this.bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: "❌ ОТКЛОНЕНО", callback_data: "noop" }]] },
          { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }
        )
      } catch (e) { /* ignore */ }

      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "❌ Предложение отклонено" })
      this.pendingVkSuggestions.delete(postId)
      this.handledSuggestIds.add(postId) // не показывать снова в polling
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
  // ЗАПУСК: Long Poll + резервный polling
  // ─────────────────────────────────────────────
  async startPolling() {
    if (this.lpRunning) return
    this.lpRunning = true

    // ── Long Poll ──────────────────────────────
    try {
      await this.getLongPollServer()
      logger.info("VK Long Poll started successfully")
      this._runLoop()
    } catch (error) {
      logger.error("VK Long Poll: failed to get server:", error)
      this.lpRunning = false
      setTimeout(() => this.startPolling(), 30000)
      return
    }

    // ── Резервный polling: предложки ──────────
    // Запуск сразу + каждые vkPollingInterval мс (по умолчанию 30 сек)
    const suggestInterval = config.vkPollingInterval || 30000
    await this.pollVkSuggests() // первый запрос сразу
    this._suggestPollTimer = setInterval(() => {
      this.pollVkSuggests().catch(e => logger.error("Suggest poll error:", e))
    }, suggestInterval)

    // ── Резервный polling: стена ──────────────
    // Интервал в 2 раза реже, чтобы не перегружать API
    const wallInterval = Math.max(suggestInterval * 2, 60000)
    await this.pollVkWallPosts() // первый запрос (инициализация lastKnownWallPostId)
    this._wallPollTimer = setInterval(() => {
      this.pollVkWallPosts().catch(e => logger.error("Wall poll error:", e))
    }, wallInterval)

    logger.info(
      `VK polling started: suggests every ${suggestInterval / 1000}s, wall every ${wallInterval / 1000}s`
    )
  }

  async _runLoop() {
    while (this.lpRunning) {
      try {
        await this.longPollRequest()
      } catch (error) {
        if (error.message && error.message.includes("timeout")) {
          continue
        }
        logger.error("VK Long Poll loop error:", error)
        await new Promise((r) => setTimeout(r, 10000))
        try {
          await this.getLongPollServer()
        } catch (e) {
          logger.error("VK Long Poll: failed to re-fetch server:", e)
        }
      }
    }
  }

  stopPolling() {
    this.lpRunning = false
    if (this._suggestPollTimer) clearInterval(this._suggestPollTimer)
    if (this._wallPollTimer) clearInterval(this._wallPollTimer)
    logger.info("VK polling stopped")
  }
}

module.exports = VKBridge
