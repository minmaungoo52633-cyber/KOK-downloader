// ============================================================
// PURE DOWNLOAD BOT - Facebook, TikTok, YouTube, Twitter/X
// ============================================================

// ============================================================
// FILE: functions/_middleware.js
// MAIN ENTRY POINT
// ============================================================

import { TELEGRAM_API, ADMIN_USERNAME, SUPPORT_GROUP_LINK, CONTROL_BOT_URL } from './constants.js';
import { sendMessage, getMe, setMyCommands } from './telegramApiHelpers.js';
import { handleFBCommand } from './fbDownloader.js';
import { handleTikTokCommand } from './tikDownloader.js';
import { handleYTCommand, handleSongCommand } from './ytDownloader.js';
import { handleTXCommand } from './txDownloader.js';
import { handleMP3Command, handleMP3Callback } from './mp3Downloader.js';

let botIdCache = null;

export async function onRequest(context) {
    const { request, env } = context;
    const token = env.TELEGRAM_BOT_TOKEN;

    console.log(`[onRequest] Received request: ${request.method} ${request.url}`);

    let requestBody = {};
    try {
        if (request.method === "POST" && request.headers.get("content-type")?.includes("application/json")) {
            requestBody = await request.clone().json();
            console.log("[onRequest] Full incoming request body:", JSON.stringify(requestBody, null, 2));
        }
    } catch (e) {
        console.error("[onRequest] Failed to parse request body as JSON:", e.message);
    }

    if (!token) {
        console.error("[onRequest] Error: TELEGRAM_BOT_TOKEN environment variable is not set.");
        return new Response("TELEGRAM_BOT_TOKEN environment variable is not set.", { status: 500 });
    }

    const url = new URL(request.url);
    const BOT_KEY = env.BOT_DATA;

    // --- Webhook Registration/Unregistration Routes ---
    if (request.method === "GET" && url.pathname.endsWith("/registerWebhook")) {
        const pagesUrl = url.origin + url.pathname.replace("/registerWebhook", "/");
        console.log(`[onRequest] Registering webhook: ${pagesUrl}`);
        const setWebhookApiUrl = `${TELEGRAM_API}${token}/setWebhook`;
        const payload = { url: pagesUrl, allowed_updates: ["message", "callback_query"] };
        try {
            const response = await fetch(setWebhookApiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Bot-Key": BOT_KEY },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            if (response.ok && result.ok) {
                console.log("[onRequest] Webhook registration successful:", result);

                // Set bot commands for download only
                const downloadCommands = [
                    { command: "start", description: "Start the bot" },
                    { command: "fb", description: "Download Facebook video" },
                    { command: "fbdl", description: "Download Facebook video" },
                    { command: "tik", description: "Download TikTok video" },
                    { command: "tiktok", description: "Download TikTok video" },
                    { command: "yt", description: "Download YouTube video" },
                    { command: "youtube", description: "Download YouTube video" },
                    { command: "song", description: "Download YouTube audio" },
                    { command: "audio", description: "Download YouTube audio" },
                    { command: "tx", description: "Download Twitter/X video" },
                    { command: "mp3", description: "Search and download MP3 from YouTube" },
                    { command: "music", description: "Search and download MP3 from YouTube" }
                ];

                await setMyCommands(token, downloadCommands, 'all_private_chats', null, BOT_KEY);
                return new Response(`Webhook registered to: ${pagesUrl}`, { status: 200 });
            } else {
                console.error("[onRequest] Webhook registration failed:", result);
                return new Response(`Webhook registration failed: ${result.description || JSON.stringify(result)}`, { status: 500 });
            }
        } catch (error) {
            console.error("[onRequest] Error during webhook registration:", error);
            return new Response(`Error registering webhook: ${error.message}`, { status: 500 });
        }
    } else if (request.method === "GET" && url.pathname.endsWith("/unregisterWebhook")) {
        const deleteWebhookApiUrl = `${TELEGRAM_API}${token}/deleteWebhook`;
        try {
            const response = await fetch(deleteWebhookApiUrl, { headers: { "X-Bot-Key": BOT_KEY } });
            const result = await response.json();
            if (response.ok && result.ok) {
                console.log("[onRequest] Webhook unregistered successfully");
                return new Response("Webhook unregistered successfully", { status: 200 });
            } else {
                return new Response(`Webhook unregistration failed: ${result.description || JSON.stringify(result)}`, { status: 500 });
            }
        } catch (error) {
            return new Response(`Error unregistering webhook: ${error.message}`, { status: 500 });
        }
    }

    // --- Main Telegram Update Handling (POST requests from Telegram) ---
    if (request.method === "POST") {
        try {
            const update = requestBody;

            if (Object.keys(update).length === 0) {
                console.warn("[onRequest] Received empty update body.");
                return new Response("OK - Empty update received", { status: 200 });
            }

            // Public User Bot Access Control
            if (!BOT_KEY) {
                console.warn("[onRequest] BOT_DATA environment variable is not set.");
                let chatId = null;
                if (update.message) { chatId = update.message.chat.id; }
                if (chatId) {
                    const userFriendlyMessage = `<b>🚨 Bot Service Unavailable 🚨</b>\n\nBot key is not configured properly. Please contact bot owner.`;
                    const reply_markup = {
                        inline_keyboard: [[{ text: "👤 Contact Owner", url: `https://t.me/${ADMIN_USERNAME.substring(1)}` }]]
                    };
                    await sendMessage(token, chatId, userFriendlyMessage, 'HTML', reply_markup, BOT_KEY);
                }
                return new Response("OK", { status: 200 });
            }

            const validationResponse = await fetch(CONTROL_BOT_URL, {
                method: 'POST',
                headers: { "Content-Type": "application/json", 'X-Bot-Key': BOT_KEY },
                body: JSON.stringify({ type: 'validate_key', key: BOT_KEY })
            });

            if (!validationResponse.ok) {
                console.warn(`[onRequest] Public User Bot Access Denied by Control Bot`);
                let chatId = null;
                if (update.message) { chatId = update.message.chat.id; }
                if (chatId) {
                    const userFriendlyMessage = `<b>🚨Bot Service Alert🚨</b>\n\n⚠️ This bot has expired or been disabled.\nPlease contact bot owner for details.`;
                    const reply_markup = {
                        inline_keyboard: [[{ text: "👤 Contact Owner", url: `https://t.me/${ADMIN_USERNAME.substring(1)}` }]]
                    };
                    await sendMessage(token, chatId, userFriendlyMessage, 'HTML', reply_markup, BOT_KEY);
                }
                return new Response("OK", { status: 200 });
            }
            console.log(`[onRequest] Bot key validated by Control Bot.`);

            // ============================================================
            // HANDLE CALLBACK QUERIES (for /mp3 selections)
            // ============================================================
            if (update.callback_query) {
                const callbackQuery = update.callback_query;
                const data = callbackQuery.data;
                
                console.log(`[onRequest] Callback query: ${data}`);
                
                // Handle /mp3 callback
                if (data && data.startsWith('mp3_')) {
                    await handleMP3Callback(callbackQuery, token, env, BOT_KEY);
                    return new Response("OK", { status: 200 });
                }
                
                // Add other callback handlers here if needed
                // Example: if (data && data.startsWith('download_')) { ... }
                
                return new Response("OK", { status: 200 });
            }

            // ============================================================
            // HANDLE MESSAGE UPDATES
            // ============================================================
            if (update.message) {
                const message = update.message;
                console.log(`[onRequest] Handling message update from user ${message.from.id} in chat ${message.chat.id}`);

                // Handle /start command
                if (message.text && message.text.startsWith('/start')) {
                    const fromUser = message.from;
                    await sendMessage(token, message.chat.id, 
                        `မင်္ဂလာပါ <a href="tg://user?id=${fromUser.id}">${fromUser.first_name}</a>!\n\n` +
                        `I'm a Media Downloader Bot. I can download videos from:\n` +
                        `📘 Facebook\n🎵 TikTok\n📺 YouTube\n🐦 Twitter/X\n\n` +
                        `Send me a link or use commands:\n` +
                        `<code>/fb &lt;facebook_url&gt;</code>\n` +
                        `<code>/tik &lt;tiktok_url&gt;</code>\n` +
                        `<code>/yt &lt;youtube_url_or_search&gt;</code>\n` +
                        `<code>/song &lt;song_name_or_url&gt;</code>\n` +
                        `<code>/tx &lt;twitter_url&gt;</code>\n` +
                        `<code>/mp3 &lt;song_name&gt;</code> - Search and download MP3`,
                        'HTML', null, BOT_KEY);
                    return new Response("OK", { status: 200 });
                }

                // Handle download commands
                if (message.text && message.text.startsWith('/')) {
                    const command = message.text.split(' ')[0].toLowerCase();
                    console.log(`[onRequest] Command: ${command}`);

                    switch (command) {
                        case '/fb':
                        case '/fbdl':
                            await handleFBCommand(message, token, env, BOT_KEY);
                            break;
                        case '/tik':
                        case '/tiktok':
                            await handleTikTokCommand(message, token, env, BOT_KEY);
                            break;
                        case '/yt':
                        case '/youtube':
                            await handleYTCommand(message, token, env, BOT_KEY);
                            break;
                        case '/song':
                        case '/audio':
                            await handleSongCommand(message, token, env, BOT_KEY);
                            break;
                        case '/tx':
                            await handleTXCommand(message, token, env, BOT_KEY);
                            break;
                        case '/mp3':
                        case '/music':
                            await handleMP3Command(message, token, env, BOT_KEY);
                            break;
                        default:
                            // If unknown command, ignore silently
                            console.log(`[onRequest] Unknown command: ${command}`);
                            break;
                    }
                    return new Response("OK", { status: 200 });
                }
                
                // Handle non-command messages (optional)
                // You can add logic here to auto-detect links
                // Example: if message contains YouTube link, auto-download
            }

            return new Response("OK", { status: 200 });
        } catch (error) {
            console.error("[onRequest] Error handling webhook:", error.stack || error.message);
            return new Response(`Error: ${error.message}`, { status: 500 });
        }
    } else {
        return new Response("This is a Telegram bot webhook endpoint. Send POST requests or access /registerWebhook", { status: 200 });
    }
}