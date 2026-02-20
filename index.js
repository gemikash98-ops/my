import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const targetGroups = ['120363419930344447@g.us'];
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const YTS_API = 'https://movies-api.accel.li/api/v2/list_movies.json';

const categories = ['horror', 'comedy', 'action', 'sci-fi', 'thriller', 'animation', 'adventure', 'crime', 'fantasy', 'mystery'];
let currentCatIndex = 0;

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);
if (!fs.existsSync('./sent')) fs.mkdirSync('./sent');

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Akash-AI-Turbo", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'open') {
            console.log('--- ✅ MOVIE RUNNER IS ONLINE ---');
            startProcessing(sock); 
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        }
    });
}

async function handleSubtitles(sock, movieTitle) {
    try {
        const cleanName = movieTitle.replace(/\(\d{4}\)/g, '').trim();
        const search = await baiscopelksearch(cleanName);
        if (search.results && search.results.length > 0) {
            const subData = await baiscopelkdownload(search.results[0].url);
            if (subData.DOWN_URL) {
                await sock.sendMessage(targetGroups[0], { 
                    document: { url: subData.DOWN_URL }, 
                    fileName: `[SI-SUB]_${cleanName}.zip`, 
                    mimetype: 'application/zip',
                    caption: `🎬 *${movieTitle}*\n🇱🇰 සිංහල උපසිරැසිය මෙන්න!\n\n_sithum-movie-bot_`
                });
            }
        }
    } catch (e) { console.log("Sub Error"); }
}

async function startProcessing(sock) {
    while (true) {
        const category = categories[currentCatIndex];
        console.log(`\n🔍 Checking: ${category.toUpperCase()}`);

        try {
            const apiUrl = `${YTS_API}?genre=${category}&sort_by=latest&limit=5`;
            const rawData = execSync(`curl -L -s --insecure "${apiUrl}"`, { encoding: 'utf8' });
            const result = JSON.parse(rawData);

            if (result.status === 'ok' && result.data.movie_count > 0) {
                for (const movie of result.data.movies) {
                    const logName = movie.title.replace(/[^a-zA-Z0-9]/g, '_');
                    
                    if (!fs.existsSync(`./sent/${logName}.txt`)) {
                        console.log(`\n🎯 New Movie Found: ${movie.title}`);
                        
                        const movieDetails = `📽️ *MOVIE:* ${movie.title}\n\n` +
                                           `📅 *Year:* ${movie.year}\n` +
                                           `⭐ *Rating:* ${movie.rating}/10\n` +
                                           `⏳ *Runtime:* ${movie.runtime} min\n` +
                                           `📂 *Genre:* ${movie.genres.join(', ')}\n\n` +
                                           `━━━━━━━━━━━━━━━━━━\n` +
                                           `_sithum-movie-bot_`;

                        const infoMsg = await sock.sendMessage(targetGroups[0], { 
                            image: { url: movie.large_cover_image }, 
                            caption: movieDetails 
                        });

                        const statusMsg = await sock.sendMessage(targetGroups[0], { text: `⏳ *Status:* Preparing download...` });

                        const torrent = movie.torrents[0];
                        const magnet = `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(movie.title)}&tr=udp://tracker.opentrackr.org:1337/announce`;

                        const isMovieSent = await downloadMovie(sock, movie.title, magnet, statusMsg, movieDetails, movie.large_cover_image);

                        if (isMovieSent) {
                            await sock.sendMessage(targetGroups[0], { 
                                text: `✅ *COMPLETED:* ${movie.title}\n━━━━━━━━━━━━━━━━━━\n🍿 මූවී එක සාර්ථකව එක් කරන ලදී.`, 
                                edit: infoMsg.key 
                            });
                            await handleSubtitles(sock, movie.title);
                        } else {
                            await sock.sendMessage(targetGroups[0], { text: `❌ *FAILED:* ${movie.title}`, edit: infoMsg.key });
                        }

                        await sock.sendMessage(targetGroups[0], { delete: statusMsg.key });
                        fs.writeFileSync(`./sent/${logName}.txt`, 'done');
                        
                        console.log('✅ Waiting for 30 mins...');
                        await new Promise(r => setTimeout(r, 30 * 60 * 1000)); 
                        break; 
                    }
                }
            }
            currentCatIndex = (currentCatIndex + 1) % categories.length;
            await new Promise(r => setTimeout(r, 5000)); 
        } catch (e) { await new Promise(r => setTimeout(r, 10000)); }
    }
}

async function downloadMovie(sock, title, magnet, statusMsg, movieDetails, posterUrl) {
    return new Promise((resolve) => {
        const download = spawn('aria2c', [`--dir=${DOWNLOAD_DIR}`, '--seed-time=0', '--summary-interval=5', magnet]);
        
        download.stdout.on('data', async (data) => {
            const output = data.toString();
            const match = output.match(/\(([^)]+)%\)/);
            if (match) {
                const percentage = match[1];
                try {
                    await sock.sendMessage(targetGroups[0], { 
                        text: `⏳ *Downloading:* ${title}\n📊 *Progress:* ${percentage}%`, 
                        edit: statusMsg.key 
                    });
                } catch (e) {}
            }
        });

        download.on('close', async () => {
            try {
                const files = execSync(`find "${DOWNLOAD_DIR}" -name "*.mp4" -o -name "*.mkv"`, { encoding: 'utf8' }).split('\n').filter(f => f.trim() !== '');
                if (files.length > 0) {
                    const response = await axios.get(posterUrl, { responseType: 'arraybuffer' });
                    const thumbnail = Buffer.from(response.data, 'binary');

                    await sock.sendMessage(targetGroups[0], { 
                        document: { url: files[0].trim() }, 
                        fileName: `${title}.mp4`, 
                        mimetype: 'video/mp4',
                        jpegThumbnail: thumbnail,
                        caption: `🎬 *${title}*\n\n${movieDetails}\n\n🍿 *Enjoy Your Movie!*`
                    });
                    resolve(true);
                } else { resolve(false); }
            } catch (err) { resolve(false); }
            finally {
                try { execSync(`rm -rf "${DOWNLOAD_DIR}"/*`); } catch (e) {}
            }
        });
    });
}

connectToWhatsApp();
