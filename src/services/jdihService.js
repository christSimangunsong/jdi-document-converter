const crypto = require('crypto');
const config = require('../config');
const logger = require('./logger');
const { downloadPdf } = require('./pdfDownloader');
const { fetchPeraturanBatch, markConverted, markConvertedReset: patchConvertedReset, resolvePdfUrl } = require('./jdihApiClient');

// ---------------------------------------------------------------------------
// Orkestrator integrasi JDIH: polling GET /api/ocr/peraturan -> proses OCR ->
// hasil BERHASIL menunggu "Simpan ke Database" (lalu PATCH), hasil gagal
// langsung di-PATCH converted (PATCH semua status).
// ---------------------------------------------------------------------------

let processBufferFn = null;
let running = false;
let stopping = false;
let listener = null;

// id JDIH yang sudah pernah diproses (persisten antar run) — mencegah OCR ulang
// item yang masih menunggu disimpan / belum di-PATCH.
const seenIds = new Set();
// id JDIH yang BERHASIL tapi belum disimpan ke DB (belum di-PATCH).
const pendingSave = new Map();

const stats = {
  fetched: 0,
  processed: 0,
  patched: 0,
  failed: 0,
  skippedNoUrl: 0,
  pendingSave: 0,
  cycles: 0,
  lastRun: null,
};

function init(deps) {
  if (deps && typeof deps.processBuffer === 'function') {
    processBufferFn = deps.processBuffer;
  }
}

function isEnabled() {
  return Boolean(config.jdi && config.jdi.enabled && config.jdi.baseUrl);
}

function setListener(fn) {
  listener = typeof fn === 'function' ? fn : null;
}

function emit(event, data) {
  if (listener) {
    try {
      listener(event, data);
    } catch (e) {
      logger.warn(`[JDIH] Gagal kirim event ${event}: ${e.message}`);
    }
  }
}

function getStatus() {
  return {
    enabled: isEnabled(),
    baseUrl: config.jdi ? config.jdi.baseUrl : '',
    configured: Boolean(config.jdi && config.jdi.baseUrl && config.jdi.username && config.jdi.password),
    running,
    stopping,
    batchSize: config.jdi ? config.jdi.batchSize : 10,
    stats: { ...stats, pendingSave: pendingSave.size },
    lastRun: stats.lastRun,
  };
}

function stop() {
  stopping = true;
  logger.info('[JDIH] Perintah berhenti diterima — dokumen yang berjalan akan dibatalkan antar halaman');
}

function isStopRequested() {
  return stopping;
}

// Lempar error JDIH_ABORT saat tombol Berhenti ditekan — dipanggil dari
// callback progress pipeline (server.js) sehingga dokumen berjalan bisa
// dihentikan di sela antar halaman/fase.
function abortIfRequested() {
  if (stopping) {
    const err = new Error('Proses dihentikan oleh pengguna');
    err.code = 'JDIH_ABORT';
    throw err;
  }
}

// Re-queue (v30.3): setelah aktivitas dihapus dari DB, set converted=0 di
// server JDIH agar item muncul lagi di antrean. seenIds dihapus supaya run
// berikutnya memproses ulang item ini.
async function markConvertedReset(jdihId) {
  if (jdihId == null) return false;
  try {
    await patchConvertedReset(jdihId);
    seenIds.delete(String(jdihId));
    pendingSave.delete(String(jdihId));
    logger.info(`[JDIH] Re-queue #${jdihId} — converted di-reset ke 0 (aktivitas dihapus dari DB)`);
    return true;
  } catch (error) {
    logger.warn(`[JDIH] Re-queue #${jdihId} gagal: ${error.message} — item tetap converted di server JDIH`);
    return false;
  }
}

