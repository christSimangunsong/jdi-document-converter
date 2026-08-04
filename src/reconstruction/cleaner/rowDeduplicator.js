// ============================================================
// ARSIP — TIDAK DIJALANKAN di alur aktif (v29)
// ============================================================
// Modul ini DIARSIPKAN atas keputusan user: deduplikasi baris OCR
// berisiko menghapus ISI DOKUMEN yang sah — dokumen hukum sering
// mengulang frasa/rujukan secara sah (Lampiran 1/2, "Mengingat",
// header berulang tiap halaman). Pelajaran v27: _dedupeConsecutive
// menghapus 58.738 → 11.946 char (31/37 baris) untuk dokumen 36 hlm.
//
// Kesimpulan (v29): jangan pernah menghapus baris/kalimat utuh dari
// output. Pembersihan yang aman = token-level garbage OCR murni
// (lihat cleaner/outputCleaner.js).
//
// Modul ini dipertahankan hanya sebagai referensi/opsi eksperimen.
// ============================================================
const logger = require('../../services/logger');

const WARN_RATIO = 0.25;
const MIN_TOKENS = 5;
const PREFIX_K = 3;
const LENGTH_RATIO = 0.85;
const COVERAGE_RATIO = 0.6;

function tokenize(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
}

function isTruncatedDuplicate(bTokens, aTokens) {
  if (bTokens.length > Math.floor(aTokens.length * LENGTH_RATIO)) return false;
  for (let i = 0; i < PREFIX_K; i++) {
    if (bTokens[i] !== aTokens[i]) return false;
  }
  const aSet = new Set(aTokens);
  let covered = 0;
  for (const t of bTokens) {
    if (aSet.has(t)) covered++;
  }
  return covered / bTokens.length >= COVERAGE_RATIO;
}

function dedupeRows(text) {
  const lines = (text || '').split('\n');
  const kept = [];
  const keptTokens = [];
  let removed = 0;
  for (const raw of lines) {
    const row = raw.trim();
    if (!row) {
      kept.push(raw);
      continue;
    }
    const bTokens = tokenize(row);
    let isDup = false;
    if (bTokens.length >= MIN_TOKENS) {
      for (let i = 0; i < keptTokens.length; i++) {
        if (isTruncatedDuplicate(bTokens, keptTokens[i])) {
          isDup = true;
          break;
        }
      }
    }
    if (isDup) {
      removed++;
    } else {
      kept.push(raw);
      keptTokens.push(bTokens);
    }
  }
  return { rows: kept, removed };
}

function dedupeOcrBlocks(blocks) {
  const stats = { totalRows: 0, keptRows: 0, removedRows: 0, warnBlocks: [] };
  const result = [];
  for (const block of blocks || []) {
    const text = block.text || '';
    const { rows, removed } = dedupeRows(text);
    const total = rows.length + removed;
    stats.totalRows += total;
    stats.keptRows += rows.length;
    stats.removedRows += removed;
    if (removed > 0 && total > 0 && removed / total > WARN_RATIO) {
      stats.warnBlocks.push({ page: block.page || 0, total, removed });
      logger.warn(
        `  Row dedup agresif: blok halaman ${block.page || 0} menghapus ${removed}/${total} baris (${Math.round(
          (removed / total) * 100,
        )}%) — perlu cek manual`,
      );
    }
    const newText = rows.join('\n');
    result.push(newText === text ? block : { ...block, text: newText });
  }
  return { blocks: result, stats };
}

module.exports = {
  tokenize,
  isTruncatedDuplicate,
  dedupeRows,
  dedupeOcrBlocks,
  WARN_RATIO,
  MIN_TOKENS,
  PREFIX_K,
  LENGTH_RATIO,
  COVERAGE_RATIO,
};
