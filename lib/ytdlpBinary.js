const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp');
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => https.get(u, res => {
      if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
    get(url);
  });
}

async function ensureYtdlp() {
  if (fs.existsSync(YTDLP_PATH)) return YTDLP_PATH;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  logger.info('ytdlp: downloading yt-dlp binary...');
  await download(YTDLP_URL, YTDLP_PATH);
  fs.chmodSync(YTDLP_PATH, 0o755);
  logger.info('ytdlp: download complete');
  return YTDLP_PATH;
}

module.exports = { ensureYtdlp, YTDLP_PATH };
