// FILE: functions/mp3Downloader.js

import { sendMessage } from './telegramApiHelpers.js';

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

// ============================================================
// SIMPLE YOUTUBE SEARCH - Using public RSS feed
// ============================================================
async function searchYouTube(query) {
    const rssUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    
    try {
        const response = await fetch(rssUrl, {
            headers: { 
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const html = await response.text();
        
        const videoIds = [];
        const titles = [];
        const durations = [];
        
        // Extract video IDs
        const idRegex = /"videoId":"([^"]+)"/g;
        let match;
        while ((match = idRegex.exec(html)) !== null) {
            if (!videoIds.includes(match[1])) {
                videoIds.push(match[1]);
            }
            if (videoIds.length >= 10) break;
        }
        
        // Extract titles
        const titleRegex = /"title":{"runs":\[{"text":"([^"]+)"}\]}/g;
        while ((match = titleRegex.exec(html)) !== null) {
            titles.push(match[1]);
            if (titles.length >= 10) break;
        }
        
        // Extract durations
        const durationRegex = /"lengthText":{"simpleText":"([^"]+)"}/g;
        while ((match = durationRegex.exec(html)) !== null) {
            durations.push(match[1]);
            if (durations.length >= 10) break;
        }
        
        const results = [];
        const maxResults = Math.min(videoIds.length, titles.length, durations.length);
        
        for (let i = 0; i < maxResults && i < 10; i++) {
            results.push({
                id: videoIds[i] || '',
                title: titles[i] || `Video ${i + 1}`,
                duration: durations[i] || '0:00',
                author: 'YouTube'
            });
        }
        
        if (results.length === 0) {
            throw new Error("No results found. Please try different keywords.");
        }
        
        return results;
        
    } catch (error) {
        console.error("[searchYouTube] Error:", error);
        throw new Error(`Search failed: ${error.message}`);
    }
}

// ============================================================
// GET AUDIO URL - Using free APIs
// ============================================================
async function getAudioUrl(videoId) {
    // Try multiple free APIs
    const apis = [
        `https://api.tubemp3.cc/convert?url=https://youtube.com/watch?v=${videoId}`,
        `https://yt-api.com/api/convert?url=https://youtube.com/watch?v=${videoId}&format=mp3`
    ];
    
    for (const apiUrl of apis) {
        try {
            const response = await fetch(apiUrl, {
                headers: { 
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Accept": "application/json"
                },
                signal: AbortSignal.timeout(10000)
            });
            
            if (!response.ok) continue;
            
            const data = await response.json();
            
            if (data.url || data.download_url || data.link) {
                return {
                    audio_url: data.url || data.download_url || data.link,
                    title: data.title || 'Song',
                    artist: data.artist || data.author || 'Unknown',
                    duration: data.duration || 0
                };
            }
        } catch (e) {
            console.log(`API ${apiUrl} failed:`, e.message);
        }
    }
    
    // Fallback - send YouTube link
    return {
        audio_url: `https://www.youtube.com/watch?v=${videoId}`,
        title: 'YouTube Video',
        artist: 'YouTube',
        duration: 0,
        isFallback: true
    };
}

// ============================================================
// SEND AUDIO TO TELEGRAM
// ============================================================
async function sendAudioToTelegram(chatId, audioData, token, env, botKeyValue, statusMsgId) {
    try {
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId,
            message_id: statusMsgId,
            text: `<b>📥 Downloading audio...</b>`,
            parse_mode: PARSE_MODE
        }, botKeyValue);
        
        const audioResponse = await fetch(audioData.audio_url, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        
        if (!audioResponse.ok) throw new Error(`Download failed: ${audioResponse.status}`);
        
        const audioBuffer = await audioResponse.arrayBuffer();
        const fileSize = audioBuffer.byteLength;
        
        if (fileSize > 50 * 1024 * 1024) {
            await tgRequest(token, 'editMessageText', {
                chat_id: chatId,
                message_id: statusMsgId,
                text: `<b>❌ File too large:</b> ${Math.round(fileSize/1024/1024)}MB (max 50MB)`,
                parse_mode: PARSE_MODE
            }, botKeyValue);
            return;
        }
        
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId,
            message_id: statusMsgId,
            text: `<b>📤 Uploading to Telegram...</b>`,
            parse_mode: PARSE_MODE
        }, botKeyValue);
        
        const formData = new FormData();
        formData.append('chat_id', chatId.toString());
        formData.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), `${audioData.title}.mp3`);
        formData.append('title', audioData.title || "Song");
        formData.append('performer', audioData.artist || "Unknown");
        formData.append('duration', audioData.duration?.toString() || '0');
        
        const headers = {};
        if (botKeyValue) headers['X-Bot-Key'] = botKeyValue;
        
        const sendResult = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, {
            method: 'POST',
            headers: headers,
            body: formData
        });
        
        const sendData = await sendResult.json();
        
        if (sendData.ok) {
            await tgRequest(token, 'deleteMessage', {
                chat_id: chatId,
                message_id: statusMsgId
            }, botKeyValue);
        } else {
            throw new Error(sendData.description || "Failed to send audio");
        }
        
    } catch (error) {
        console.error("[sendAudioToTelegram] Error:", error);
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId,
            message_id: statusMsgId,
            text: `<b>❌ Error:</b> ${escapeHTML(error.message)}`,
            parse_mode: PARSE_MODE
        }, botKeyValue);
    }
}

