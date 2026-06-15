// fbDownloader.js
// Facebook Video Downloader

import { sendMessage } from './telegramApiHelpers.js';

const FB_API_BASE = "https://nkka404-360api.hf.space/fb/dl?url=";
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
    console.log(`[streamToR2] Downloading: ${videoUrl.substring(0, 100)}...`);
    const response = await fetch(videoUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "video/*",
            "Referer": "https://facebook.com/"
        }
    });
    if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
    await env.MY_BUCKET.put(fileName, response.body, {
        httpMetadata: { contentType: 'video/mp4' }
    });
    console.log(`[streamToR2] Saved to R2: ${fileName}`);
    return fileName;
}

async function sendVideoFromR2(chatId, fileName, caption, thumbUrl, token, botKeyValue, env) {
    const object = await env.MY_BUCKET.get(fileName);
    if (!object) throw new Error("Video not found in R2");
    const videoBlob = await object.blob();
    const formData = new FormData();
    formData.append('chat_id', chatId.toString());
    formData.append('caption', caption);
    formData.append('parse_mode', PARSE_MODE);
    formData.append('supports_streaming', 'true');
    formData.append('video', videoBlob, 'facebook_video.mp4');
    if (thumbUrl) {
        try {
            const thumbRes = await fetch(thumbUrl);
            if (thumbRes.ok) formData.append('thumbnail', await thumbRes.blob(), 'thumb.jpg');
        } catch(e) { console.log("[sendVideoFromR2] No thumbnail"); }
    }
    const headers = {};
    if (botKeyValue) headers['X-Bot-Key'] = botKeyValue;
    const response = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
        method: 'POST',
        headers: headers,
        body: formData
    });
    return await response.json();
}

async function deleteFromR2(fileName, env) {
    try { await env.MY_BUCKET.delete(fileName); } catch(e) {}
}

export async function handleFBCommand(message, token, env, botKeyValue) {
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text || '';
    const args = text.split(' ');
    args.shift();
    let url = args.join(' ').trim();
    
    // Check if URL is in replied message
    if (!url && message.reply_to_message && message.reply_to_message.text) {
        const fbMatch = message.reply_to_message.text.match(/https?:\/\/(www\.|m\.)?facebook\.com\/\S+|https?:\/\/fb\.watch\/\S+/);
        if (fbMatch) url = fbMatch[0];
    }
    
    if (!url) {
        await sendMessage(token, chatId, 
            "<b>❌ Please provide a Facebook Video Link</b>\n\n" +
            "<b>Usage:</b> <code>/fb &lt;facebook_video_url&gt;</code>\n" +
            "<b>Or reply</b> to a message containing Facebook link with <code>/fb</code>",
            PARSE_MODE, null, botKeyValue);
        return;
    }
    
    const r2FileName = `fb_${userId}_${Date.now()}.mp4`;
    let statusMsgId = null;
    
    try {
        // Send initial status
        const statusResult = await tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: "<b>🔍 Processing Facebook video...</b>",
            parse_mode: PARSE_MODE
        }, botKeyValue);
        statusMsgId = statusResult.result?.message_id;
        
        // Call the API
        const apiUrl = `${FB_API_BASE}${encodeURIComponent(url)}`;
        console.log(`[handleFBCommand] Calling API: ${apiUrl}`);
        
        const response = await fetch(apiUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "application/json"
            }
        });
        
        const data = await response.json();
        console.log(`[handleFBCommand] API Response status: ${data.status}`);
        
        if (data.status !== "success") {
            throw new Error(data.message || "API returned error");
        }
        
        // ✅ FIXED: Correctly parse the response structure
        const videoTitle = data.data?.title || "Facebook Video";
        const downloadUrls = data.data?.download_urls || [];
        
        // Find HD video or any video
        let videoUrl = null;
        let videoQuality = "SD";
        
        for (const item of downloadUrls) {
            if (item.type === "video") {
                if (item.quality === "HD" && !videoUrl) {
                    videoUrl = item.url;
                    videoQuality = "HD";
                } else if (!videoUrl) {
                    videoUrl = item.url;
                }
            }
        }
        
        if (!videoUrl) {
            throw new Error("No video URL found in API response");
        }
        
        console.log(`[handleFBCommand] Found ${videoQuality} video: ${videoTitle}`);
        
        // Update status
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId, message_id: statusMsgId,
            text: "<b>☑️ Video found! Downloading...</b>",
            parse_mode: PARSE_MODE
        }, botKeyValue);
        
        // Download to R2
        await streamToR2(videoUrl, r2FileName, env);
        
        // Update status
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId, message_id: statusMsgId,
            text: "<b>📤 Uploading to Telegram...</b>",
            parse_mode: PARSE_MODE
        }, botKeyValue);
        
        // Prepare caption
        const user = message.from || {};
        const safeName = escapeHTML([user.first_name, user.last_name].filter(Boolean).join(' ') || "User");
        const caption = `<b>📹 Title:</b> <code>${escapeHTML(videoTitle.substring(0, 200))}</code>\n` +
                        `<b>━━━━━━━━━━━━━━━━━━━━━</b>\n` +
                        `<b>🔗 Source:</b> <a href="${url}">Watch On Facebook</a>\n` +
                        `<b>🎬 Quality:</b> ${videoQuality}\n` +
                        `<b>━━━━━━━━━━━━━━━━━━━━━</b>\n` +
                        `<b>Downloaded By:</b> <a href="tg://user?id=${userId}">${safeName}</a>`;
        
        // Send video
        const sendResult = await sendVideoFromR2(chatId, r2FileName, caption, null, token, botKeyValue, env);
        
        if (sendResult.ok) {
            // Delete status message
            await tgRequest(token, 'deleteMessage', { chat_id: chatId, message_id: statusMsgId }, botKeyValue);
        } else {
            throw new Error(sendResult.description || "Telegram refused the file");
        }
        
    } catch (error) {
        console.error("[handleFBCommand] Error:", error);
        const errorMessage = `<b>❌ Error: ${escapeHTML(error.message)}</b>`;
        if (statusMsgId) {
            await tgRequest(token, 'editMessageText', {
                chat_id: chatId, message_id: statusMsgId,
                text: errorMessage, parse_mode: PARSE_MODE
            }, botKeyValue);
        } else {
            await sendMessage(token, chatId, errorMessage, PARSE_MODE, null, botKeyValue);
        }
    } finally {
        // Clean up R2 file
        await deleteFromR2(r2FileName, env);
    }
}
