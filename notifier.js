async function sendTelegramMessage(message, inlineKeyboard = null) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!token || !chatId) return;

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    const body = {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
    };

    if (inlineKeyboard) {
        body.reply_markup = { inline_keyboard: inlineKeyboard };
    }

    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (error) {
        console.error('❌ Greška pri slanju Telegram poruke:', error.message);
    }
}

// Gradi inline keyboard za trade akcije (Close / Move SL to BE)
function tradeKeyboard(symbol) {
    const encodedSymbol = encodeURIComponent(symbol);
    return [
        [
            { text: '❌ Zatvori poziciju', callback_data: `close:${symbol}` },
            { text: '🔒 SL → Breakeven',   callback_data: `be:${symbol}` }
        ]
    ];
}

// Odgovori na Telegram callback_query (inline button tap)
async function answerCallbackQuery(callbackQueryId, text = 'OK') {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text })
        });
    } catch (_) {}
}

module.exports = { sendTelegramMessage, tradeKeyboard, answerCallbackQuery };