async function markConvertedPending(jdihId) {
  if (jdihId == null) return false;
  const key = String(jdihId);
  if (!pendingSave.has(key)) return false;
  try {
    await markConverted(jdihId);
    pendingSave.delete(key);
    stats.patched++;
    logger.info(`[JDIH] PATCH converted #${jdihId} (setelah disimpan ke DB)`);
    return true;
  } catch (error) {
    logger.warn(`[JDIH] PATCH converted #${jdihId} gagal: ${error.message} — akan dicoba lagi saat run berikutnya`);
    return false;
  }
}

function sanitizeFileName(name) {
  if (!name) return '';
  return String(name)
    .replace(/\.pdf$/i, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '_')
    .substring(0, 200);
}

// Header Basic Auth untuk download PDF bila host sama dengan server JDIH.
function buildAuthHeaders(url) {
  if (!config.jdi || !config.jdi.username || !config.jdi.password) return undefined;
  try {
    const urlHost = new URL(url).host;
    const baseHost = new URL(config.jdi.baseUrl).host;
    if (urlHost !== baseHost) return undefined;
    const token = Buffer.from(`${config.jdi.username}:${config.jdi.password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  } catch {
    return undefined;
  }
}

async function processItem(item, onProgress) {
  const id = item.id;
  stats.fetched++;

  const url = resolvePdfUrl(item);
  if (!url) {
    stats.skippedNoUrl++;
    logger.warn(`[JDIH] Item #${id} tidak memiliki field URL PDF (url/pdf_url/file_path/...) — dilewati, tanpa PATCH`);
    emit('skip', { id, item });
    return;
  }

  const fileName =
    sanitizeFileName(item.file_name || item.nama || item.judul || item.title) || `jdih-${id}`;

  let pdfBuffer;
  try {
    logger.info(`[JDIH] Download PDF #${id}: ${url}`);
    pdfBuffer = await downloadPdf(url, { headers: buildAuthHeaders(url) });
  } catch (error) {
    stats.failed++;
    logger.warn(`[JDIH] Download #${id} gagal: ${error.message} — ditandai converted (PATCH semua status)`);
    try {
      await markConverted(id);
      stats.patched++;
    } catch (e) {
      logger.warn(`[JDIH] PATCH #${id} gagal: ${e.message}`);
    }
    emit('error', { id, jdihId: id, status: 'GAGAL', error: error.message, durasi: '0.0 dtk', fileName });
    return;
  }

  const fileHash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

  let result;
  try {
    abortIfRequested();
    result = await processBufferFn(pdfBuffer, fileName, {
      sourceType: 'url',
      sourceUrl: url,
      originalName: fileName,
      fileHash,
    }, onProgress);
  } catch (error) {
    if (error && error.code === 'JDIH_ABORT') {
      // Dibatalkan pengguna di tengah dokumen — TANPA PATCH (tetap converted=0,
      // bisa diproses ulang pada run berikutnya).
      logger.warn(`[JDIH] #${id} dihentikan pengguna — tidak ditandai converted`);
      emit('error', {
        id,
        jdihId: id,
        status: 'DIHENTIKAN',
        error: 'Proses dihentikan oleh pengguna — item dapat diproses ulang',
        durasi: '0.0 dtk',
        fileName,
      });
      return;
    }
    result = {
      status: 'RUSAK',
      errorMessage: error.message,
      durasi: '0.0 dtk',
      pageCount: 0,
      type: null,
      ocrStatus: 'TIDAK DIPROSES',
      fileName,
    };
  }

  result.jdihId = id;
  result.jdihUrl = url;
  result.fileName = fileName;

  if (result.status === 'DIHENTIKAN') {
    // Sinyal dari processBuffer (abort di tengah fase) — tanpa PATCH dan
    // tanpa seenIds: item tetap bisa diproses ulang pada run berikutnya.
    logger.warn(`[JDIH] #${id} DIHENTIKAN — tidak ditandai converted`);
    emit('error', result);
    return;
  }

  if (result.status === 'BERHASIL') {
    seenIds.add(String(id));
    pendingSave.set(String(id), { id, url, fileName });
    stats.processed++;
    logger.info(`[JDIH] #${id} BERHASIL (${result.durasi}) — menunggu "Simpan ke Database" lalu PATCH otomatis`);
    emit('result', result);
  } else {
    seenIds.add(String(id));
    stats.failed++;
    logger.warn(`[JDIH] #${id} ${result.status} — ditandai converted (PATCH semua status)`);
    try {
      await markConverted(id);
      stats.patched++;
    } catch (e) {
      logger.warn(`[JDIH] PATCH #${id} gagal: ${e.message}`);
    }
    emit('error', result);
  }
}

async function runUntilEmpty() {
  if (running) {
    logger.warn('[JDIH] Siklus sudah berjalan — abaikan permintaan run baru');
    return { started: false, reason: 'already-running' };
  }
  if (!isEnabled()) {
    return { started: false, reason: 'disabled' };
  }
  if (!processBufferFn) {
    logger.error('[JDIH] pipeline belum di-init (init({ processBuffer }) belum dipanggil)');
    return { started: false, reason: 'no-pipeline' };
  }

  running = true;
  stopping = false;
  stats.cycles = 0;
  stats.fetched = 0;
  stats.processed = 0;
  stats.patched = 0;
  stats.failed = 0;
  stats.skippedNoUrl = 0;
  stats.lastRun = new Date().toISOString();
  const runStarted = Date.now();

  logger.info('[JDIH] Siklus dimulai — proses sampai antrean habis...');

  try {
    for (;;) {
      if (stopping) {
        logger.info('[JDIH] Dihentikan oleh pengguna');
        break;
      }

      let batch;
      try {
        batch = await fetchPeraturanBatch(config.jdi.batchSize);
      } catch (error) {
        logger.warn(`[JDIH] Gagal mengambil batch: ${error.message} — siklus dihentikan`);
        break;
      }

      if (!batch.length) {
        logger.info('[JDIH] Antrean kosong — selesai');
        break;
      }

      const newItems = batch.filter((item) => !seenIds.has(String(item.id)));
      if (!newItems.length) {
        logger.info(
          `[JDIH] ${batch.length} item sudah pernah diproses (${pendingSave.size} menunggu "Simpan ke Database") — siklus berhenti`,
        );
        break;
      }

      stats.cycles++;
      logger.info(`[JDIH] Siklus ${stats.cycles}: ${newItems.length} item baru dari batch ${batch.length}`);

      for (const item of batch) {
        if (stopping) break;
        if (seenIds.has(String(item.id))) continue;

        const fileName =
          sanitizeFileName(item.file_name || item.nama || item.judul || item.title) || `jdih-${item.id}`;

        await processItem(item, (inner) => {
          emit('progress', {
            pct: typeof inner === 'number' ? inner : inner.pct,
            phase: typeof inner === 'object' && inner.phase ? `[JDIH] ${inner.phase}` : '[JDIH] Memproses',
            fileName,
            ...(typeof inner === 'object' ? { page: inner.page, totalPages: inner.totalPages } : {}),
          });
        });
      }
    }
  } finally {
    running = false;
    stats.durationSec = ((Date.now() - runStarted) / 1000).toFixed(1);
    logger.info(
      `[JDIH] Siklus selesai: ${stats.fetched} diambil, ${stats.processed} berhasil, ${stats.failed} gagal, ` +
        `${stats.patched} di-PATCH, ${pendingSave.size} menunggu disimpan (${stats.durationSec} dtk)`,
    );
    emit('done', {
      total: stats.processed + stats.failed,
      processed: stats.processed,
      failed: stats.failed,
      patched: stats.patched,
      skipped: stats.skippedNoUrl,
      pending: pendingSave.size,
      durationSec: stats.durationSec,
    });
  }

  return { started: true };
}

module.exports = {
  init,
  runUntilEmpty,
  stop,
  isStopRequested,
  abortIfRequested,
  getStatus,
  markConvertedPending,
  markConvertedReset,
  setListener,
  isEnabled,
};
