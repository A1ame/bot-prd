const database = require("./database")

console.log("Инициализация базы данных...")
console.log("База данных готова к работе!")

setTimeout(() => {
  database.close()
  process.exit(0)
}, 1000)