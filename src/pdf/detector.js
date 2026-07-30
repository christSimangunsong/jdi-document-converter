const pdfParse = require('pdf-parse');
const logger = require('../services/logger');

const MIN_TEXT_LENGTH = 200;
const MIN_CHARS_PER_PAGE = 15;
const MAX_IMAGE_RATIO_SCORE = 10;

async function detectPdfType(buffer) {
  try {
    const data = await pdfParse(buffer);
    const pageCount = data.numpages || 1;
    const text = data.text || '';
    const textLength = text.trim().length;

    if (textLength >= MIN_TEXT_LENGTH) {
      const charsPerPage = textLength / pageCount;
      if (charsPerPage >= MIN_CHARS_PER_PAGE) {
        logger.info(`  PDF terdeteksi sebagai TEXT (${textLength} chars, ${charsPerPage.toFixed(1)}/page)`);
        return { type: 'TEXT', pageCount, text };
      }
      logger.info(`  PDF TEXT dilewati: ${charsPerPage.toFixed(1)} chars/page terlalu rendah`);
    }

    const imageScore = estimateImageContent(buffer);
    if (imageScore > MAX_IMAGE_RATIO_SCORE) {
      logger.info(`  PDF terdeteksi sebagai SCAN (text: ${textLength} chars, imageScore: ${imageScore})`);
      return { type: 'SCAN', pageCount, text: '' };
    }

    if (textLength >= MIN_TEXT_LENGTH) {
      logger.info(`  PDF terdeteksi sebagai TEXT (${textLength} chars, imageScore: ${imageScore})`);
      return { type: 'TEXT', pageCount, text };
    }

    logger.info(`  PDF terdeteksi sebagai SCAN (text: ${textLength} chars, imageScore: ${imageScore})`);
    return { type: 'SCAN', pageCount, text: '' };
  } catch (error) {
    logger.warn(`  Gagal mendeteksi dengan pdf-parse, diasumsikan SCAN: ${error.message}`);
    return { type: 'SCAN', pageCount: 0, text: '' };
  }
}

function estimateImageContent(buffer) {
  try {
    const content = buffer.toString('latin1');
    const xObjectMatches = content.match(/\/XObject/g) || [];
    const imageMatches = content.match(/\/Subtype\s*\/Image/g) || [];
    const streamMatches = content.match(/stream\s*[\s\S]*?endstream/g) || [];
    let avgStreamSize = 0;
    if (streamMatches.length > 0) {
      let totalSize = 0;
      for (const s of streamMatches) {
        totalSize += s.length;
      }
      avgStreamSize = totalSize / streamMatches.length;
    }
    const imageCount = Math.max(xObjectMatches.length, imageMatches.length);
    const textOps = (content.match(/\([^)]{4,}\)/g) || []).length;
    const tjOps = (content.match(/TJ/g) || []).length;
    const textScore = textOps + tjOps * 5;
    return imageCount - textScore;
  } catch (err) {
    return 0;
  }
}

module.exports = { detectPdfType };
