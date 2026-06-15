// ============================================================
// FILE: functions/txDownloader.js
// ============================================================

import { sendMessage } from './telegramApiHelpers.js';

const THRD_API_URL = "https://iam404.serv00.net/api/thrd/api.php";
const PARSE_MODE = 'HTML';

function escapeHTML(text = '') {
    if (!text) return '';
    return text.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function tgRequest(token, method, payload, botKeyValue) {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const headers = { 'Content-Type': 'application/json' };
    if (botKeyValue) headers['X-Bot-Key'] = botKeyValue;
    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
    });
    return await response.json();
}

async function streamToR2(videoUrl, fileName, env) {
    const response = await fetch(videoUrl);
    if (!response.ok) throw new Error("Failed to fetch video source");
    await env.MY_BUCKET.put(fileName, response.body, {
        httpMetadata: { contentType: 'video/mp4' }
    });
    return fileName;
}

async function sendVideoFromR2(chatId, fileName, caption, token, botKeyValue, env) {
    const object = await env.MY_BUCKET.get(fileName);
    if (!object) throw new Error("Video not found in R2");
    const formData = new FormData();
    formData.append('chat_id', chatId.toString());
    formData.append('caption', caption);
    formData.append('parse_mode', PARSE_MODE);
    formData.append('supports_streaming', 'true');
    formData.append('video', await object.blob(), 'twitter_video.mp4');
    const headers = {};
    if (botKeyValue) headers['X-Bot-Key'] = botKeyValue;
    const response = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
        method: 'POST',
        headers: headers,
        body: formData
    });
    return await response.json();
}

export async function handleTXCommand(message, token, env, botKeyValue) {
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text || '';
    const args = text.split(' ');
    args.shift();
    let url = args.join(' ').trim();
    
    if (!url && message.reply_to_message && message.reply_to_message.text) {
        const match = message.reply_to_message.text.match(/https?:\/\/(twitter\.com|x\.com)\/\S+/);
        if (match) url = match[0];
    }
    
    if (!url) {
        await sendMessage(token, chatId,
            "<b>❌ Please provide a Twitter/X link</b>\n\n" +
            "<b>Usage:</b> <code>/tx &lt;twitter_video_url&gt;</code>",
            PARSE_MODE, null, botKeyValue);
        return;
    }
    
    const statusResult = await tgRequest(token, 'sendMessage', {
        chat_id: chatId,
        text: "<b>🔍 Initializing Twitter download...</b>",
        parse_mode: PARSE_MODE
    }, botKeyValue);
    const statusId = statusResult.result?.message_id;
    const r2FileName = `twitter_${userId}_${Date.now()}.mp4`;
    
    try {
        const apiRes = await fetch(`${THRD_API_URL}?url=${encodeURIComponent(url)}`);
        const json = await apiRes.json();
        
        if (json.status !== "success" || !json.data?.results) {
            throw new Error("Invalid or private video");
        }
        
        const results = json.data.results;
        const videoLink = results.audio || (results.videos && results.videos[0]);
        if (!videoLink) throw new Error("No video link found");
        
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId, message_id: statusId,
            text: "<b>Found! ☑️ Downloading...</b>",
            parse_mode: PARSE_MODE
        }, botKeyValue);
        
        await streamToR2(videoLink, r2FileName, env);
        
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId, message_id: statusId,
            text: "<b>📤 Uploading to Telegram...</b>",
            parse_mode: PARSE_MODE
        }, botKeyValue);
        
        const user = message.from || {};
        const userFullName = escapeHTML(`${user.first_name || ''} ${user.last_name || ''}`.trim() || "User");
        
        const caption = `<b>🐦 Title:</b> ${escapeHTML(results.title || "Twitter Video")}\n` +
                        `<b>━━━━━━━━━━━━━━━━━━━━━</b>\n` +
                        `<b>🔗 Url:</b> <a href="${results.tweet_url || url}">Watch On Twitter</a>\n` +
                        `<b>⏱️ Duration:</b> ${results.duration || "N/A"}\n` +
                        `<b>━━━━━━━━━━━━━━━━━━━━━</b>\n` +
                        `<b>Downloaded By:</b> <a href="tg://user?id=${userId}">${userFullName}</a>`;
        
        const sendResult = await sendVideoFromR2(chatId, r2FileName, caption, token, botKeyValue, env);
        
        if (sendResult.ok) {
            await tgRequest(token, 'deleteMessage', { chat_id: chatId, message_id: statusId }, botKeyValue);
        } else {
            throw new Error(sendResult.description || "Failed to send video");
        }
    } catch (error) {
        console.error("[handleTXCommand] Error:", error);
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId, message_id: statusId,
            text: `<b>❌ Error: ${escapeHTML(error.message)}</b>`,
            parse_mode: PARSE_MODE
        }, botKeyValue);
    } finally {
        try { await env.MY_BUCKET.delete(r2FileName); } catch(e) {}
    }
}
