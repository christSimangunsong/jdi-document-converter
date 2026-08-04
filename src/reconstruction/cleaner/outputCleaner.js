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
  PAGE_NUMBER_RE,
  SALINAN_STAMP_RE,
  E_STAMP_RE,
  NIP_LINE_RE,
  TTD_LINE_RE,
  SALINAN_SESUAI_RE,
  KEPALA_BAGIAN_HUKUM_RE,
  PREAMBLE_HEADING_RE,
} = require('../../utils/garbageTokens');
const { mergeSplitWords } = require('../../utils/wordFixer');

function cleanOutputText(text) {
  return cleanGarbageText(text);
}

function cleanLines(lines) {
  if (!lines || lines.length === 0) return [];
  // (v30) Validasi dokumen untuk penggabungan kata terpecah: bentuk
  // gabungan yang muncul sebagai token di dokumen yang sama dianggap
  // sah (menguatkan kamus, mengoreksi kata yang terpecah konsisten).
  const docTokens = new Set();
  for (const line of lines) {
    for (const w of (line.text || '').split(/[^A-Za-z]+/)) {
      if (w.length >= 4) docTokens.add(w.toLowerCase());
    }
  }
  return lines.map((line) => {
    let text = cleanLineText(line.text);
    text = mergeSplitWords(text, docTokens);
    if (text === line.text) return line;
    return { ...line, text };
  });
}

// (v30) Buang chrome halaman: nomor halaman ("1", "- 3 -"), cap SALINAN
// ("SALINAN", "SALINAN E3") dan fragmen cap ("E3") di tepi atas/bawah tiap
// halaman, plus running header/footer (baris identik yang muncul di posisi
// tepi >= 50% halaman). Baris yang sama di posisi TENGAH tidak disentuh.
// (v30.1) Tambahan: (1) zona footer — 4 baris terbawah tiap halaman di-cek
// regex footer sah (NIP + digit, "ttd." murni, "Salinan sesuai dengan
// aslinya", "KEPALA BAGIAN HUKUM"); (2) running chrome diperluas ke 2 baris
// teratas/terbawah per halaman (footer berlapis: "... KEPALA BAGIAN HUKUM
// ttd. NIP."); (3) dedup global heading preambul murni ("Menimbang :" dll)
// — heading legal unik per dokumen, duplikat = artefak ghost layer.
function filterPageChrome(lines) {
  if (!lines || lines.length === 0) return [];
  const groups = {};
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i].page != null ? lines[i].page : 0;
    if (!groups[p]) groups[p] = [];
    groups[p].push(i);
  }
  const pageCount = Object.keys(groups).length;
  const dropIdx = new Set();

  const firstTexts = new Map();
  for (const idxs of Object.values(groups)) {
    for (const pos of [0, 1]) {
      if (pos >= idxs.length) break;
      const t = (lines[idxs[pos]] && (lines[idxs[pos]].text || '').trim().toLowerCase()) || '';
      if (t) firstTexts.set(t, (firstTexts.get(t) || 0) + 1);
    }
  }
  const lastTexts = new Map();
  for (const idxs of Object.values(groups)) {
    for (const pos of [idxs.length - 1, idxs.length - 2]) {
      if (pos < 0) break;
      const t = (lines[idxs[pos]] && (lines[idxs[pos]].text || '').trim().toLowerCase()) || '';
      if (t) lastTexts.set(t, (lastTexts.get(t) || 0) + 1);
    }
  }

  const isRunningChrome = (count) => count >= Math.max(2, Math.ceil(pageCount * 0.5));

  const seenHeadings = new Set();

  for (const idxs of Object.values(groups)) {
    const n = idxs.length;
    // Baris tepi (2 teratas / 2 terbawah): nomor halaman, cap SALINAN,
    // fragmen E3, dan running header/footer identik >= 50% halaman.
    for (const pos of [0, 1, n - 2, n - 1]) {
      if (pos < 0 || pos >= n) continue;
      const line = lines[idxs[pos]];
      const t = (line.text || '').trim();
      if (!t) continue;
      if (PAGE_NUMBER_RE.test(t) || SALINAN_STAMP_RE.test(t) || E_STAMP_RE.test(t)) {
        dropIdx.add(idxs[pos]);
        continue;
      }
      const key = t.toLowerCase();
      if (pos <= 1 && isRunningChrome(firstTexts.get(key))) dropIdx.add(idxs[pos]);
      if (pos >= n - 2 && isRunningChrome(lastTexts.get(key))) dropIdx.add(idxs[pos]);
    }
    // Zona footer (v30.1): 4 baris terbawah tiap halaman — footer sah
    // dokumen hukum (NIP, ttd., Salinan sesuai, blok KEPALA BAGIAN HUKUM).
    for (let pos = Math.max(0, n - 4); pos < n; pos++) {
      const line = lines[idxs[pos]];
      const t = (line.text || '').trim();
      if (!t) continue;
      if (NIP_LINE_RE.test(t) || TTD_LINE_RE.test(t) || SALINAN_SESUAI_RE.test(t) || KEPALA_BAGIAN_HUKUM_RE.test(t)) {
        dropIdx.add(idxs[pos]);
      }
    }
    // (v30.1) Dedup heading preambul murni — "Menimbang :" dll unik per
    // dokumen; kemunculan ke-2+ (ghost layer) dibuang.
    for (const i of idxs) {
      const t = (lines[i].text || '').trim();
      if (!PREAMBLE_HEADING_RE.test(t)) continue;
      const key = t.toLowerCase();
      if (seenHeadings.has(key)) dropIdx.add(i);
      else seenHeadings.add(key);
    }
  }

  return lines.filter((l, i) => !dropIdx.has(i));
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
  filterPageChrome,
};
