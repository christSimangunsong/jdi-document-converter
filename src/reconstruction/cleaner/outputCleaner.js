// ============================================================
// Output Cleaner (v29) — merapikan output TANPA menghapus konten
// ============================================================
// Kebijakan v29: JANGAN pernah menghapus baris/kalimat utuh dari
// output (pelajaran _dedupeConsecutive v27: 58.738 → 11.946 char).
// Modul ini hanya:
//   1. Menghapus TOKEN garbage OCR murni (CJK acak, simbol terisolasi,
//      superscript berulang, run fragmen mirror) — kata Latin, angka,
//      kalimat, dan baris utuh TIDAK disentuh.
//   2. Normalisasi spasi ganda di dalam baris.
//   3. Normalisasi angka yang menempel di kata ("TAHUN2020" -> "TAHUN 2020").
// Baris yang tersisa kosong (semula murni garbage) dipertahankan
// sebagai baris kosong — tidak dihapus, tidak digabung dengan baris
// lain (struktur paragraf utuh).
//
// CATATAN: lebih konservatif daripada isGarbageWord() (qualityMetrics).
// isGarbageWord dipakai untuk SKORING halaman (dianggap garbage:
// digit pendek "1", "30%", huruf Latin tunggal "T" — sah sebagai data
// tabel/angka). Output cleaner TIDAK menghapus token semacam itu —
// hanya menghapus token yang tidak pernah sah dalam teks hukum
// Indonesia: CJK murni, simbol non-Latin (∪ ν ¹), superscript
// berulang, digit-dominan dengan ≤ 2 huruf (bukan Rp/angka murni),
// dan run bare mirror ("T E", "L R 3 1 E 5. E").
// ============================================================

// Aturan token terpusat di src/utils/garbageTokens.js (dipakai juga oleh
// router.js untuk pembersihan unconditional — satu sumber kebenaran).
const {
  isOutputGarbageToken,
  cleanLineText,
  cleanGarbageText,
} = require('../../utils/garbageTokens');

function cleanOutputText(text) {
  return cleanGarbageText(text);
}

function cleanLines(lines) {
  if (!lines || lines.length === 0) return [];
  return lines.map((line) => {
    const text = cleanLineText(line.text);
    if (text === line.text) return line;
    return { ...line, text };
  });
}

function countGarbageTokens(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0 && isOutputGarbageToken(w)).length;
}

module.exports = {
  isOutputGarbageToken,
  cleanLineText,
  cleanOutputText,
  cleanLines,
  countGarbageTokens,
};
