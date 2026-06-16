// FILE: functions/mp3Downloader.js

import { sendMessage } from './telegramApiHelpers.js';

const YT_SEARCH_API = "https://youtube-api.mycontrol-bot2.workers.dev/yt/search";
const YT_DOWNLOAD_API = "https://youtube-api.mycontrol-bot2.workers.dev/yt/audio";
const PARSE_MODE = 'HTML';

function escapeHTML(text = '') {
    if (!text) return '';
    return text.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatDuration(seconds) {
    if (!seconds) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
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

async function searchYouTube(query) {
    const apiUrl = `${YT_SEARCH_API}?q=${encodeURIComponent(query)}&limit=10`;
    const response = await fetch(apiUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!result.success || !result.results) {
        throw new Error(result.error || "No results found");
    }
    return result.results;
}

async function downloadAudio(videoId) {
    const apiUrl = `${YT_DOWNLOAD_API}?id=${videoId}`;
    const response = await fetch(apiUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(60000)
    });
    const result = await response.json();
    if (!result.success || !result.audio_url) {
        throw new Error(result.error || "Download failed");
    }
    return result;
}

export async function handleMP3Command(message, token, env, botKeyValue) {
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text || '';
    
    // Extract query
    let query = text.replace(/^\/mp3\s*/, '').trim();
    
    // Check if replying to a message
    if (!query && message.reply_to_message && message.reply_to_message.text) {
        query = message.reply_to_message.text.trim();
    }
    
    if (!query) {
        await sendMessage(token, chatId,
            "<b>🎵 How to use /mp3</b>\n\n" +
            "Send a song name or YouTube link:\n" +
            "<code>/mp3 မင်းသိင်္ခ ချစ်သူ</code>\n\n" +
            "Or reply to a message with /mp3",
            PARSE_MODE, null, botKeyValue);
        return;
    }
    
    let statusMsgId = null;
    
    try {
        // Send searching message
        const statusResult = await tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: `<b>🔍 Searching for:</b> <code>${escapeHTML(query)}</code>`,
            parse_mode: PARSE_MODE
        }, botKeyValue);
        statusMsgId = statusResult.result?.message_id;
        
        // Search YouTube
        const results = await searchYouTube(query);
        
        if (!results || results.length === 0) {
            throw new Error("No songs found. Please try again with different keywords.");
        }
        
        // Build inline keyboard
        const buttons = results.map((song, index) => {
            const title = song.title || `Song ${index + 1}`;
            const duration = song.duration ? ` (${formatDuration(song.duration)})` : '';
            // Truncate long titles
            const shortTitle = title.length > 50 ? title.substring(0, 47) + '...' : title;
            return [{
                text: `${index + 1}. ${shortTitle}${duration}`,
                callback_data: `mp3_${song.id}`
            }];
        });
        
        // Add cancel button
        buttons.push([{
            text: "❌ Cancel",
            callback_data: "mp3_cancel"
        }]);
        
        const reply_markup = {
            inline_keyboard: buttons
        };
        
        // Send list
        let listText = `<b>🎵 Select a song (1-10):</b>\n\n`;
        results.forEach((song, index) => {
            const title = song.title || `Song ${index + 1}`;
            const duration = song.duration ? `⏱ ${formatDuration(song.duration)}` : '';
            listText += `<b>${index + 1}.</b> <code>${escapeHTML(title.substring(0, 80))}</code> ${duration}\n`;
        });
        
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId,
            message_id: statusMsgId,
            text: listText,
            parse_mode: PARSE_MODE,
            reply_markup: reply_markup
        }, botKeyValue);
        
        // Store search results for callback handling
        // We'll use a cache (you can use env.KV if needed)
        const searchCacheKey = `mp3_search_${userId}`;
        // Store in memory or KV
        if (env.MP3_CACHE) {
            await env.MP3_CACHE.put(searchCacheKey, JSON.stringify(results), { expirationTtl: 300 });
        }
        
    } catch (error) {
        console.error("[handleMP3Command] Error:", error);
        const errorMessage = `<b>❌ Error:</b> ${escapeHTML(error.message)}`;
        if (statusMsgId) {
            await tgRequest(token, 'editMessageText', {
                chat_id: chatId,
                message_id: statusMsgId,
                text: errorMessage,
                parse_mode: PARSE_MODE
            }, botKeyValue);
        } else {
            await sendMessage(token, chatId, errorMessage, PARSE_MODE, null, botKeyValue);
        }
    }
}

