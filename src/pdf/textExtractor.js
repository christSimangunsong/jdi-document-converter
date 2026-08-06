const pdfParse = require('pdf-parse');
const { withRetry } = require('../utils/retry');
const config = require('../config');

async function extractText(buffer) {
  // pdf-parse (pdf.js v1.10.100) gagal dengan Buffer — butuh Uint8Array
  const data = await withRetry(() => pdfParse(new Uint8Array(buffer)), {
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
