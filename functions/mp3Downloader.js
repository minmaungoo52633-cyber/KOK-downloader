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
// YouTube Search - NO API KEY NEEDED
// Using YouTube's internal API (Innertube)
// ============================================================
async function searchYouTube(query) {
    const searchUrl = "https://www.youtube.com/youtubei/v1/search?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
    
    const payload = {
        context: {
            client: {
                hl: "en",
                gl: "US",
                clientName: "WEB",
                clientVersion: "2.20240101.00.00"
            }
        },
        query: query,
        maxResults: 10
    };
    
    try {
        const response = await fetch(searchUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        
        const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
        if (!contents) throw new Error("No results found");
        
        const results = [];
        for (const content of contents) {
            const video = content.itemSectionRenderer?.contents?.[0]?.videoRenderer;
            if (video?.videoId) {
                results.push({
                    id: video.videoId,
                    title: video.title?.runs?.[0]?.text || "Unknown",
                    duration: video.lengthText?.simpleText || "0:00",
                    author: video.ownerText?.runs?.[0]?.text || "Unknown",
                    thumbnail: video.thumbnail?.thumbnails?.[0]?.url || ""
                });
            }
            if (results.length >= 10) break;
        }
        
        if (results.length === 0) throw new Error("No videos found");
        return results;
        
    } catch (error) {
        console.error("[searchYouTube] Error:", error);
        throw new Error(`Search failed: ${error.message}`);
    }
}

// ============================================================
// YouTube Audio Download - NO API KEY NEEDED
// Using Piped (privacy-friendly YouTube frontend)
// ============================================================
async function downloadAudio(videoId) {
    // Try Piped API first (no key needed)
    const pipedApi = `https://pipedapi.kavin.rocks/streams/${videoId}`;
    
    try {
        const response = await fetch(pipedApi, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        
        if (!response.ok) throw new Error(`Piped API: ${response.status}`);
        
        const data = await response.json();
        
        // Find best audio stream
        const audioStream = data.audioStreams?.find(s => s.bitrate === "128kbps") || 
                           data.audioStreams?.find(s => s.codec === "mp4a.40.2") ||
                           data.audioStreams?.[0];
        
        if (!audioStream) throw new Error("No audio stream found");
        
        return {
            audio_url: audioStream.url,
            title: data.title || "Unknown Song",
            artist: data.uploader || "Unknown Artist",
            duration: data.duration || 0,
            thumbnail: data.thumbnailUrl || ""
        };
        
    } catch (error) {
        console.error("[downloadAudio] Piped failed, trying Invidious...", error.message);
        
        // Fallback: Invidious
        const invidiousApi = `https://inv.vern.cc/api/v1/videos/${videoId}`;
        
        try {
            const response = await fetch(invidiousApi, {
                headers: { "User-Agent": "Mozilla/5.0" }
            });
            
            if (!response.ok) throw new Error(`Invidious: ${response.status}`);
            
            const data = await response.json();
            
            // Get audio from adaptiveFormats
            const audioFormat = data.adaptiveFormats?.find(f => f.type?.includes('audio/mp4')) ||
                               data.adaptiveFormats?.find(f => f.bitrate < 128000) ||
                               data.adaptiveFormats?.[0];
            
            if (!audioFormat) throw new Error("No audio found");
            
            return {
                audio_url: audioFormat.url,
                title: data.title || "Unknown",
                artist: data.author || "Unknown",
                duration: data.lengthSeconds || 0,
                thumbnail: data.videoThumbnails?.[0]?.url || ""
            };
            
        } catch (fallbackError) {
            console.error("[downloadAudio] Both methods failed:", fallbackError.message);
            throw new Error("Download failed. Please try again later.");
        }
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
            // Direct download
            const audioData = await downloadAudio(videoId);
            results = [{
                id: videoId,
                title: audioData.title,
                duration: audioData.duration,
                author: audioData.artist
            }];
        } else {
            // Search
            results = await searchYouTube(query);
        }
        
        if (!results || results.length === 0) {
            throw new Error("No songs found. Please try again.");
        }
        
        // If only one result (direct link), download immediately
        if (results.length === 1 && videoId) {
            const audioData = await downloadAudio(videoId);
            await sendAudioToTelegram(chatId, audioData, token, env, botKeyValue, statusMsgId);
            return;
        }
        
        // Build inline keyboard with results
        const buttons = results.map((song, index) => {
            let title = song.title || `Song ${index + 1}`;
            let duration = '';
            if (song.duration) {
                if (typeof song.duration === 'string') {
                    duration = ` (${song.duration})`;
                } else {
                    duration = ` (${formatDuration(song.duration)})`;
                }
            }
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
            let title = song.title || `Song ${index + 1}`;
            let duration = '';
            if (song.duration) {
                if (typeof song.duration === 'string') {
                    duration = `⏱ ${song.duration}`;
                } else {
                    duration = `⏱ ${formatDuration(song.duration)}`;
                }
            }
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
        
        // Cache search results (in memory)
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
        
        // Download audio
        const audioResponse = await fetch(audioData.audio_url, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        
        if (!audioResponse.ok) throw new Error(`Download failed: ${audioResponse.status}`);
        
        const audioBuffer = await audioResponse.arrayBuffer();
        const fileSize = audioBuffer.byteLength;
        
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId,
            message_id: statusMsgId,
            text: `<b>📤 Uploading to Telegram...</b>`,
            parse_mode: PARSE_MODE
        }, botKeyValue);
        
        // Check size limit (50MB)
        if (fileSize > 50 * 1024 * 1024) {
            // File too large - upload to R2 if available
            if (env.MY_BUCKET) {
                const fileName = `mp3_${Date.now()}.mp3`;
                await env.MY_BUCKET.put(fileName, audioBuffer, {
                    httpMetadata: { contentType: 'audio/mpeg' }
                });
                
                const downloadUrl = `https://your-worker-url/${fileName}`;
                await tgRequest(token, 'editMessageText', {
                    chat_id: chatId,
                    message_id: statusMsgId,
                    text: `<b>🎵 ${escapeHTML(audioData.title)}</b>\n\n` +
                          `<b>🎤 Artist:</b> ${escapeHTML(audioData.artist)}\n` +
                          `<b>⏱ Duration:</b> ${formatDuration(audioData.duration)}\n` +
                          `<b>📦 Size:</b> ${Math.round(fileSize/1024/1024)}MB\n\n` +
                          `<b>⚠️ File too large (50MB+).</b>\n` +
                          `<a href="${downloadUrl}">📥 Download Here</a>`,
                    parse_mode: PARSE_MODE,
                    disable_web_page_preview: true
                }, botKeyValue);
                return;
            } else {
                throw new Error("File too large (50MB+) and no storage configured.");
            }
        }
        
        // Send audio
        const formData = new FormData();
        formData.append('chat_id', chatId.toString());
        formData.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), `${audioData.title}.mp3`);
        formData.append('title', audioData.title || "Song");
        formData.append('performer', audioData.artist || "Unknown");
        formData.append('duration', audioData.duration.toString());
        
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
                message_id: statusMsgId
            }, botKeyValue);
        } else {
            throw new Error(sendData.description || "Failed to send audio");
        }
        
    } catch (error) {
        console.error("[sendAudioToTelegram] Error:", error);
        throw error;
    }
}

// ============================================================
// CALLBACK QUERY HANDLER (when user clicks a song)
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
        const audioData = await downloadAudio(videoId);
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