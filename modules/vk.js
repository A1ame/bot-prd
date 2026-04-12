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
    this.vkUserToken = config.vkUserToken || process.env.VK_USER_TOKEN || null  // пользовательский токен для загрузки фото

    // Дедупликация
    this.processedVkPosts = new Set()
    this.processedTgPosts = new Set()

    // Предложения из ВК, ожидающие решения
    this.pendingVkSuggestions = new Map()
    this.handledSuggestIds = new Set()
    this.bannedVkUsers = new Set()  // локальный бан VK юзеров (сбрасывается при рестарте)

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
  async vkApi(method, params = {}, useUserToken = false) {
    return new Promise((resolve, reject) => {
      // photos.* методы требуют пользовательский токен
      const token = (useUserToken && this.vkUserToken) ? this.vkUserToken : this.vkToken
      const query = new URLSearchParams({
        ...params,
        access_token: token,
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
      if (!this.vkUserToken) {
        logger.warn("uploadPhotoToVk: VK_USER_TOKEN not set — photo upload skipped. Add VK_USER_TOKEN to .env")
        return null
      }
      // photos.getWallUploadServer и photos.saveWallPhoto требуют пользовательский токен
      const uploadServer = await this.vkApi("photos.getWallUploadServer", { group_id: this.vkGroupId }, true)
      const uploaded = await this.multipartUpload(uploadServer.upload_url, fileBuffer, filename)
      const saved = await this.vkApi("photos.saveWallPhoto", {
        group_id: this.vkGroupId,
        photo: uploaded.photo,
        server: uploaded.server,
        hash: uploaded.hash,
      }, true)
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
      // tg_ ключи управляются в handleTelegramChannelPost — не блокируем их здесь
      if (dedupeKey && !dedupeKey.startsWith('tg_') && this.processedTgPosts.has(dedupeKey)) {
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
  // TG медиагруппа (альбом) → ВК
  // ─────────────────────────────────────────────
  async handleTelegramMediaGroup(msgs) {
    try {
      if (!msgs || msgs.length === 0) return

      // Сортируем по message_id чтобы порядок был правильным
      msgs.sort((a, b) => a.message_id - b.message_id)

      const firstMsg = msgs[0]
      const postKey = `tg_${firstMsg.chat.id}_group_${firstMsg.media_group_id}`

      if (this.processedTgPosts.has(postKey)) {
        logger.info(`TG->VK: media group duplicate, skip`)
        return
      }
      this.processedTgPosts.add(postKey)
      setTimeout(() => this.processedTgPosts.delete(postKey), 60 * 1000)

      const text = firstMsg.caption || ""
      const photoBuffers = []

      logger.info(`TG->VK: processing media group of ${msgs.length} messages`)

      for (const msg of msgs) {
        let fileId = null
        if (msg.photo) {
          fileId = msg.photo[msg.photo.length - 1].file_id
        } else if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith("image/")) {
          fileId = msg.document.file_id
        }

        if (fileId) {
          try {
            const fileInfo = await this.bot.getFile(fileId)
            const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${fileInfo.file_path}`
            const buffer = await this.downloadFile(fileUrl)
            photoBuffers.push({ buffer, filename: "photo.jpg" })
            logger.info(`TG->VK: downloaded photo ${photoBuffers.length}/${msgs.length}`)
          } catch (err) {
            logger.error(`TG->VK: error downloading photo from media group:`, err)
          }
        }
      }

      logger.info(`TG->VK: posting media group to VK, photos=${photoBuffers.length}, text_len=${text.length}`)
      const result = await this.postToVk(text, photoBuffers, postKey)
      logger.info(`TG->VK: media group postToVk result=${result}`)
    } catch (error) {
      logger.error("Error in handleTelegramMediaGroup:", error)
    }
  }

  // ─────────────────────────────────────────────
  // TG канал → новый пост → в ВК
  // ─────────────────────────────────────────────
  async handleTelegramChannelPost(msg) {
    try {
      logger.info(`TG->VK: handleTelegramChannelPost called, chat_id=${msg.chat.id}, msg_id=${msg.message_id}`)
      logger.info(`TG->VK: msg fields: ${Object.keys(msg).join(",")}`)
      logger.info(`TG->VK: has_photo=${!!msg.photo}, has_document=${!!msg.document}, media_group=${msg.media_group_id || "none"}`)
      if (msg.photo) logger.info(`TG->VK: photo sizes count=${msg.photo.length}, largest file_id=${msg.photo[msg.photo.length-1].file_id}`)
      const postKey = `tg_${msg.chat.id}_${msg.message_id}`
      if (this.processedTgPosts.has(postKey)) {
        logger.info(`TG->VK: duplicate, skip`)
        return
      }
      this.processedTgPosts.add(postKey)
      setTimeout(() => this.processedTgPosts.delete(postKey), 60 * 1000)

      const text = msg.text || msg.caption || ""
      const photoBuffers = []

      // Собираем фото: сжатое фото или документ-изображение
      const photoFileIds = []
      if (msg.photo) {
        photoFileIds.push(msg.photo[msg.photo.length - 1].file_id)
      } else if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith("image/")) {
        photoFileIds.push(msg.document.file_id)
      }

      for (const fileId of photoFileIds) {
        try {
          const fileInfo = await this.bot.getFile(fileId)
          const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${fileInfo.file_path}`
          const buffer = await this.downloadFile(fileUrl)
          photoBuffers.push({ buffer, filename: "photo.jpg" })
          logger.info(`TG->VK: downloaded photo file_id=${fileId}`)
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
        const photoUrls = await this.getFullPhotoUrls(post)
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

      // Проверяем локальный бан
      if (post.from_id && this.bannedVkUsers.has(post.from_id)) {
        logger.info(`VK suggest ${post.id}: author ${post.from_id} is banned, auto-deleting`)
        try {
          await this.vkApi("wall.delete", { owner_id: `-${this.vkGroupId}`, post_id: post.id })
        } catch (e) {}
        this.pendingVkSuggestions.delete(post.id)
        this.handledSuggestIds.add(post.id)
        return
      }

      const text = this.formatVkPostText(post)
      // Используем photos.getById для получения оригинального размера фото
      const photoUrls = await this.getFullPhotoUrls(post)

      // Скачиваем фото сразу в полном качестве
      const photoBuffers = []
      for (const url of photoUrls) {
        try {
          const buf = await this.downloadFile(url)
          photoBuffers.push(buf)
          logger.info(`VK suggest ${post.id}: downloaded photo ${photoBuffers.length}/${photoUrls.length}, size=${buf.length}`)
        } catch (e) {
          logger.error(`VK suggest ${post.id}: failed to download photo:`, e)
        }
      }

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
          inline_keyboard: [
            [
              { text: "✅ Принять (ТГ + ВК)", callback_data: `vk_approve_${post.id}` },
              { text: "✅ Принять с гайдом", callback_data: `vk_approve_guide_${post.id}` },
            ],
            [
              { text: "❌ Отклонить", callback_data: `vk_reject_${post.id}` },
              { text: "🚫 Забанить автора", callback_data: `vk_ban_${post.id}` },
            ],
            [
              { text: "➡️ К главному админу", callback_data: `vk_forward_${post.id}` },
            ],
          ],
        },
      }

      // Отправляем в админский чат с полными фото (буферы)
      if (photoBuffers.length === 0) {
        await this.bot.sendMessage(config.adminChatId, adminMessage, { parse_mode: "Markdown", ...keyboard })
      } else if (photoBuffers.length === 1) {
        await this.bot.sendPhoto(config.adminChatId, photoBuffers[0], { caption: adminMessage, parse_mode: "Markdown", ...keyboard })
      } else {
        const media = photoBuffers.slice(0, 10).map((buf, idx) => ({
          type: "photo",
          media: buf,
          caption: idx === 0 ? (text || "") : undefined,
        }))
        await this.bot.sendMediaGroup(config.adminChatId, media)
        await this.bot.sendMessage(config.adminChatId, adminMessage, { parse_mode: "Markdown", ...keyboard })
      }

      // Сохраняем буферы вместо URL
      this.pendingVkSuggestions.set(post.id, { status: "pending", text, photoUrls, photoBuffers, authorInfo, post })
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
  async approveVkSuggest(postId, callbackQuery, withGuide = false) {
    try {
      const suggestionData = this.pendingVkSuggestions.get(postId)

      if (!suggestionData || typeof suggestionData === "string") {
        await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение не найдено или уже обработано" })
        return
      }

      const cleanChannelId = String(this.vkGroupId)
      const suggestLink = `https://t.me/${config.botName}?start=${cleanChannelId}_channel`
      const guideTgText = withGuide ? `\n\n📒 Хочешь чтобы твоё сообщение попало в канал — пиши <a href="${suggestLink}">сюда</a>` : ""
      const guideVkText = withGuide ? `\n\nЕсли ты хочешь, чтобы новость попала в Подслушку, пролистай вверх и нажми на кнопку "Предложить новость"` : ""
      const finalTextTg = (suggestionData.text || "") + guideTgText
      const finalTextVk = (suggestionData.text || "") + guideVkText

      const db = require("../database/database")
      const channels = await db.getChannels()
      const photoBuffers = suggestionData.photoBuffers || []

      // Шаг 1: постим в TG каналы, собираем file_id из первого канала
      // Блокируем channel_post событие для этих каналов чтобы не улетело обратно в ВК
      const tgPostDedupeKey = `vk_suggest_tg_${postId}_${Date.now()}`
      let tgPostedFileIds = []
      for (let ci = 0; ci < channels.length; ci++) {
        const channel = channels[ci]
        try {
          let sentMsg = null
          if (photoBuffers.length === 0) {
            sentMsg = await this.bot.sendMessage(channel.chat_id, finalTextTg || "Новый пост из ВКонтакте", { parse_mode: "HTML" })
          } else if (photoBuffers.length === 1) {
            sentMsg = await this.bot.sendPhoto(channel.chat_id, photoBuffers[0], { caption: finalTextTg || "", parse_mode: "HTML" })
            if (ci === 0 && sentMsg.photo) tgPostedFileIds.push(sentMsg.photo[sentMsg.photo.length - 1].file_id)
          } else {
            const media = photoBuffers.slice(0, 10).map((buf, idx) => ({
              type: "photo", media: buf,
              caption: idx === 0 ? (finalTextTg || "") : undefined,
              parse_mode: "HTML",
            }))
            const sentArr = await this.bot.sendMediaGroup(channel.chat_id, media)
            if (ci === 0) {
              for (const s of sentArr) {
                if (s.photo) tgPostedFileIds.push(s.photo[s.photo.length - 1].file_id)
              }
            }
            sentMsg = sentArr ? sentArr[0] : null
          }
          // Блокируем channel_post для этого сообщения чтобы не пошло в ВК повторно
          if (sentMsg) {
            const blockKey = `tg_${channel.chat_id}_${sentMsg.message_id}`
            this.processedTgPosts.add(blockKey)
            setTimeout(() => this.processedTgPosts.delete(blockKey), 60 * 1000)
          }
          logger.info(`VK suggest approved: posted to TG channel ${channel.chat_id}`)
        } catch (err) {
          logger.error(`VK suggest: error posting to TG channel ${channel.chat_id}:`, err)
        }
      }

      // Шаг 2: постим в ВК — всегда создаём новый пост с нашим текстом и фото из TG
      // (НЕ используем wall.post с post_id — он публикует оригинал без изменений)
      let vkPublished = false
      let newVkPostId = null

      const photoBuffersForVk = []
      if (tgPostedFileIds.length > 0) {
        // Скачиваем фото из TG (то же качество что в канале)
        logger.info(`VK suggest: downloading ${tgPostedFileIds.length} photos from TG for VK`)
        for (const fileId of tgPostedFileIds) {
          try {
            const fileInfo = await this.bot.getFile(fileId)
            const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${fileInfo.file_path}`
            const buf = await this.downloadFile(fileUrl)
            photoBuffersForVk.push({ buffer: buf, filename: "photo.jpg" })
          } catch (e) {
            logger.error("VK suggest: error downloading TG file for VK:", e)
          }
        }
      } else if (photoBuffers.length > 0) {
        // Если TG не отдал file_id — используем буферы из предложки
        photoBuffers.forEach(buf => photoBuffersForVk.push({ buffer: buf, filename: "photo.jpg" }))
      }

      // Сначала удаляем оригинальный предложенный пост чтобы не было дублей в ВК
      try {
        await this.vkApi("wall.delete", { owner_id: `-${this.vkGroupId}`, post_id: postId })
        logger.info(`VK suggest ${postId}: original suggest post deleted`)
      } catch (e) {
        logger.warn(`VK suggest: could not delete original post ${postId}: ${e.message}`)
      }

      // Публикуем новый пост с нашим текстом
      // postToVk без dedupeKey не блокирует Long Poll — блокируем вручную заранее
      // (добавляем заглушку, которую заменим реальным post_id после публикации)
      newVkPostId = await this.postToVk(finalTextVk, photoBuffersForVk)
      if (newVkPostId) {
        vkPublished = true
        // Блокируем Long Poll чтобы новый пост не улетел обратно в TG
        this.processedVkPosts.add(String(newVkPostId))
        setTimeout(() => this.processedVkPosts.delete(String(newVkPostId)), 10 * 60 * 1000)
        logger.info(`VK suggest ${postId}: new post created, vk_post_id=${newVkPostId}, blocked in Long Poll`)
      }

      // Шаг 3: обновить кнопки
      try {
        const label = vkPublished
          ? (withGuide ? "✅ ПРИНЯТО С ГАЙДОМ (ТГ + ВК)" : "✅ ПРИНЯТО (ТГ + ВК)")
          : "✅ ПРИНЯТО (только ТГ)"
        await this.bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: label, callback_data: "noop" }]] },
          { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }
        )
      } catch (e) {}

      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "✅ Опубликовано!" })
      this.pendingVkSuggestions.delete(postId)
      this.handledSuggestIds.add(postId)
      logger.info(`VK suggest ${postId} approved (withGuide=${withGuide})`)
    } catch (error) {
      logger.error("Error approving VK suggest:", error)
      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка при публикации" })
    }
  }

  async approveVkSuggestWithGuide(postId, callbackQuery) {
    return this.approveVkSuggest(postId, callbackQuery, true)
  }

  async banVkSuggestAuthor(postId, callbackQuery) {
    try {
      const suggestionData = this.pendingVkSuggestions.get(postId)
      if (!suggestionData || typeof suggestionData === "string") {
        await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Предложение не найдено" })
        return
      }

      const authorVkId = suggestionData.post?.from_id
      let banResult = "не удалось получить ID автора"

      if (authorVkId && authorVkId > 0) {
        // Добавляем в локальный бан-лист (блокирует предложки через Long Poll)
        this.bannedVkUsers.add(authorVkId)

        // Баним в ВК группе через groups.ban (требует manage права в токене)
        try {
          await this.vkApi("groups.ban", {
            group_id: this.vkGroupId,
            owner_id: authorVkId,
            reason: 4,
            comment: "Забанен за нарушение правил предложки",
            comment_visible: 1,
          })
          banResult = `VK user ${authorVkId} забанен в группе`
          logger.info(`VK suggest ${postId}: banned VK user ${authorVkId} via groups.ban`)
        } catch (e) {
          // groups.ban может не работать с групповым токеном — тогда только локальный бан
          banResult = `локальный бан VK user ${authorVkId} (groups.ban: ${e.message})`
          logger.warn(`groups.ban failed for ${authorVkId}: ${e.message} — using local ban only`)
        }
      }

      // Удаляем пост из предложки ВК
      try {
        await this.vkApi("wall.delete", { owner_id: `-${this.vkGroupId}`, post_id: postId })
        logger.info(`VK suggest ${postId}: deleted from wall`)
      } catch (e) {
        logger.warn(`Could not delete VK suggest post ${postId}: ${e.message}`)
      }

      try {
        await this.bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: "🚫 АВТОР ЗАБАНЕН", callback_data: "noop" }]] },
          { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }
        )
      } catch (e) {}

      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "🚫 Автор забанен" })
      logger.info(`VK suggest ${postId} ban result: ${banResult}`)
      this.pendingVkSuggestions.delete(postId)
      this.handledSuggestIds.add(postId)
    } catch (error) {
      logger.error("Error banning VK suggest author:", error)
      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка при бане" })
    }
  }

  async forwardVkSuggestToMainAdmin(postId, callbackQuery) {
    try {
      try {
        await this.bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: "➡️ ОТПРАВЛЕНО К ГЛАВНОМУ АДМИНУ", callback_data: "noop" }]] },
          { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }
        )
      } catch (e) {}
      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Отправлено к главному админу" })
      this.pendingVkSuggestions.delete(postId)
      this.handledSuggestIds.add(postId)
    } catch (error) {
      logger.error("Error forwarding VK suggest:", error)
      await this.bot.answerCallbackQuery(callbackQuery.id, { text: "Ошибка" })
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

  // Получить список photo_ids из поста для запроса через photos.getById
  extractVkPhotoIds(post) {
    const ids = []
    if (!post.attachments) return ids
    for (const att of post.attachments) {
      if (att.type === "photo" && att.photo) {
        // Формат: owner_id_photo_id
        ids.push(`${att.photo.owner_id}_${att.photo.id}`)
      }
    }
    return ids
  }

  // Получить максимальные URL фото через photos.getById (оригинальное качество)
  async getFullPhotoUrls(post) {
    const photoIds = this.extractVkPhotoIds(post)
    if (photoIds.length === 0) return []
    try {
      const photos = await this.vkApi("photos.getById", {
        photos: photoIds.join(","),
        photo_sizes: 1,
      }, true)  // user token required
      const urls = []
      for (const photo of photos) {
        const sizes = photo.sizes || []
        // Тип w — оригинал, затем z, y, x по убыванию
        const priority = ["w", "z", "y", "x", "r", "q", "p", "o", "m", "s"]
        let best = null
        for (const t of priority) {
          best = sizes.find(s => s.type === t)
          if (best) break
        }
        if (!best) {
          // fallback: максимум по ширине
          sizes.sort((a, b) => (b.width || 0) - (a.width || 0))
          best = sizes[0]
        }
        if (best) {
          urls.push(best.url)
          logger.info(`VK photo ${photo.id}: using size type=${best.type}, ${best.width}x${best.height}`)
        }
      }
      return urls
    } catch (e) {
      logger.warn(`photos.getById failed: ${e.message} — falling back to attachment URLs`)
      return this.extractVkPhotoUrls(post)
    }
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
