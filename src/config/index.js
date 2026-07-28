const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const config = {
  outputDir: path.resolve(process.env.OUTPUT_DIR || './output'),
  logDir: path.resolve(process.env.LOG_DIR || './logs'),
  maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 3,
  retryDelayMs: parseInt(process.env.RETRY_DELAY_MS, 10) || 2000,
  downloadTimeout: parseInt(process.env.DOWNLOAD_TIMEOUT, 10) || 60000,
  ocrLang: process.env.OCR_LANG || 'id',
  pdfRenderScale: parseFloat(process.env.PDF_RENDER_SCALE) || 2.0,
  linksPath: path.resolve('./data/links.json'),
  db: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    name: process.env.DB_NAME || 'jdi_document_converter',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
  },
};

module.exports = config;
