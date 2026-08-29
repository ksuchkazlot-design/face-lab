---
name: telegram-bot
description: Guidelines and patterns for python-telegram-bot (v20+), async ApplicationBuilder, CommandHandler, MessageHandler, inline keyboards, photo sending, and background worker threads.
---

# Python Telegram Bot (v20+) Best Practices

## Core Principles
1. **Async Architecture**: PTB v20+ is fully asynchronous. Handlers must be async def handler(update: Update, context: ContextTypes.DEFAULT_TYPE).
2. **ApplicationBuilder**: Use ApplicationBuilder().token(...).build() to create the application instance.
3. **Dual Execution (Web + Bot)**: When running alongside FastAPI or another server, run the bot in a separate daemon thread with its own asyncio event loop: asyncio.run(bot.run_polling()).
4. **Sending Media**: Use await update.message.reply_photo(photo=...) or reply_document for high-resolution images.
