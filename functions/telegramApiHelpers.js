// telegramApiHelpers.js
// Telegram API Helper Functions

import { TELEGRAM_API } from './constants';

export async function sendMessage(token, chat_id, text, parse_mode = 'HTML', reply_markup = null, botKeyValue = null) {
    const apiUrl = `${TELEGRAM_API}${token}/sendMessage`;
    const payload = { chat_id, text, parse_mode, disable_web_page_preview: true };
    if (reply_markup) payload.reply_markup = reply_markup;
    
    const headers = { 'Content-Type': 'application/json' };
    if (botKeyValue) headers['X-Bot-Key'] = botKeyValue;
    
    try {
        const response = await fetch(apiUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload)
        });
        return await response.json();
    } catch (error) {
        console.error("[sendMessage] Error:", error);
        return { ok: false, description: error.message };
    }
}

export async function getMe(token, botKeyValue = null) {
    const apiUrl = `${TELEGRAM_API}${token}/getMe`;
    const headers = {};
    if (botKeyValue) headers['X-Bot-Key'] = botKeyValue;
    
    try {
        const response = await fetch(apiUrl, { headers });
        const result = await response.json();
        return result.ok ? result.result : null;
    } catch (error) {
        console.error("[getMe] Error:", error);
        return null;
    }
}

export async function setMyCommands(token, commands, botKeyValue = null) {
    const apiUrl = `${TELEGRAM_API}${token}/setMyCommands`;
    const payload = { commands };
    
    const headers = { 'Content-Type': 'application/json' };
    if (botKeyValue) headers['X-Bot-Key'] = botKeyValue;
    
    try {
        const response = await fetch(apiUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        return result.ok;
    } catch (error) {
        console.error("[setMyCommands] Error:", error);
        return false;
    }
}
