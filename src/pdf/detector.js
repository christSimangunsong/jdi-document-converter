const pdfParse = require('pdf-parse');
const logger = require('../services/logger');

const MIN_TEXT_LENGTH = 50;

async function detectPdfType(buffer) {
  try {
    const data = await pdfParse(buffer);

    const pageCount = data.numpages;
    const text = data.text || '';
    const textLength = text.trim().length;

    if (textLength >= MIN_TEXT_LENGTH) {
      logger.info(`  PDF terdeteksi sebagai TEXT (${textLength} karakter ditemukan)`);
      return { type: 'TEXT', pageCount, text };
    }

    logger.info(`  PDF terdeteksi sebagai SCAN (hanya ${textLength} karakter)`);
    return { type: 'SCAN', pageCount, text: '' };
  } catch (error) {
    logger.warn(`  Gagal mendeteksi dengan pdf-parse, diasumsikan SCAN: ${error.message}`);
    return { type: 'SCAN', pageCount: 0, text: '' };
  }
}

module.exports = { detectPdfType };
