const config = require('../config');
const logger = require('./logger');
const axios = require('axios');

const HEALTH_CHECK_TIMEOUT = 3000;
const MAX_PAGE_TIMEOUT = 720000;

/**
 * Client untuk sidecar table_ocr (hybrid img2table + PaddleX).
 * Node.js menentukan engine per halaman (gate piksel `detectWiredGridRegions`):
 *  - "paddlex"   : halaman dengan grid wired (colspan penting)
 *  - "img2table" : halaman lain (borderless / paragraf)
 * Jika sidecar tidak tersedia -> return null (caller skip, pipeline normal).
 */
async function healthCheck() {
  const url = config.tableAware.serviceUrl;
  if (!url) return false;
  try {
    await axios.get(`${url}/health`, { timeout: HEALTH_CHECK_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Array<{image: (Canvas|Buffer|string), engine: string}>} pages
 * @param {(detail: string) => void} [onDetail] — callback pesan detail per halaman (v30.5)
 * @returns {Promise<Array<{page:number, engine:string, tables:Array<{html:string,bbox:number[]}>, note:string}>|null>}
 */
async function analyzeTables(pages, onDetail) {
  const url = config.tableAware.serviceUrl;
  if (!url || !config.tableAware.enabled || !pages.length) return null;

  const alive = await healthCheck();
  if (!alive) {
    logger.warn('  Sidecar table-ocr tidak merespon, lewati table-aware OCR');
    return null;
  }

  const payload = [];
  for (const p of pages) {
    let b64 = '';
    if (typeof p.image === 'string') {
      b64 = p.image;
    } else if (Buffer.isBuffer(p.image)) {
      b64 = p.image.toString('base64');
    } else if (p.image && typeof p.image.toBuffer === 'function') {
      b64 = p.image.toBuffer('image/png').toString('base64');
    }
    payload.push({ image: b64, engine: p.engine === 'paddlex' ? 'paddlex' : 'img2table' });
  }

  try {
    const pageTimeout = Math.min(config.tableAware.timeout || MAX_PAGE_TIMEOUT, MAX_PAGE_TIMEOUT);
    const results = [];
    for (let idx = 0; idx < payload.length; idx++) {
      const p = payload[idx];
      try {
        logger.info(`  Kirim halaman ke table-ocr (${url})...`);
        if (onDetail) {
          const engineLabel = p.engine === 'paddlex' ? 'PaddleX (grid wired — bisa 1-9 mnt)' : 'img2table';
          onDetail(`Table-OCR halaman ${idx + 1}/${payload.length} (${engineLabel}) sedang berjalan...`);
        }
        const resp = await axios.post(`${url}/analyze`, { pages: [p] }, { timeout: pageTimeout });
        const r = resp.data && resp.data.results && resp.data.results[0];
        results.push(r || { tables: [], note: 'kosong' });
        if (onDetail) {
          const n = r && r.tables ? r.tables.length : 0;
          onDetail(`Table-OCR halaman ${idx + 1}/${payload.length} selesai — ${n} tabel ditemukan`);
        }
      } catch (err) {
        logger.warn(`  Sidecar table-ocr halaman gagal: ${err.message}, lewati halaman`);
        results.push({ tables: [], note: 'error' });
        if (onDetail) {
          onDetail(`Table-OCR halaman ${idx + 1}/${payload.length} gagal — dilewati (OCR blok dipertahankan)`);
        }
      }
    }
    return results;
  } catch (err) {
    logger.warn(`  Sidecar table-ocr error: ${err.message}`);
    return null;
  }
}

module.exports = { analyzeTables, healthCheck };
