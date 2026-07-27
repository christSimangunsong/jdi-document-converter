const logger = require('../services/logger');

async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const delayMs = options.delayMs || 2000;
  const label = options.label || 'Operasi';

  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries) {
        logger.warn(`  ${label} gagal (percobaan ${attempt}/${maxRetries}): ${error.message}`);
        logger.info(`  Menunggu ${delayMs}ms sebelum mencoba lagi...`);
        await sleep(delayMs * attempt);
      }
    }
  }

  throw new Error(`${label} gagal setelah ${maxRetries} percobaan: ${lastError.message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { withRetry, sleep };
