const pino = require('pino');
const path = require('path');
const fs = require('fs');

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');
const name = process.env.LOG_NAME || 'throwback8sbot';

// ensure logs directory
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

let logger;
try {
  if (isProd) {
    const dest = pino.destination({ dest: path.join(logsDir, 'throwback8sbot.log'), sync: false });
    logger = pino({ level, name }, dest);
  } else {
    // prettier, human-friendly output in dev
    const transport = pino.transport({
      targets: [
        {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'yyyy-mm-dd HH:MM:ss.l o',
            ignore: 'pid,hostname'
          }
        },
        {
          target: 'pino/file',
          options: { destination: path.join(logsDir, 'throwback8sbot.log') }
        }
      ]
    });
    logger = pino({ level, name }, transport);
  }
} catch (e) {
  // fallback to console logger
  logger = pino({ level, name });
}

module.exports = logger;
