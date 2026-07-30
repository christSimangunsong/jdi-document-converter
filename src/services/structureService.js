const config = require('../config');
const logger = require('./logger');
const axios = require('axios');
const { performOcr } = require('../ocr/engine');
const { formatTableHtmlToText } = require('../utils/tableFormatter');

const SIDECAR_TIMEOUT = 30000;
const HEALTH_CHECK_TIMEOUT = 3000;

async function healthCheck(url) {
  try {
    await axios.get(`${url}/health`, { timeout: HEALTH_CHECK_TIMEOUT });
    return true;
  } catch {
    try {
      await axios.get(url, { timeout: HEALTH_CHECK_TIMEOUT });
      return true;
    } catch {
      return false;
    }
  }
}

async function analyzeWithSidecar(images, onProgress) {
  const sidecarUrl = config.structureServiceUrl;
  if (!sidecarUrl) throw new Error('Structure service URL not configured');

  const alive = await healthCheck(sidecarUrl);
  if (!alive) {
    logger.warn(`  PP-StructureV3 di ${sidecarUrl} tidak merespon, lewati`);
    throw new Error('Sidecar unreachable');
  }

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

    if (onProgress) onProgress(i + 1, images.length);
  }

  logger.info(`  Mengirim ${images.length} halaman ke sidecar di ${sidecarUrl}...`);

  const response = await axios.post(`${sidecarUrl}/analyze`, {
    images: base64Images,
    lang: config.ocrLang || 'id',
  }, { timeout: config.sidecarTimeout || 120000 });

  const data = response.data;
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

async function trySuryaSidecar(images, onProgress) {
  const suryaUrl = process.env.SURYA_SERVICE_URL;
  if (!suryaUrl) return null;

  const alive = await healthCheck(suryaUrl);
  if (!alive) {
    logger.warn(`  Surya sidecar di ${suryaUrl} tidak merespon, lewati`);
    return null;
  }

  try {
    const base64Images = [];
    for (let i = 0; i < images.length; i++) {
      const canvas = images[i];
      if (typeof canvas.toBuffer === 'function') {
        base64Images.push(canvas.toBuffer('image/png').toString('base64'));
      } else if (Buffer.isBuffer(canvas)) {
        base64Images.push(canvas.toString('base64'));
      } else {
        base64Images.push('');
      }
      if (onProgress) onProgress(i + 1, images.length);
    }

    const resp = await axios.post(`${suryaUrl}/analyze`, {
      images: base64Images,
      lang: config.ocrLang || 'id',
    }, { timeout: SIDECAR_TIMEOUT });

    if (!resp.data || !resp.data.pages) return null;

    return resp.data.pages.map(p => (p.text || ''));
  } catch (err) {
    logger.warn(`  Surya sidecar error: ${err.message}`);
    return null;
  }
}

async function performStructuredOcr(images, onProgress) {
  if (config.structureServiceUrl) {
    try {
      const results = await analyzeWithSidecar(images, onProgress);
      logger.info('  PP-StructureV3 berhasil');
      return results;
    } catch (error) {
      logger.warn(`  PP-StructureV3 gagal: ${error.message}`);
    }
  }

  if (process.env.SURYA_SERVICE_URL) {
    const suryaResult = await trySuryaSidecar(images, onProgress);
    if (suryaResult) {
      logger.info('  Surya sidecar berhasil');
      return suryaResult;
    }
  }

  logger.info('  Sidecar tidak tersedia, fallback ke OCR standar...');
  return performOcr(images, onProgress);
}

module.exports = { performStructuredOcr, analyzeWithSidecar };
