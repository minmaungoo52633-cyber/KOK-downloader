// ============================================================
// FILE: functions/ytDownloader.js
// (ORIGINAL - UNCHANGED)
// ============================================================

import { sendMessage } from './telegramApiHelpers.js';

const YT_API_URL = "https://nyeinkokoaung.alwaysdata.net/yt/dl-api.php";
const YT_SEARCH_API_URL = "https://nyeinkokoaung.alwaysdata.net/yt/search-info-api.php";
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

async function streamToR2(mediaUrl, fileName, type, env) {
    const response = await fetch(mediaUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
            'Accept': '*/*',
            'Referer': 'https://www.youtube.com/'
        }
    });
    if (!response.ok) throw new Error(`Failed to fetch ${type} source`);
    await env.MY_BUCKET.put(fileName, response.body, {
        httpMetadata: { contentType: type === 'video' ? 'video/mp4' : 'audio/mpeg' }
    });
    return fileName;
}

async function sendVideoFromR2(chatId, fileName, caption, thumbUrl, token, botKeyValue, env) {
    const object = await env.MY_BUCKET.get(fileName);
    if (!object) throw new Error("Video not found in R2");
    const formData = new FormData();
    formData.append('chat_id', chatId.toString());
    formData.append('caption', caption);
    formData.append('parse_mode', PARSE_MODE);
    formData.append('supports_streaming', 'true');
    formData.append('video', await object.blob(), 'video.mp4');
    if (thumbUrl) {
        try {
            const thumbRes = await fetch(thumbUrl);
            if (thumbRes.ok) formData.append('thumbnail', await thumbRes.blob(), 'thumb.jpg');
        } catch(e) {}
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

async function sendAudioFromR2(chatId, fileName, caption, videoDetails, token, botKeyValue, env) {
    const object = await env.MY_BUCKET.get(fileName);
    if (!object) throw new Error("Audio not found in R2");
    const formData = new FormData();
    formData.append('chat_id', chatId.toString());
    formData.append('caption', caption);
    formData.append('parse_mode', PARSE_MODE);
    formData.append('title', videoDetails.title.substring(0, 64));
    formData.append('performer', videoDetails.channel.substring(0, 64));
    formData.append('audio', await object.blob(), `${videoDetails.title.substring(0, 20)}.mp3`);
    if (videoDetails.thumbnail) {
        try {
            const thumbRes = await fetch(videoDetails.thumbnail);
            if (thumbRes.ok) formData.append('thumbnail', await thumbRes.blob(), 'thumb.jpg');
        } catch(e) {}
    }
    const headers = {};
    if (botKeyValue) headers['X-Bot-Key'] = botKeyValue;
    const response = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, {
        method: 'POST',
        headers: headers,
        body: formData
    });
    return await response.json();
}

async function searchYouTube(query) {
    const searchUrl = `${YT_SEARCH_API_URL}?action=search&query=${encodeURIComponent(query)}&limit=1`;
    const response = await fetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        signal: AbortSignal.timeout(30000)
    });
    const data = await response.json();
    if (!data.success || !data.data.length) throw new Error("No results found");
    const result = data.data[0];
    return {
        videoId: result.videoId,
        title: result.originalTitle || result.title,
        originalTitle: result.originalTitle || result.title,
        viewCount: result.viewCount,
        thumbnail: result.thumbnail,
        channel: result.channel,
        originalChannel: result.originalChannel || result.channel
    };
}

async function getYouTubeDownloadInfo(url) {
    const downloadUrl = `${YT_API_URL}?url=${encodeURIComponent(url)}`;
    const response = await fetch(downloadUrl, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        signal: AbortSignal.timeout(30000)
    });
    const data = await response.json();
    if (!data.success) throw new Error(data.error || "Could not extract video data");
    const apiData = data.raw_response?.api || data;
    const rawResponse = data.raw_response || {};
    const mediaItems = apiData.mediaItems || [];
    const download_links = {
        medias: mediaItems.map(item => ({
            url: item.mediaPreviewUrl || item.mediaUrl,
            quality: item.mediaQuality,
            type: item.type.toLowerCase(),
            is_audio: item.type === 'Audio'
        }))
    };
    let finalTitle = "Unknown Title";
    if (rawResponse.originalTitle) finalTitle = rawResponse.originalTitle;
    else if (apiData.originalTitle) finalTitle = apiData.originalTitle;
    else if (apiData.title) finalTitle = apiData.title;
    let finalChannel = "Unknown Channel";
    if (rawResponse.originalChannel) finalChannel = rawResponse.originalChannel;
    else if (apiData.userInfo?.originalName) finalChannel = apiData.userInfo.originalName;
    else if (apiData.userInfo?.name) finalChannel = apiData.userInfo.name;
    return {
        success: true,
        data: {
            title: finalTitle,
            originalTitle: finalTitle,
            channel: finalChannel,
            originalChannel: finalChannel,
            views: apiData.mediaStats?.viewsCount || "N/A",
            thumbnail: apiData.imagePreviewUrl || apiData.mediaItems?.[0]?.mediaThumbnail,
            download_links: download_links
        }
    };
}

async function checkFileSize(url) {
    try {
        const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        const size = parseInt(response.headers.get('content-length') || '0');
        return size / (1024 * 1024);
    } catch (e) {
        return null;
    }
}

