const axios = require('axios');
const config = require('../config');
const logger = require('./logger');
const { withRetry } = require('../utils/retry');

// Daftar nama field yang dicoba untuk menemukan URL PDF pada item peraturan.
// Dokumentasi JDIH hanya menunjukkan {id, converted}, jadi desain defensif:
// field asli bisa bernama url / pdf_url / file_path / source_path / dll.
// Terverifikasi live (jdih.dairikab.go.id, v30.2): field asli = url_file.
const PDF_URL_FIELDS = ['url', 'pdf_url', 'url_file', 'file_url', 'source_path', 'file_path', 'path', 'file'];

function getBaseUrl() {
  if (!config.jdi || !config.jdi.baseUrl) {
    throw new Error('JDIH_BASE_URL belum dikonfigurasi di .env');
  }
  return config.jdi.baseUrl.replace(/\/+$/, '');
}

function createClient() {
  return axios.create({
    baseURL: getBaseUrl(),
    timeout: config.jdi.timeout,
    auth:
      config.jdi.username || config.jdi.password
        ? { username: config.jdi.username, password: config.jdi.password }
        : undefined,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  });
}

// Normalisasi response GET: terima bentuk data.data (array) atau data (array).
function normalizeBatch(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.result)) return payload.result;
  return [];
}

// Cari field URL PDF pada satu item peraturan (desain defensif).
// Path relatif ("/storage/document/x.pdf") digabung dengan base URL JDIH.
function resolvePdfUrl(item) {
  if (!item || typeof item !== 'object') return null;
  for (const field of PDF_URL_FIELDS) {
    const value = item[field];
    if (typeof value === 'string' && value.trim()) {
      const url = value.trim();
      if (url.startsWith('/')) {
        if (!config.jdi || !config.jdi.baseUrl) return null;
        return `${config.jdi.baseUrl.replace(/\/+$/, '')}${url}`;
      }
      return url;
    }
  }
  return null;
}

async function fetchPeraturanBatch(batchSize) {
  const limit = batchSize || config.jdi.batchSize || 10;
  const response = await withRetry(
    () => createClient().get('/api/ocr/peraturan', { params: { limit } }),
    { maxRetries: config.maxRetries, delayMs: config.retryDelayMs, label: 'GET /api/ocr/peraturan' },
  );
  return normalizeBatch(response.data);
}

async function markConverted(id) {
  if (id == null) return false;
  await withRetry(
    () => createClient().patch(`/api/ocr/peraturan/${id}/converted`, {}),
    { maxRetries: config.maxRetries, delayMs: config.retryDelayMs, label: `PATCH converted #${id}` },
  );
  return true;
}

// Re-queue (v30.3): set converted=0 agar item muncul lagi di antrean
// (dipakai saat aktivitas dihapus dari DB). Bentuk payload belum diverifikasi
// server JDIH — bila gagal, panggil ini no-op aman (log warning).
async function markConvertedReset(id) {
  if (id == null) return false;
  await withRetry(
    () => createClient().patch(`/api/ocr/peraturan/${id}/converted`, { converted: 0 }),
    { maxRetries: config.maxRetries, delayMs: config.retryDelayMs, label: `PATCH converted=0 #${id}` },
  );
  return true;
}

// Uji koneksi: GET batch mentah untuk verifikasi kredensial + melihat field asli.
async function testConnection() {
  if (!config.jdi || !config.jdi.baseUrl) {
    return { ok: false, message: 'JDIH_BASE_URL belum dikonfigurasi di .env' };
  }
  try {
    const response = await createClient().get('/api/ocr/peraturan', { params: { limit: 3 } });
    const raw = response.data;
    const items = normalizeBatch(raw);
    return {
      ok: true,
      message: 'Koneksi berhasil — lihat contoh field di bawah',
      baseUrl: config.jdi.baseUrl,
      count: items.length,
      sample: items.slice(0, 3),
    };
  } catch (error) {
    const msg = error?.response?.data?.message || error?.message || 'Unknown error';
    logger.warn(`[JDIH] Uji koneksi gagal: ${msg}`);
    return { ok: false, message: msg };
  }
}

module.exports = {
  fetchPeraturanBatch,
  markConverted,
  markConvertedReset,
  resolvePdfUrl,
  normalizeBatch,
  testConnection,
  getBaseUrl,
};
