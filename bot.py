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
    "https://t.me/+MLaX9UI1uuEyNTFi",
)
CHANNEL_USERNAME = os.environ.get("FACE_LAB_CHANNEL", "@FACELABS1")

WEBAPP_URL = os.environ.get("FACE_LAB_WEBAPP_URL", "")

# Prices in Telegram Stars (1 star ≈ 2 rubles)
PRICES = {
    "analysis":    LabeledPrice("1 анализ", 50),
    "sub_3d":      LabeledPrice("Подписка 3 дня", 100),
    "sub_7d":      LabeledPrice("Подписка 1 неделя", 300),
    "sub_30d":     LabeledPrice("Подписка 1 месяц", 500),
}

DURATIONS = {
    "analysis": 0,
    "sub_3d": 3 * 86400,
    "sub_7d": 7 * 86400,
    "sub_30d": 30 * 86400,
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
    Returns True if channel check is disabled or fails.
    """
    if not CHANNEL_USERNAME:
        return True
    try:
        member = await context.bot.get_chat_member(CHANNEL_USERNAME, user_id)
        return member.status in ("member", "administrator", "creator")
    except Exception as e:
        logger.warning(f"Channel check failed for {user_id}: {e}")
        return True


# ---------------------------------------------------------------------------
# Keyboard builders
# ---------------------------------------------------------------------------

def main_menu_keyboard(has_access: bool) -> InlineKeyboardMarkup:
    webapp_url = _webapp_url()
    buttons = []
    if has_access:
        if webapp_url.startswith("https://"):
            buttons.append(
                [InlineKeyboardButton("🔍 Запустить анализ лица", web_app=WebAppInfo(url=webapp_url))]
            )
        else:
            buttons.append(
                [InlineKeyboardButton("🔍 Запустить анализ лица", url=webapp_url)]
            )
    else:
        buttons.append([
            InlineKeyboardButton("💎 Купить 1 анализ — 50⭐", callback_data="pay:analysis"),
        ])
        buttons.append([
            InlineKeyboardButton("📦 Оформить подписку", callback_data="sub_menu"),
        ])
        buttons.append([
            InlineKeyboardButton("💰 Все тарифы", callback_data="prices"),
        ])

    buttons.append([
        InlineKeyboardButton("📊 История", callback_data="history"),
    ])
    return InlineKeyboardMarkup(buttons)


def sub_menu_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("💎 1 анализ — 50⭐", callback_data="pay:analysis")],
        [InlineKeyboardButton("🗓 3 дня — 100⭐", callback_data="pay:sub_3d")],
        [InlineKeyboardButton("📅 Неделя — 300⭐", callback_data="pay:sub_7d")],
        [InlineKeyboardButton("📆 Месяц — 500⭐", callback_data="pay:sub_30d")],
        [InlineKeyboardButton("◀️ Назад", callback_data="back_main")],
    ])


def prices_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("💎 1 анализ — 50⭐ (≈100₽)", callback_data="pay:analysis")],
        [InlineKeyboardButton("🗓 Подписка 3 дня — 100⭐ (≈200₽)", callback_data="pay:sub_3d")],
        [InlineKeyboardButton("📅 Подписка неделя — 300⭐ (≈600₽)", callback_data="pay:sub_7d")],
        [InlineKeyboardButton("📆 Подписка месяц — 500⭐ (≈1000₽)", callback_data="pay:sub_30d")],
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
            f"Для доступа к боту подпишитесь на наш канал:\n"
            f"<a href=\"{CHANNEL_LINK}\">{CHANNEL_LINK}</a>\n\n"
            f"После подписки нажмите /start",
            parse_mode="HTML",
            disable_web_page_preview=True,
        )
        return

    has_access = db.can_analyse(user.id)
    subscribed = db.is_subscribed(user.id)
    has_credit = db.has_paid_credit(user.id)

    if subscribed:
        info = db.get_subscription_info(user.id)
        remaining = int(info["expires_at"] - time.time())
        days = max(1, remaining // 86400)
        text = (
            f"👋 Привет, <b>{user.first_name}</b>!\n\n"
            f"📦 <b>Активная подписка</b> — ещё {days} дн.\n\n"
            f"Нажмите «🔍 Запустить анализ лица» для перехода к сканеру."
        )
    elif has_credit:
        user_info = db.get_user(user.id) or {}
        credits = user_info.get("paid_analyses", 0)
        text = (
            f"👋 Привет, <b>{user.first_name}</b>!\n\n"
            f"💎 У вас оплачено анализов: <b>{credits}</b>\n\n"
            f"Нажмите «🔍 Запустить анализ лица» для перехода к сканеру."
        )
    else:
        text = (
            f"👋 Привет, <b>{user.first_name}</b>!\n\n"
            f"🔬 <b>Face Lab</b> — профессиональный биометрический анализ лица по 52 метрикам.\n\n"
            f"🔒 <b>Запуск анализа доступен только после оплаты.</b>\n"
            f"Выберите подходящий тариф ниже для мгновенного доступа:"
        )

    await update.message.reply_text(
        text,
        parse_mode="HTML",
        reply_markup=main_menu_keyboard(has_access),
    )


# ---------------------------------------------------------------------------
# Callback queries
# ---------------------------------------------------------------------------

async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = query.data
    user_id = query.from_user.id

    await query.answer()

    if data == "back_main":
        has_access = db.can_analyse(user_id)
        text = "🏠 <b>Главное меню Face Lab</b>"
        await query.edit_message_text(text, parse_mode="HTML", reply_markup=main_menu_keyboard(has_access))
        return

    if data == "sub_menu":
        await query.edit_message_text(
            "📦 <b>Выберите подписку:</b>",
            parse_mode="HTML",
            reply_markup=sub_menu_keyboard(),
        )
        return

    if data == "prices":
        await query.edit_message_text(
            "💰 <b>Тарифы:</b>\n\n"
            "💎 <b>1 анализ</b> — 50⭐ (≈100₽)\n"
            "🗓 <b>3 дня</b> — 100⭐ (≈200₽)\n"
            "📅 <b>Неделя</b> — 300⭐ (≈600₽)\n"
            "📆 <b>Месяц</b> — 500⭐ (≈1000₽)\n\n"
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
        amount = PRICES[product].amount

        await context.bot.send_invoice(
            chat_id=user_id,
            title=f"Face Lab — {label}",
            description=f"Оплата: {label}",
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

    if product == "analysis":
        db.grant_analysis_credit(user_id)
        text = (
            "✅ <b>Оплата прошла!</b>\n\n"
            "💎 Теперь у вас есть <b>1 анализ</b>.\n\n"
            "Нажмите «Анализ лица» чтобы начать."
        )
    else:
        duration = DURATIONS.get(product, 0)
        if duration > 0:
            db.add_subscription(user_id, product, duration, payment_id)
        info = db.get_subscription_info(user_id)
        remaining = int(info["expires_at"] - time.time()) if info else 0
        days = remaining // 86400
        text = (
            f"✅ <b>Подписка активирована!</b>\n\n"
            f"📦 Действует <b>{days} дн.</b>\n\n"
            f"Нажмите «Анализ лица» чтобы начать."
        )

    has_access = db.can_analyse(user_id)
    await update.message.reply_text(
        text, parse_mode="HTML",
        reply_markup=main_menu_keyboard(has_access),
    )


# ---------------------------------------------------------------------------
# Bot setup
# ---------------------------------------------------------------------------

async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE):
    """Log errors and don't crash."""
    logger.error(f"Exception while handling an update: {context.error}")


def create_bot() -> Application:
    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CallbackQueryHandler(callback_handler))
    app.add_handler(PreCheckoutQueryHandler(pre_checkout))
    app.add_handler(MessageHandler(filters.SUCCESSFUL_PAYMENT, successful_payment))
    app.add_error_handler(error_handler)

    return app