// ============================================================
// MAIN COMMAND HANDLER
// ============================================================
export async function handleMP3Command(message, token, env, botKeyValue) {
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text || '';
    
    let query = text.replace(/^\/mp3\s*/, '').trim();
    query = query.replace(/^\/music\s*/, '').trim();
    
    if (!query && message.reply_to_message && message.reply_to_message.text) {
        query = message.reply_to_message.text.trim();
    }
    
    if (!query) {
        await sendMessage(token, chatId,
            "<b>🎵 How to use /mp3</b>\n\n" +
            "Send a song name:\n" +
            "<code>/mp3 မင်းသိင်္ခ ချစ်သူ</code>\n\n" +
            "Or send a YouTube link:\n" +
            "<code>/mp3 https://youtube.com/watch?v=xxx</code>",
            PARSE_MODE, null, botKeyValue);
        return;
    }
    
    let statusMsgId = null;
    
    try {
        const statusResult = await tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: `<b>🔍 Searching for:</b> <code>${escapeHTML(query)}</code>`,
            parse_mode: PARSE_MODE
        }, botKeyValue);
        statusMsgId = statusResult.result?.message_id;
        
        // Check if it's a YouTube link
        let videoId = null;
        const urlMatch = query.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
        if (urlMatch) {
            videoId = urlMatch[1];
        }
        
        let results = [];
        
        if (videoId) {
            results = [{
                id: videoId,
                title: 'YouTube Video',
                duration: '0:00',
                author: 'YouTube'
            }];
        } else {
            results = await searchYouTube(query);
        }
        
        if (!results || results.length === 0) {
            throw new Error("No songs found. Please try again.");
        }
        
        // If only one result, download immediately
        if (results.length === 1 && videoId) {
            await tgRequest(token, 'editMessageText', {
                chat_id: chatId,
                message_id: statusMsgId,
                text: `<b>📥 Downloading...</b>`,
                parse_mode: PARSE_MODE
            }, botKeyValue);
            
            const audioData = await getAudioUrl(videoId);
            
            if (audioData.isFallback) {
                await tgRequest(token, 'editMessageText', {
                    chat_id: chatId,
                    message_id: statusMsgId,
                    text: `<b>🎵 ${escapeHTML(audioData.title)}</b>\n\n` +
                          `<b>⚠️ Direct download not available.</b>\n` +
                          `<a href="${audioData.audio_url}">🎬 Watch on YouTube</a>`,
                    parse_mode: PARSE_MODE,
                    disable_web_page_preview: true
                }, botKeyValue);
                return;
            }
            
            await sendAudioToTelegram(chatId, audioData, token, env, botKeyValue, statusMsgId);
            return;
        }
        
        // Build inline keyboard
        const buttons = results.map((song, index) => {
            const title = song.title || `Song ${index + 1}`;
            const duration = song.duration ? ` (${song.duration})` : '';
            const shortTitle = title.length > 50 ? title.substring(0, 47) + '...' : title;
            return [{
                text: `${index + 1}. ${shortTitle}${duration}`,
                callback_data: `mp3_${song.id}`
            }];
        });
        
        buttons.push([{
            text: "❌ Cancel",
            callback_data: "mp3_cancel"
        }]);
        
        const reply_markup = { inline_keyboard: buttons };
        
        let listText = `<b>🎵 Select a song:</b>\n\n`;
        results.forEach((song, index) => {
            const title = song.title || `Song ${index + 1}`;
            const duration = song.duration ? `⏱ ${song.duration}` : '';
            const shortTitle = title.length > 80 ? title.substring(0, 77) + '...' : title;
            listText += `<b>${index + 1}.</b> <code>${escapeHTML(shortTitle)}</code> ${duration}\n`;
        });
        
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId,
            message_id: statusMsgId,
            text: listText,
            parse_mode: PARSE_MODE,
            reply_markup: reply_markup
        }, botKeyValue);
        
        // Cache results
        if (!global.mp3SearchCache) global.mp3SearchCache = {};
        global.mp3SearchCache[userId] = { results, timestamp: Date.now() };
        
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

// ============================================================
// CALLBACK QUERY HANDLER
// ============================================================
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
    
    const videoId = data.replace('mp3_', '');
    if (!videoId) {
        await tgRequest(token, 'answerCallbackQuery', {
            callback_query_id: callbackQuery.id,
            text: "❌ Invalid selection",
            show_alert: true
        }, botKeyValue);
        return;
    }
    
    await tgRequest(token, 'answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: "⏳ Downloading...",
        show_alert: false
    }, botKeyValue);
    
    try {
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: `<b>📥 Downloading...</b>`,
            parse_mode: PARSE_MODE
        }, botKeyValue);
        
        const audioData = await getAudioUrl(videoId);
        
        if (audioData.isFallback) {
            await tgRequest(token, 'editMessageText', {
                chat_id: chatId,
                message_id: messageId,
                text: `<b>🎵 ${escapeHTML(audioData.title)}</b>\n\n` +
                      `<b>⚠️ Direct download not available.</b>\n` +
                      `<a href="${audioData.audio_url}">🎬 Watch on YouTube</a>`,
                parse_mode: PARSE_MODE,
                disable_web_page_preview: true
            }, botKeyValue);
            return;
        }
        
        await sendAudioToTelegram(chatId, audioData, token, env, botKeyValue, messageId);
        
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