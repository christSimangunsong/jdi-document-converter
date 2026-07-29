const config = require('../config');
const logger = require('./logger');
const { performOcr } = require('../ocr/engine');
const { formatTableHtmlToText } = require('../utils/tableFormatter');

async function analyzeWithSidecar(images, onProgress) {
  const base64Images = [];

  for (let i = 0; i < images.length; i++) {
    const canvas = images[i];
    const isCanvas = typeof canvas.toBuffer === 'function';

    if (isCanvas) {
      const buf = canvas.toBuffer('image/png');
      base64Images.push(buf.toString('base64'));
    } else if (Buffer.isBuffer(canvas)) {
      base64Images.push(canvas.toString('base64'));
    } else if (typeof canvas === 'string') {
      base64Images.push(canvas);
    } else {
      base64Images.push('');
    }

    if (onProgress) {
      onProgress(i + 1, images.length);
    }
  }

  const url = config.structureServiceUrl || 'http://localhost:5000';

  logger.info(`  Mengirim ${images.length} halaman ke sidecar di ${url}...`);

  const response = await fetch(`${url}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      images: base64Images,
      lang: config.ocrLang || 'id',
    }),
    signal: AbortSignal.timeout(config.sidecarTimeout || 120000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Sidecar error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const results = [];

  for (let i = 0; i < data.pages.length; i++) {
    const page = data.pages[i];
    let pageText = page.text || '';

    if (page.tables && page.tables.length > 0) {
      for (const table of page.tables) {
        const formatted = formatTableHtmlToText(table.html);
        pageText += '\n\n[TABEL]\n' + formatted + '\n[/TABEL]';
      }
    }

    results.push(pageText);
  }

  return results;
}

async function performStructuredOcr(images, onProgress) {
  if (!config.structureServiceUrl) {
    logger.info('  Sidecar tidak dikonfigurasi, fallback ke OCR standar...');
    return performOcr(images, onProgress);
  }

  try {
    const results = await analyzeWithSidecar(images, onProgress);
    logger.info('  Sidecar berhasil, hasil mengandung tabel terstruktur');
    return results;
  } catch (error) {
    logger.warn(`  Sidecar gagal: ${error.message}. Fallback ke OCR standar...`);
    return performOcr(images, onProgress);
  }
}

module.exports = { performStructuredOcr, analyzeWithSidecar };
