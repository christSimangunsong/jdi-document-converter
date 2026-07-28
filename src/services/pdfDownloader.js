const axios = require('axios');
const config = require('../config');
const { withRetry } = require('../utils/retry');

function encodeUrl(raw) {
  try {
    const parsed = new URL(raw);
    return parsed.href;
  } catch {
    return raw.replace(/\s/g, '%20');
  }
}

async function downloadPdf(url) {
  const encoded = encodeUrl(url);
  const response = await withRetry(
    () =>
      axios.get(encoded, {
        responseType: 'arraybuffer',
        timeout: config.downloadTimeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }),
    {
      maxRetries: config.maxRetries,
      delayMs: config.retryDelayMs,
      label: `Download ${url}`,
    }
  );

  return Buffer.from(response.data);
}

module.exports = { downloadPdf };
