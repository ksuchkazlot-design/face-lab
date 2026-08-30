"""Face Lab Telegram bot.

Handles /start, channel check, Stars payments, WebApp launch.
"""

import hmac
import hashlib
import json
import logging
import os
import time
from urllib.parse import parse_qsl, unquote

from telegram import (
    BotCommand,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    LabeledPrice,
    Update,
    WebAppInfo,
)
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    PreCheckoutQueryHandler,
    MessageHandler,
    filters,
)

import database as db

logger = logging.getLogger("face-lab-bot")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BOT_TOKEN = os.environ.get(
    "FACE_LAB_BOT_TOKEN",
    os.environ.get("TELEGRAM_BOT_TOKEN", "8689574065:AAFyUzrq2nlnk4KPxIdiulEbQUYVCzoAxHI")
)
CHANNEL_LINK = os.environ.get(
    "FACE_LAB_CHANNEL_LINK",
    "https://t.me/FACELABS1",
)
CHANNEL_USERNAME = os.environ.get("FACE_LAB_CHANNEL", "@FACELABS1")

WEBAPP_URL = os.environ.get("FACE_LAB_WEBAPP_URL", "")

# Prices in Telegram Stars (1 star ≈ 2 rubles → 50₽ ≈ 25⭐)
PRICES = {
    "pack_1":   LabeledPrice("1 анализ", 25),
    "pack_3":   LabeledPrice("3 анализа", 60),
    "pack_5":   LabeledPrice("5 анализов", 100),
    "pack_10":  LabeledPrice("10 анализов", 175),
}

PACK_CREDITS = {
    "pack_1":   1,
    "pack_3":   3,
    "pack_5":   5,
    "pack_10":  10,
}

# ---------------------------------------------------------------------------
# WebApp URL helper
# ---------------------------------------------------------------------------

def _webapp_url() -> str:
    url = os.environ.get("FACE_LAB_WEBAPP_URL", "").strip() or os.environ.get("RENDER_EXTERNAL_URL", "").strip()
    if url:
        return url.rstrip("/")
    tunnel_file = os.path.join(os.path.dirname(__file__), ".tunnel_url")
    if os.path.exists(tunnel_file):
        try:
            with open(tunnel_file, "r", encoding="utf-8") as f:
                saved = f.read().strip()
                if saved.startswith("https://"):
                    return saved.rstrip("/")
        except Exception:
            pass
    if WEBAPP_URL:
        return WEBAPP_URL.rstrip("/")
    return "http://127.0.0.1:8000"


# ---------------------------------------------------------------------------
# Telegram initData verification
# ---------------------------------------------------------------------------

def verify_init_data(init_data: str, bot_token: str) -> bool:
    """Verify Telegram WebApp initData HMAC."""
    try:
        if not init_data or not bot_token:
            return False
        parts = dict(parse_qsl(init_data, keep_blank_values=True))
        recv_hash = parts.pop("hash", "")
        if not recv_hash:
            return False
        data_check = "\n".join(f"{k}={v}" for k, v in sorted(parts.items()))
        secret = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
        computed = hmac.new(secret, data_check.encode("utf-8"), hashlib.sha256).hexdigest()
        return hmac.compare_digest(computed, recv_hash)
    except Exception as e:
        logger.warning(f"initData verification failed: {e}")
        return False


# ---------------------------------------------------------------------------
# Channel membership check
# ---------------------------------------------------------------------------

async def check_channel_member(user_id: int, context: ContextTypes.DEFAULT_TYPE) -> bool:
    """Check if user is a member of the required channel.

    Bot must be admin of the channel for this to work.
    """
    if not CHANNEL_USERNAME:
        return True
    try:
        member = await context.bot.get_chat_member(CHANNEL_USERNAME, user_id)
        return member.status in ("member", "administrator", "creator", "restricted")
    except Exception as e:
        logger.warning(f"Channel check failed for {user_id}: {e}")
        return False


# ---------------------------------------------------------------------------
# Keyboard builders
# ---------------------------------------------------------------------------

def channel_sub_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("📢 Подписаться на канал", url=CHANNEL_LINK)],
        [InlineKeyboardButton("🔄 Проверить подписку", callback_data="check_sub")],
    ])


def main_menu_keyboard(credits: int = 0) -> InlineKeyboardMarkup:
    webapp_url = _webapp_url()
    buttons = []
    # Always show the WebApp launch button
    if webapp_url.startswith("https://"):
        buttons.append(
            [InlineKeyboardButton("🔍 Запустить анализ лица", web_app=WebAppInfo(url=webapp_url))]
        )
    else:
        buttons.append(
            [InlineKeyboardButton("🔍 Запустить анализ лица", url=webapp_url)]
        )

    if credits <= 0:
        buttons.append([
            InlineKeyboardButton("💎 Купить анализы", callback_data="prices"),
        ])

    buttons.append([
        InlineKeyboardButton("📊 История", callback_data="history"),
    ])
    return InlineKeyboardMarkup(buttons)


