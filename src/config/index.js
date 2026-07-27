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
};

module.exports = config;
