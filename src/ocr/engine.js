const config = require('../config');
const logger = require('../services/logger');
const { withRetry } = require('../utils/retry');

let ocrInstance = null;

async function getOcrInstance() {
  if (ocrInstance) return ocrInstance;

  logger.info('  Menginisialisasi PaddleOCR (ppu-paddle-ocr)...');
  const { PaddleOcrService } = await import('ppu-paddle-ocr');

  ocrInstance = new PaddleOcrService({
    recognition: {
      minimumConfidence: 0.3,
    },
  });

  await ocrInstance.initialize();
  logger.info('  PaddleOCR siap digunakan');
  return ocrInstance;
}

async function ocrImage(imageBuffer) {
  const ocr = await getOcrInstance();

  const result = await withRetry(
    async () => {
      const output = await ocr.recognize(imageBuffer);
      return output;
    },
    {
      maxRetries: config.maxRetries,
      delayMs: config.retryDelayMs,
      label: 'OCR halaman',
    }
  );

  return result;
}

function formatOcrResult(result) {
  if (!result || !result.text) return '';

  if (typeof result.text === 'string') return result.text;

  if (Array.isArray(result.text)) {
    return result.text
      .map((line) => {
        if (typeof line === 'string') return line;
        if (line.text) return line.text;
        if (line.words) return line.words.map((w) => w.text || w).join(' ');
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return String(result.text || '');
}

async function performOcr(imageBuffers, onProgress) {
  const results = [];

  for (let i = 0; i < imageBuffers.length; i++) {
    logger.info(`  OCR halaman ${i + 1}/${imageBuffers.length}...`);
    const result = await ocrImage(imageBuffers[i]);
    const pageText = formatOcrResult(result);
    results.push(pageText);

    if (onProgress) {
      onProgress(i + 1, imageBuffers.length);
    }
  }

  return results;
}

module.exports = { performOcr, formatOcrResult };
