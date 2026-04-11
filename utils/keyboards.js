const keyboards = {
  adminMain: {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📋 Управление каналами", callback_data: "admin_channels" },
          { text: "⏰ Отложенные сообщения", callback_data: "admin_scheduled" },
        ],
        [{ text: "📊 Статистика", callback_data: "admin_stats" }],
      ],
    },
  },

  channelManagement: {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➕ Добавить канал", callback_data: "add_channel" },
          { text: "📋 Список каналов", callback_data: "list_channels" },
        ],
        [{ text: "🔙 Назад", callback_data: "admin_main" }],
      ],
    },
  },

  scheduledMessages: {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➕ Создать сообщение", callback_data: "create_scheduled" },
          { text: "📋 Список сообщений", callback_data: "list_scheduled" },
        ],
        [{ text: "🔙 Назад", callback_data: "admin_main" }],
      ],
    },
  },

  suggestionActions: (suggestionId, channelId = null) => ({
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Одобрить", callback_data: `approve_${suggestionId}` },
          { text: "✅ Одобрить с гайдом", callback_data: `approve_guide_${suggestionId}_${channelId}` },
          { text: "❌ Отклонить", callback_data: `reject_${suggestionId}` },
        ],
        [{ text: "🚫 Забанить автора", callback_data: `ban_${suggestionId}` },
            { text: "➡️ К главному админу", callback_data: `forward_to_main_admin_${suggestionId}_${channelId}` }],
      ],
    },
  }),

  channelSelection: (channels) => ({
    reply_markup: {
      inline_keyboard: [
        [{ text: "📢 Все каналы", callback_data: "schedule_all_channels" }],
        ...channels.map((channel) => [
          {
            text: `📍 ${channel.title || channel.username}`,
            callback_data: `schedule_channel_${channel.id}`,
          },
        ]),
        [{ text: "❌ Отмена", callback_data: "admin_scheduled" }],
      ],
    },
  }),

  backToMain: {
    reply_markup: {
      inline_keyboard: [[{ text: "🔙 Главное меню", callback_data: "admin_main" }]],
    },
  },
}

module.exports = keyboards