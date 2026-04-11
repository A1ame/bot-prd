require("dotenv").config()

module.exports = {
  botToken: process.env.BOT_TOKEN,
  adminChatId: process.env.ADMIN_CHAT_ID,
  adminUserIds: process.env.ADMIN_USER_IDS
    ? process.env.ADMIN_USER_IDS.split(",").map((id) => Number.parseInt(id))
    : [],
  dbPath: "./data/bot.db",
  botName: process.env.BOT_NAME,
  logLevel: "info",
  logFile: "./logs/bot.log",
  autoModeration: "true",
  rulesMessageDelay: Number.parseInt(process.env.RULES_MESSAGE_DELAY) || 5000,
  maxWarnings: Number.parseInt(process.env.MAX_WARNINGS) || 3,
}
