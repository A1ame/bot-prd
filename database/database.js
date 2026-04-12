const sqlite3 = require("sqlite3").verbose()
const path = require("path")
const fs = require("fs")
const config = require("../config/config")

class Database {
  constructor() {
    this.db = null
    this.init()
  }

  init() {
    const dbDir = path.dirname(config.dbPath)
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }

    this.db = new sqlite3.Database(config.dbPath, (err) => {
      if (err) {
        console.error("Error opening database:", err)
      } else {
        console.log("Connected to SQLite database")
        this.createTables()
      }
    })
  }

  createTables() {
    const tables = [
      `CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT UNIQUE NOT NULL,
        username TEXT,
        title TEXT,
        type TEXT DEFAULT 'channel',
        moderation_enabled BOOLEAN DEFAULT 1,
        suggestions_enabled BOOLEAN DEFAULT 1,
        rules_message TEXT,
        max_warnings INTEGER DEFAULT 3,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      `CREATE TABLE IF NOT EXISTS scheduled_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        target_channels TEXT NOT NULL,
        schedule_time DATETIME NOT NULL,
        pin_duration INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_by INTEGER,
        media_group_id TEXT,
        all_message_ids TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      `CREATE TABLE IF NOT EXISTS suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        username TEXT,
        chat_id TEXT NOT NULL,
        message_id INTEGER,
        admin_message_id INTEGER,
        original_chat_id TEXT,
        original_message_id INTEGER,
        content_type TEXT,
        status TEXT DEFAULT 'pending',
        file_ids TEXT,
        caption TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      `CREATE TABLE IF NOT EXISTS user_warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        reason TEXT,
        warning_count INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      `CREATE TABLE IF NOT EXISTS banned_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE NOT NULL,
        username TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ]

    tables.forEach((sql) => {
      this.db.run(sql, (err) => {
        if (err) console.error("Error creating table:", err)
      })
    })

    const alterQueries = [
      `ALTER TABLE suggestions ADD COLUMN original_chat_id TEXT`,
      `ALTER TABLE suggestions ADD COLUMN original_message_id INTEGER`,
      `ALTER TABLE suggestions ADD COLUMN file_ids TEXT`,
      `ALTER TABLE suggestions ADD COLUMN caption TEXT`,
      `ALTER TABLE scheduled_messages ADD COLUMN media_group_id TEXT`,
      `ALTER TABLE scheduled_messages ADD COLUMN all_message_ids TEXT`,
      `ALTER TABLE scheduled_messages ADD COLUMN media_files TEXT`
    ]

    alterQueries.forEach((sql) => {
      this.db.run(sql, (err) => {
      })
    })
  }

  addChannel(chatId, username, title, type = "channel") {
    return new Promise((resolve, reject) => {
      const sql = `INSERT OR REPLACE INTO channels (chat_id, username, title, type) VALUES (?, ?, ?, ?)`
      this.db.run(sql, [chatId, username, title, type], function (err) {
        if (err) reject(err)
        else resolve(this.lastID)
      })
    })
  }

  getChannels() {
    return new Promise((resolve, reject) => {
      this.db.all(`SELECT * FROM channels ORDER BY created_at DESC`, (err, rows) => {
        if (err) reject(err)
        else resolve(rows)
      })
    })
  }

  updateChannelSettings(chatId, settings) {
    return new Promise((resolve, reject) => {
      const fields = Object.keys(settings)
        .map((key) => `${key} = ?`)
        .join(", ")
      const values = Object.values(settings)
      values.push(chatId)

      const sql = `UPDATE channels SET ${fields} WHERE chat_id = ?`
      this.db.run(sql, values, function (err) {
        if (err) reject(err)
        else resolve(this.changes)
      })
    })
  }

  async addScheduledMessage(messageId, targetChannels, scheduleTime, pinDuration = 0, createdBy, mediaGroupId = null, allMessageIds = null, mediaFiles = null) {
    return new Promise((resolve, reject) => {
      const sql = `INSERT INTO scheduled_messages (message_id, target_channels, schedule_time, pin_duration, created_by, media_group_id, all_message_ids, media_files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      this.db.run(sql, [
        messageId, 
        targetChannels, 
        scheduleTime, 
        pinDuration, 
        createdBy, 
        mediaGroupId,
        allMessageIds ? JSON.stringify(allMessageIds) : null,
        mediaFiles ? JSON.stringify(mediaFiles) : null
      ], function (err) {
        if (err) reject(err)
        else resolve(this.lastID)
      })
    })
  }

  async getScheduledMessages() {
    return new Promise((resolve, reject) => {
      const sql = `SELECT * FROM scheduled_messages ORDER BY schedule_time DESC`
      this.db.all(sql, (err, rows) => {
        if (err) {
          reject(err)
        } else {
          rows.forEach(row => {
            if (row.all_message_ids) {
              try {
                row.all_message_ids = JSON.parse(row.all_message_ids)
              } catch (e) {
                console.error('Error parsing all_message_ids:', e)
                row.all_message_ids = [row.message_id]
              }
            } else {
              row.all_message_ids = [row.message_id]
            }
            
            if (row.media_files) {
              try {
                row.media_files = JSON.parse(row.media_files)
              } catch (e) {
                console.error('Error parsing media_files:', e)
                row.media_files = []
              }
            } else {
              row.media_files = []
            }
          })
          resolve(rows)
        }
      })
    })
  }

  updateScheduledMessageStatus(id, status) {
    return new Promise((resolve, reject) => {
      this.db.run(`UPDATE scheduled_messages SET status = ? WHERE id = ?`, [status, id], function (err) {
        if (err) reject(err)
        else resolve(this.changes)
      })
    })
  }

  addSuggestion(userId, username, chatId, messageId, contentType, originalChatId = null, fileIds = null, caption = null) {
    return new Promise((resolve, reject) => {
        const sql = `INSERT INTO suggestions (user_id, username, chat_id, message_id, content_type, original_chat_id, file_ids, caption) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        this.db.run(
        sql,
        [userId, username, chatId, messageId, contentType, originalChatId, fileIds ? JSON.stringify(fileIds) : null, caption],
        function (err) {
            if (err) reject(err);
            else resolve(this.lastID);
        }
        );
    });
  }

  updateSuggestionStatus(id, status, adminMessageId = null) {
    return new Promise((resolve, reject) => {
      const sql = adminMessageId
        ? `UPDATE suggestions SET status = ?, admin_message_id = ? WHERE id = ?`
        : `UPDATE suggestions SET status = ? WHERE id = ?`
      const params = adminMessageId ? [status, adminMessageId, id] : [status, id]

      this.db.run(sql, params, function (err) {
        if (err) reject(err)
        else resolve(this.changes)
      })
    })
  }

  getSuggestion(id) {
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT * FROM suggestions WHERE id = ?`, [id], (err, row) => {
        if (err) reject(err)
        else {
          if (row) {
            if (row.file_ids) {
              try {
                row.file_ids = JSON.parse(row.file_ids)
              } catch (e) {
                console.error('Error parsing file_ids:', e)
                row.file_ids = []
              }
            }
            if (row.all_message_ids) {
              try {
                row.all_message_ids = JSON.parse(row.all_message_ids)
              } catch (e) {
                console.error('Error parsing all_message_ids:', e)
                row.all_message_ids = [row.message_id]
              }
            }
          }
          resolve(row)
        }
      })
    })
  }

  updateSuggestionWithMessageInfo(id, status, adminMessageId, originalChatId, originalMessageId) {
    return new Promise((resolve, reject) => {
      const sql = `UPDATE suggestions SET status = ?, admin_message_id = ?, original_chat_id = ?, original_message_id = ? WHERE id = ?`
      this.db.run(sql, [status, adminMessageId, originalChatId, originalMessageId, id], function (err) {
        if (err) reject(err)
        else resolve(this.changes)
      })
    })
  }

  addWarning(userId, chatId, reason) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT warning_count FROM user_warnings WHERE user_id = ? AND chat_id = ?`,
        [userId, chatId],
        (err, row) => {
          if (err) {
            reject(err)
            return
          }

          if (row) {
            const newCount = row.warning_count + 1
            this.db.run(
              `UPDATE user_warnings SET warning_count = ?, reason = ? WHERE user_id = ? AND chat_id = ?`,
              [newCount, reason, userId, chatId],
              (err) => {
                if (err) reject(err)
                else resolve(newCount)
              },
            )
          } else {
            this.db.run(
              `INSERT INTO user_warnings (user_id, chat_id, reason) VALUES (?, ?, ?)`,
              [userId, chatId, reason],
              (err) => {
                if (err) reject(err)
                else resolve(1)
              },
            )
          }
        },
      )
    })
  }

  getUserWarnings(userId, chatId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT warning_count FROM user_warnings WHERE user_id = ? AND chat_id = ?`,
        [userId, chatId],
        (err, row) => {
          if (err) reject(err)
          else resolve(row ? row.warning_count : 0)
        },
      )
    })
  }

  resetWarnings(userId, chatId) {
    return new Promise((resolve, reject) => {
        this.db.run(
        `DELETE FROM user_warnings WHERE user_id = ? AND chat_id = ?`,
        [userId, chatId],
        function (err) {
            if (err) reject(err)
            else resolve(this.changes)
        }
        )
    })
  }

  banUser(userId, username = null) {
    return new Promise((resolve, reject) => {
      const sql = `INSERT OR REPLACE INTO banned_users (user_id, username) VALUES (?, ?)`
      this.db.run(sql, [userId, username || null], function(err) {
        if (err) reject(err)
        else resolve(this.changes)
      })
    })
  }

  unbanUser(userIdOrUsername) {
    return new Promise((resolve, reject) => {
      // Поддерживаем и числовой ID и @username
      const isId = !isNaN(parseInt(userIdOrUsername)) && !String(userIdOrUsername).startsWith("@")
      const sql = isId
        ? `DELETE FROM banned_users WHERE user_id = ?`
        : `DELETE FROM banned_users WHERE username = ?`
      const param = isId ? parseInt(userIdOrUsername) : String(userIdOrUsername).replace("@", "").toLowerCase()
      this.db.run(sql, [param], function(err) {
        if (err) reject(err)
        else resolve(this.changes)
      })
    })
  }

  isUserBanned(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT 1 FROM banned_users WHERE user_id = ?`, [userId], (err, row) => {
        if (err) reject(err)
        else resolve(!!row)
      })
    })
  }

  getBannedUsers() {
    return new Promise((resolve, reject) => {
      this.db.all(`SELECT * FROM banned_users ORDER BY created_at DESC`, (err, rows) => {
        if (err) reject(err)
        else resolve(rows)
      })
    })
  }

  deleteChannel(id) {
    return new Promise((resolve, reject) => {
      // id — числовой PRIMARY KEY из таблицы channels
      const sql = `DELETE FROM channels WHERE id = ?`
      this.db.run(sql, [id], function(err) {
        if (err) reject(err)
        else resolve(this.changes)
      })
    })
  }
}

module.exports = new Database()