def prices_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("1️⃣  1 анализ — 25⭐ (≈50₽)", callback_data="pay:pack_1")],
        [InlineKeyboardButton("3️⃣  3 анализа — 60⭐ (≈120₽) 💰 выгода 20%", callback_data="pay:pack_3")],
        [InlineKeyboardButton("5️⃣  5 анализов — 100⭐ (≈200₽) 💰 выгода 20%", callback_data="pay:pack_5")],
        [InlineKeyboardButton("🔟  10 анализов — 175⭐ (≈350₽) 🔥 выгода 30%", callback_data="pay:pack_10")],
        [InlineKeyboardButton("◀️ Назад", callback_data="back_main")],
    ])


# ---------------------------------------------------------------------------
# /start
# ---------------------------------------------------------------------------

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    db.upsert_user(user.id, user.username or "", user.first_name or "")

    is_member = await check_channel_member(user.id, context)
    if not is_member:
        await update.message.reply_text(
            f"👋 Добро пожаловать в <b>Face Lab</b>!\n\n"
            f"Для доступа к боту и анализу лица подпишитесь на наш официальный канал:\n"
            f"👉 <a href=\"{CHANNEL_LINK}\">{CHANNEL_USERNAME}</a>\n\n"
            f"После подписки нажмите кнопку <b>«Проверить подписку»</b> ниже:",
            parse_mode="HTML",
            disable_web_page_preview=True,
            reply_markup=channel_sub_keyboard(),
        )
        return

    user_info = db.get_user(user.id) or {}
    credits = user_info.get("paid_analyses", 0)

    if credits > 0:
        text = (
            f"👋 Привет, <b>{user.first_name}</b>!\n\n"
            f"💎 Доступно анализов: <b>{credits}</b>\n\n"
            f"Нажмите «🔍 Запустить анализ лица» для перехода к сканеру."
        )
    else:
        text = (
            f"👋 Привет, <b>{user.first_name}</b>!\n\n"
            f"🔬 <b>Face Lab</b> — профессиональный биометрический анализ лица по 52 метрикам.\n\n"
            f"Нажмите «🔍 Запустить анализ лица» чтобы посмотреть приложение.\n"
            f"Для полного анализа купите пакет анализов — <b>от 50₽ за анализ</b> (по цене батончика 🍫)."
        )

    await update.message.reply_text(
        text,
        parse_mode="HTML",
        reply_markup=main_menu_keyboard(credits),
    )


# ---------------------------------------------------------------------------
# Callback queries
# ---------------------------------------------------------------------------

