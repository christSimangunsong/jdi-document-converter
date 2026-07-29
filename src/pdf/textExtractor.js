const pdfParse = require('pdf-parse');
const { withRetry } = require('../utils/retry');
const config = require('../config');

async function extractText(buffer) {
  const data = await withRetry(() => pdfParse(buffer), {
    maxRetries: config.maxRetries,
    delayMs: config.retryDelayMs,
    label: 'Ekstrak teks PDF',
  });

  return {
    text: data.text || '',
    pageCount: data.numpages || 0,
  };
}

module.exports = { extractText };
