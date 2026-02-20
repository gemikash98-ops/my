import { default as makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CONFIGURATION ---
const AUTH_PATH = './auth_info_baileys';
const targetGroups = ['120363419930344447@g.us']; // උඹේ Group ID එක
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const YTS_API = 'https://movies-api.accel.li/api/v2/list_movies.json';
const categories = ['horror', 'comedy', 'action', 'sci-fi', 'thriller', 'animation', 'adventure', 'fantasy'];
let currentCatIndex = 0;

// Directories හදමු
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);
if (!fs.existsSync('./sent')) fs.mkdirSync('./sent');

async function connectToWhatsApp() {
    // GitHub එකට දාපු creds.json එක මෙතනින් load වෙනවා
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'info' }), // ටර්මිනල් එකේ විස්තර පේන්න
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        printQRInTerminal: false // දැන් QR ඕනේ නැති නිසා මේක false කළා
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log('\n🚀 ==========================================');
            console.log('✅ BOT IS SUCCESSFULLY ONLINE!');
            console.log('📱 Connected to WhatsApp via uploaded session.');
            console.log('==========================================\n');
            startProcessing(sock); 
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('🔄 Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        }
    });
}

async function startProcessing(sock) {
    while (true) {
        const category = categories[currentCatIndex];
        console.log(`\n🔍 Checking Category: ${category.toUpperCase()}`);

        try {
            const response = await axios.get(`${YTS_API}?genre=${category}&sort_by=latest&limit=15`);
            const result = response.data;

            if (result.status === 'ok' && result.data.movies) {
                for (const movie of result.data.movies) {
                    const logName = movie.title.replace(/[^a-zA-Z0-9]/g, '_');
                    
                    if (!fs.existsSync(`./sent/${logName}.txt`)) {
                        console.log(`\n🎯 New Movie Found: ${movie.title}`);
                        
                        const details = `📽️ *MOVIE:* ${movie.title}\n📅 *Year:* ${movie.year}\n⭐ *Rating:* ${movie.rating}/10\n📂 *Genre:* ${movie.genres.join(', ')}\n\n_sithum-movie-bot_`;

                        // විස්තර සහ පෝස්ටර් එක යවනවා
                        const infoMsg = await sock.sendMessage(targetGroups[0], { image: { url: movie.large_cover_image }, caption: details });
                        const statusMsg = await sock.sendMessage(targetGroups[0], { text: `⏳ *Status:* Downloading movie...` });

                        const torrent = movie.torrents.find(t => t.quality === '720p') || movie.torrents[0];
                        const magnet = `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(movie.title)}&tr=udp://tracker.opentrackr.org:1337/announce`;

                        const success = await downloadAndSend(sock, movie.title, magnet, statusMsg, details);

                        if (success) {
                            await sock.sendMessage(targetGroups[0], { text: `✅ *DONE:* ${movie.title} sent successfully!`, edit: infoMsg.key });
                        }
                        
                        await sock.sendMessage(targetGroups[0], { delete: statusMsg.key });
                        fs.writeFileSync(`./sent/${logName}.txt`, 'done');
                        console.log('🚀 Moving to next movie...');
                        break; 
                    }
                }
            }
            currentCatIndex = (currentCatIndex + 1) % categories.length;
            await new Promise(r => setTimeout(r, 10000)); // විනාඩි 10ක් නවතිනවා
        } catch (e) {
            console.log('❌ Error in processing:', e.message);
            await new Promise(r => setTimeout(r, 20000));
        }
    }
}

async function downloadAndSend(sock, title, magnet, statusMsg, details) {
    return new Promise((resolve) => {
        console.log(`⬇️ Starting download: ${title}`);
        const dl = spawn('aria2c', [`--dir=${DOWNLOAD_DIR}`, '--seed-time=0', '--max-connection-per-server=16', '--split=16', magnet]);
        
        dl.stdout.on('data', async (data) => {
            const match = data.toString().match(/\(([^)]+)%\)/);
            if (match) {
                try { 
                    await sock.sendMessage(targetGroups[0], { text: `⏳ *Downloading:* ${title}\n📊 *Progress:* ${match[1]}%`, edit: statusMsg.key }); 
                } catch (e) {}
            }
        });

        dl.on('close', async () => {
            try {
                const files = execSync(`find "${DOWNLOAD_DIR}" -type f -name "*.mp4" -o -name "*.mkv"`, { encoding: 'utf8' }).split('\n').filter(f => f.trim() !== '');
                if (files.length > 0) {
                    console.log(`📤 Uploading file to WhatsApp...`);
                    await sock.sendMessage(targetGroups[0], { 
                        document: { url: files[0].trim() }, 
                        fileName: `${title}.mp4`, 
                        mimetype: 'video/mp4',
                        caption: `🎬 *${title}*\n\n${details}`
                    });
                    resolve(true);
                } else {
                    console.log('❌ No video file found after download.');
                    resolve(false);
                }
            } catch (err) { 
                console.log('❌ Error sending file:', err.message);
                resolve(false); 
            }
            finally { 
                try { execSync(`rm -rf "${DOWNLOAD_DIR}"/*`); } catch (e) {} 
            }
        });
    });
}

connectToWhatsApp();