async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = query.data
    user_id = query.from_user.id

    if data == "check_sub":
        await query.answer()
        is_member = await check_channel_member(user_id, context)
        if not is_member:
            await query.answer("⚠️ Вы ещё не подписались на канал @FACELABS1! Подпишитесь и нажмите кнопку снова.", show_alert=True)
            return

        await query.answer("✅ Подписка подтверждена!")
        user_info = db.get_user(user_id) or {}
        credits = user_info.get("paid_analyses", 0)
        first_name = query.from_user.first_name or "друг"

        if credits > 0:
            text = (
                f"👋 Привет, <b>{first_name}</b>!\n\n"
                f"💎 Доступно анализов: <b>{credits}</b>\n\n"
                f"Нажмите «🔍 Запустить анализ лица» для перехода к сканеру."
            )
        else:
            text = (
                f"👋 Привет, <b>{first_name}</b>!\n\n"
                f"🔬 <b>Face Lab</b> — профессиональный биометрический анализ лица по 52 метрикам.\n\n"
                f"Нажмите «🔍 Запустить анализ лица» чтобы посмотреть приложение.\n"
                f"Для полного анализа купите пакет анализов — <b>от 50₽ за анализ</b> (по цене батончика 🍫)."
            )

        await query.edit_message_text(
            text,
            parse_mode="HTML",
            reply_markup=main_menu_keyboard(credits),
        )
        return

    # Check channel subscription for all other callbacks
    is_member = await check_channel_member(user_id, context)
    if not is_member:
        await query.answer()
        await query.edit_message_text(
            f"👋 Для использования бота необходимо подписаться на наш официальный канал:\n"
            f"👉 <a href=\"{CHANNEL_LINK}\">{CHANNEL_USERNAME}</a>\n\n"
            f"После подписки нажмите кнопку <b>«Проверить подписку»</b>:",
            parse_mode="HTML",
            disable_web_page_preview=True,
            reply_markup=channel_sub_keyboard(),
        )
        return

    await query.answer()

    if data == "back_main":
        user_info = db.get_user(user_id) or {}
        credits = user_info.get("paid_analyses", 0)
        text = "🏠 <b>Главное меню Face Lab</b>"
        await query.edit_message_text(text, parse_mode="HTML", reply_markup=main_menu_keyboard(credits))
        return

    if data == "prices":
        await query.edit_message_text(
            "💎 <b>Пакеты анализов:</b>\n\n"
            "1️⃣  <b>1 анализ</b> — 25⭐ (≈50₽)\n"
            "3️⃣  <b>3 анализа</b> — 60⭐ (≈120₽) 💰 выгода 20%\n"
            "5️⃣  <b>5 анализов</b> — 100⭐ (≈200₽) 💰 выгода 20%\n"
            "🔟  <b>10 анализов</b> — 175⭐ (≈350₽) 🔥 выгода 30%\n\n"
            "Оплата через Telegram Stars.",
            parse_mode="HTML",
            reply_markup=prices_keyboard(),
        )
        return

    if data == "history":
        analyses = db.get_analyses(user_id, limit=5)
        if not analyses:
            text = "📊 <b>История пуста</b>\n\nВы ещё не делали анализов."
        else:
            lines = ["📊 <b>Последние анализы:</b>\n"]
            for a in analyses:
                t = time.strftime("%d.%m.%Y %H:%M", time.localtime(a["created_at"]))
                lines.append(f"• {t} — <b>{a['overall']:.1f}</b>/10 ({a['gender']}, {a['ethnicity']})")
            text = "\n".join(lines)

        await query.edit_message_text(
            text, parse_mode="HTML",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("◀️ Назад", callback_data="back_main")]]),
        )
        return

    if data.startswith("pay:"):
        product = data.split(":", 1)[1]
        if product not in PRICES:
            return

        label = PRICES[product].label

        await context.bot.send_invoice(
            chat_id=user_id,
            title=f"Face Lab — {label}",
            description=f"Оплата: {label}. По цене батончика 🍫",
            payload=f"{product}:{user_id}:{int(time.time())}",
            currency="XTR",
            prices=[PRICES[product]],
        )


# ---------------------------------------------------------------------------
# Pre-checkout & successful payment
# ---------------------------------------------------------------------------

async def pre_checkout(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Confirm the pre-checkout query."""
    await update.pre_checkout_query.answer(ok=True)


async def successful_payment(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle successful payment."""
    payment = update.message.successful_payment
    user_id = update.effective_user.id
    payload_parts = payment.invoice_payload.split(":")
    product = payload_parts[0]
    payment_id = payment.telegram_payment_charge_id

    db.add_payment(user_id, payment.total_amount, payment.currency, product, payment_id, "completed")

    credits_to_add = PACK_CREDITS.get(product, 1)
    db.add_paid_credits(user_id, credits_to_add)

    user_info = db.get_user(user_id) or {}
    total_credits = user_info.get("paid_analyses", 0)
    text = (
        f"✅ <b>Оплата прошла!</b>\n\n"
        f"💎 Начислено анализов: <b>{credits_to_add}</b>\n"
        f"📊 Всего доступно: <b>{total_credits}</b>\n\n"
        f"Нажмите «🔍 Запустить анализ лица» чтобы начать."
    )

    await update.message.reply_text(
        text, parse_mode="HTML",
        reply_markup=main_menu_keyboard(total_credits),
    )


# ---------------------------------------------------------------------------
# Bot setup
# ---------------------------------------------------------------------------

async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE):
    """Log errors and don't crash."""
    logger.error(f"Exception while handling an update: {context.error}")


async def cmd_grant(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Developer / Admin command to grant test credits."""
    user = update.effective_user
    if not user:
        return
    db.add_paid_credits(user.id, 10)
    user_info = db.get_user(user.id) or {}
    credits = user_info.get("paid_analyses", 0)
    await update.message.reply_text(
        f"✅ Вам начислено 10 тестовых анализов!\n💎 Всего доступно: <b>{credits}</b>",
        parse_mode="HTML",
        reply_markup=main_menu_keyboard(credits),
    )


def create_bot() -> Application:
    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("grant", cmd_grant))
    app.add_handler(CallbackQueryHandler(callback_handler))
    app.add_handler(PreCheckoutQueryHandler(pre_checkout))
    app.add_handler(MessageHandler(filters.SUCCESSFUL_PAYMENT, successful_payment))
    app.add_error_handler(error_handler)

    return app