async function processYTRequest(chatId, userId, message, input, mode, token, env, botKeyValue) {
    let statusId = null;
    const r2FileName = `yt_${userId}_${Date.now()}.${mode === 'audio' ? 'mp3' : 'mp4'}`;
    
    try {
        const statusResult = await tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: mode === 'video' ? "<b>🎬 Processing YouTube Video...</b>" : "<b>🎵 Processing YouTube Audio...</b>",
            parse_mode: PARSE_MODE
        }, botKeyValue);
        statusId = statusResult.result?.message_id;
        
        let finalUrl = input;
        let videoDetails = { views: "N/A", title: "Unknown", thumbnail: null, channel: "Unknown" };
        const isUrl = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/\S+/.test(input);
        
        if (!isUrl) {
            await tgRequest(token, 'editMessageText', {
                chat_id: chatId, message_id: statusId,
                text: "<b>🔍 Searching YouTube...</b>",
                parse_mode: PARSE_MODE
            }, botKeyValue);
            const searchResult = await searchYouTube(input);
            finalUrl = `https://www.youtube.com/watch?v=${searchResult.videoId}`;
            videoDetails = {
                views: searchResult.viewCount,
                title: searchResult.originalTitle || searchResult.title,
                thumbnail: searchResult.thumbnail,
                channel: searchResult.originalChannel || searchResult.channel
            };
        }
        
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId, message_id: statusId,
            text: "<b>Found! ☑️ Downloading...</b>",
            parse_mode: PARSE_MODE
        }, botKeyValue);
        
        const dlData = await getYouTubeDownloadInfo(finalUrl);
        
        if (isUrl) {
            videoDetails = {
                views: dlData.data.views,
                title: dlData.data.originalTitle || dlData.data.title,
                thumbnail: dlData.data.thumbnail,
                channel: dlData.data.originalChannel || dlData.data.channel
            };
        }
        
        const medias = dlData.data.download_links.medias;
        let downloadObj;
        if (mode === 'audio') {
            downloadObj = medias.find(m => m.type === 'audio');
        } else {
            downloadObj = medias.find(m => m.type === 'video');
        }
        
        if (!downloadObj?.url) throw new Error("No compatible format found");
        
        const fileSizeMB = await checkFileSize(downloadObj.url);
        if (fileSizeMB !== null && fileSizeMB > 100) {
            throw new Error(`Video file is too large (${fileSizeMB.toFixed(1)} MB).`);
        }
        
        const user = message.from || {};
        const fullName = escapeHTML([user.first_name, user.last_name].filter(Boolean).join(' ') || "User");
        
        const caption = `<b>${mode === 'audio' ? '🎵' : '🎥'} Title:</b> <code>${escapeHTML(videoDetails.title)}</code>\n` +
                        `<b>━━━━━━━━━━━━━━━━━━━━━</b>\n` +
                        `<b>👁️‍🗨️ Views:</b> ${videoDetails.views}\n` +
                        `<b>🎤 Channel:</b> ${escapeHTML(videoDetails.channel)}\n` +
                        `<b>🔗 URL:</b> <a href="${finalUrl}">Watch on YouTube</a>\n` +
                        `<b>━━━━━━━━━━━━━━━━━━━━━</b>\n` +
                        `<b>Downloaded By:</b> <a href="tg://user?id=${userId}">${fullName}</a>`;
        
        await streamToR2(downloadObj.url, r2FileName, mode, env);
        
        await tgRequest(token, 'editMessageText', {
            chat_id: chatId, message_id: statusId,
            text: "<b>📥 Uploading to Telegram...</b>",
            parse_mode: PARSE_MODE
        }, botKeyValue);
        
        let result;
        if (mode === 'audio') {
            result = await sendAudioFromR2(chatId, r2FileName, caption, videoDetails, token, botKeyValue, env);
        } else {
            result = await sendVideoFromR2(chatId, r2FileName, caption, videoDetails.thumbnail, token, botKeyValue, env);
        }
        
        if (result.ok) {
            await tgRequest(token, 'deleteMessage', { chat_id: chatId, message_id: statusId }, botKeyValue);
        } else {
            throw new Error(result.description || "Telegram refused the file");
        }
    } catch (error) {
        console.error("[processYTRequest] Error:", error);
        if (statusId) {
            await tgRequest(token, 'editMessageText', {
                chat_id: chatId, message_id: statusId,
                text: `<b>❌ ${escapeHTML(error.message)}</b>`,
                parse_mode: PARSE_MODE
            }, botKeyValue);
        }
    } finally {
        try { await env.MY_BUCKET.delete(r2FileName); } catch(e) {}
    }
}

export async function handleYTCommand(message, token, env, botKeyValue) {
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text || '';
    const args = text.split(' ');
    args.shift();
    let input = args.join(' ').trim();
    if (!input && message.reply_to_message && message.reply_to_message.text) {
        input = message.reply_to_message.text.trim();
    }
    if (!input) {
        await sendMessage(token, chatId,
            "<b>❌ Please provide a YouTube link or search query</b>\n\n" +
            "<b>Usage:</b> <code>/yt &lt;youtube_url_or_search&gt;</code>",
            PARSE_MODE, null, botKeyValue);
        return;
    }
    await processYTRequest(chatId, userId, message, input, 'video', token, env, botKeyValue);
}

export async function handleSongCommand(message, token, env, botKeyValue) {
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text || '';
    const args = text.split(' ');
    args.shift();
    let input = args.join(' ').trim();
    if (!input && message.reply_to_message && message.reply_to_message.text) {
        input = message.reply_to_message.text.trim();
    }
    if (!input) {
        await sendMessage(token, chatId,
            "<b>❌ Please provide a song name or YouTube link</b>\n\n" +
            "<b>Usage:</b> <code>/song &lt;song_name_or_url&gt;</code>",
            PARSE_MODE, null, botKeyValue);
        return;
    }
    await processYTRequest(chatId, userId, message, input, 'audio', token, env, botKeyValue);
}
