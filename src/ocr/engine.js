const { ocrRouter } = require('./router');

async function performOcr(imageBuffers, onProgress) {
  return ocrRouter.performOcr(imageBuffers, onProgress);
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

async function performOcrBlocks(imageBuffers, onProgress) {
  return ocrRouter.performOcrBlocks(imageBuffers, onProgress);
}

module.exports = { performOcr, performOcrBlocks, formatOcrResult };