// Handle callback query (when user selects a song)
export async function handleMP3Callback(callbackQuery, token, env, botKeyValue) {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;
    
    if (data === "mp3_cancel") {
        await tgRequest(token, 'deleteMessage', {
            chat_id: chatId,
            message_id: messageId
        }, botKeyValue);
        await tgRequest(token, 'answerCallbackQuery', {
            callback_query_id: callbackQuery.id,
            text: "❌ Cancelled",
            show_alert: false
        }, botKeyValue);
        return;
    }
    
    // Extract video ID
    const videoId = data.replace('mp3_', '');
    if (!videoId) {
        await tgRequest(token, 'answerCallbackQuery', {
            callback_query_id: callbackQuery.id,
            text: "❌ Invalid selection",
            show_alert: true
        }, botKeyValue);
        return;
    }
    
    // Acknowledge callback
    await tgRequest(token, 'answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: "⏳ Downloading audio...",
        show_alert: false
    }, botKeyValue);
    
    try {
        // Update message
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: `<b>📥 Downloading audio...</b>`,
            parse_mode: PARSE_MODE
        }, botKeyValue);
        
        // Download audio
        const audioData = await downloadAudio(videoId);
        const audioUrl = audioData.audio_url;
        const title = audioData.title || "Unknown Song";
        const artist = audioData.artist || "Unknown Artist";
        const duration = audioData.duration || 0;
        
        // Update message
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: `<b>📤 Uploading to Telegram...</b>`,
            parse_mode: PARSE_MODE
        }, botKeyValue);
        
        // Download audio to buffer
        const audioResponse = await fetch(audioUrl, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (!audioResponse.ok) throw new Error("Failed to download audio");
        
        const audioBuffer = await audioResponse.arrayBuffer();
        const fileSize = audioBuffer.byteLength;
        
        // Check size limit (50MB)
        if (fileSize > 50 * 1024 * 1024) {
            // Upload to R2 and send link
            const fileName = `mp3_${userId}_${Date.now()}.mp3`;
            await env.MY_BUCKET.put(fileName, audioBuffer, {
                httpMetadata: { contentType: 'audio/mpeg' }
            });
            
            // Generate download link
            const downloadUrl = `https://your-worker-url/${fileName}`; // You need to set up R2 public access
            
            await tgRequest(token, 'editMessageText', {
                chat_id: chatId,
                message_id: messageId,
                text: `<b>🎵 ${escapeHTML(title)}</b>\n\n` +
                      `<b>🎤 Artist:</b> ${escapeHTML(artist)}\n` +
                      `<b>⏱ Duration:</b> ${formatDuration(duration)}\n` +
                      `<b>📦 Size:</b> ${Math.round(fileSize / 1024 / 1024)}MB\n\n` +
                      `<b>⚠️ File too large for Telegram (50MB limit)</b>\n` +
                      `<a href="${downloadUrl}">📥 Download Here</a>`,
                parse_mode: PARSE_MODE,
                disable_web_page_preview: true
            }, botKeyValue);
            return;
        }
        
        // Send as audio (under 50MB)
        const formData = new FormData();
        formData.append('chat_id', chatId.toString());
        formData.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), `${title}.mp3`);
        formData.append('title', title);
        formData.append('performer', artist);
        formData.append('duration', duration.toString());
        formData.append('parse_mode', PARSE_MODE);
        
        const headers = {};
        if (botKeyValue) headers['X-Bot-Key'] = botKeyValue;
        
        const sendResult = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, {
            method: 'POST',
            headers: headers,
            body: formData
        });
        
        const sendData = await sendResult.json();
        
        if (sendData.ok) {
            // Delete status message
            await tgRequest(token, 'deleteMessage', {
                chat_id: chatId,
                message_id: messageId
            }, botKeyValue);
        } else {
            throw new Error(sendData.description || "Failed to send audio");
        }
        
    } catch (error) {
        console.error("[handleMP3Callback] Error:", error);
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: `<b>❌ Error:</b> ${escapeHTML(error.message)}`,
            parse_mode: PARSE_MODE
        }, botKeyValue);
    }
}