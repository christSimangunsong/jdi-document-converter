// ============================================================
// Garbage Tokens (v29.1) — satu-sumber-kebenaran aturan token
// ============================================================
// Dipakai oleh:
//   - src/ocr/router.js         (pembersihan token unconditional di
//                                _rescueGarbageBlocks + _filterWholePageGarbageLines)
//   - src/reconstruction/cleaner/outputCleaner.js (via re-export)
//
// Kebijakan: HANYA menghapus token garbage OCR murni / run fragmen mirror.
// Kata Latin, angka, kalimat, dan baris utuh TIDAK disentuh (pelajaran
// _dedupeConsecutive v27: 58.738 -> 11.946 char karena penghapusan baris).
//
// Aturan:
//   1. Token garbage individual (CJK murni, simbol non-Latin, superscript
//      berulang, digit-dominan <= 2 huruf kecuali Rp).
//   2. Run mirror: >= 2 token bare berurutan (core 1 huruf/angka + punct
//      opsional, mis. "T E", "L R 3 1 E 5. E") yang memuat minimal satu
//      huruf tunggal -> seluruh run dihapus. Aman untuk "BAB I", "huruf a",
//      "1. Undang-Undang", "kota kecil Kota 1 1", "Rp 5.000", "1: 3:".
//   3. Normalisasi angka yang menempel di kata: "TAHUN2020" -> "TAHUN 2020",
//      "NOMOR20" -> "NOMOR 20" ("Rp1.500" aman: 2 huruf).
//   4. (v30) Gabung kata terpecah: "Dala m" -> "Dalam", "kerjasa ma" ->
//      "kerjasama" (kamus + validasi dokumen di src/utils/wordFixer.js).
//   5. (v30) Regex chrome halaman (nomor halaman, cap SALINAN, fragmen E3)
//      — dipakai outputCleaner.filterPageChrome + textCleaner legacy.
// ============================================================

const { mergeSplitWords } = require('./wordFixer');
const { fixOcrTypos } = require('./ocrTypos');

const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;
const SYMBOL_RE = /[\u0370-\u03FF\u2200-\u22FF\u2300-\u23FF\u2500-\u257F\u2070-\u209F\u00B2\u00B3\u00B9\u00BC-\u00BE]/;
const SYMBOL_RE_G =
  /[\u0370-\u03FF\u2200-\u22FF\u2300-\u23FF\u2500-\u257F\u2070-\u209F\u00B2\u00B3\u00B9\u00BC-\u00BE]/g;
const SUPERSCRIPT_RE_G = /[\u2070-\u209F\u00B2\u00B3\u00B9]/g;
const LATIN_RE = /[a-zA-Z\u00C0-\u024F]/;
const NON_ALNUM_EDGE_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

// (v30) Chrome halaman — artefak tepi yang bukan konten:
//  - Nomor halaman murni: "1", "2", "- 3 -", "·12·"
//  - Cap salinan: "SALINAN", "SALINAN E3" (E3 = fragmen cap)
//  - Fragmen cap terisolasi: "E3", "A5"
const PAGE_NUMBER_RE = /^[-–—·•]?\s*\d{1,3}\s*[-–—·•]?$/;
const SALINAN_STAMP_RE = /^SALINAN(\s+[A-Z0-9]{1,6})?$/i;
const E_STAMP_RE = /^[A-Z][0-9]{1,2}$/;

// (v30.1) Chrome footer dokumen hukum Indonesia — footer sah yang
// berulang di tepi bawah halaman:
//  - Baris NIP: "NIP. 19701022 1998031006", "NIP : 19701022"
//  - Baris ttd. murni
//  - "Salinan sesuai dengan aslinya" (cap bawah)
//  - "KEPALA BAGIAN HUKUM" (blok tanda tangan, hanya di zona footer)
const NIP_LINE_RE = /^NIP\.?\s*[:.-]?\s*\d[\d\s.-]{7,}$/i;
const TTD_LINE_RE = /^ttd\.?\s*:?$/i;
const SALINAN_SESUAI_RE = /^salinan sesuai dengan aslinya\b/i;
const KEPALA_BAGIAN_HUKUM_RE = /^kepala bagian hukum$/i;

// (v30.1) Heading preambul murni ("Menimbang :", "Mengingat :",
// "MEMUTUSKAN :") — unik per dokumen; duplikat (ghost layer) dibuang.
const PREAMBLE_HEADING_RE = /^(menimbang|mengingat|memutuskan|menetapkan)\s*:\s*$/i;

function isOutputGarbageToken(word) {
  const w = word || '';
  if (!w) return false;

  const hasCjk = CJK_RE.test(w);
  const hasRealLatin = LATIN_RE.test(w);

  // CJK murni pendek (国, 楼, 日本語) — tidak pernah sah.
  if (hasCjk && !hasRealLatin && w.length <= 8) return true;

  // Simbol non-Latin >= 40% tanpa huruf Latin ("ν1", "∪ aua") —
  // ciri OCR arah salah/miring.
  if (w.length >= 2) {
    const symbolCount = (w.match(SYMBOL_RE_G) || []).length;
    if (symbolCount / w.length >= 0.4 && !hasRealLatin) return true;
    // Superscript berulang ("u¹5nu1¹5aux") — ¹ tidak pernah sah di kata.
    if ((w.match(SUPERSCRIPT_RE_G) || []).length >= 2) return true;
  } else if (SYMBOL_RE.test(w) && !hasRealLatin) {
    // Simbol terisolasi 1 karakter ("∪", "ν", "¹").
    return true;
  }

  // Digit-dominan dengan huruf <= 2 ("bo20202") — bukan "Rp1.500"
  // (dikecualikan) atau angka murni ("1", "2020", "30%").
  if (w.length >= 5 && hasRealLatin) {
    const digits = (w.match(/\d/g) || []).length;
    const letters = (w.match(/[a-zA-Z]/g) || []).length;
    if (digits / w.length > 0.5 && letters <= 2 && !/^Rp/i.test(w)) return true;
  }

  return false;
}

// Inti token: huruf/angka tanpa punct di tepi ("T," -> "T", "5." -> "5").
function _core(word) {
  return word.replace(NON_ALNUM_EDGE_RE, '');
}

// Penanda daftar sah yang TIDAK boleh ikut dihapus run: "a.", "b)", "A.",
// "(1)", "(2)". ("1." / "5." sengaja TIDAK dilindungi — dalam run mirror
// seperti "L R 3 1 E 5. E", "5." adalah fragmen OCR, bukan penomoran;
// di posisi berdiri sendiri "1." tetap utuh karena run-nya hanya 1 token.)
function isListMarker(word) {
  return /^[a-zA-Z][.)]$/.test(word) || /^\(\d+\)$/.test(word);
}

// Token "bare" kandidat run mirror: core tepat 1 huruf/angka, punct opsional
// di tepi ("T", "3", "1", "5.", "E"). Bukan penanda daftar dan bukan "Rp".
function isGarbageRunToken(word) {
  const w = word || '';
  const c = _core(w);
  if (c.length !== 1) return false;
  if (isListMarker(w)) return false;
  if (w.toLowerCase() === 'rp') return false;
  return true;
}

// "T" -> true, "E" -> true; "1"/"5." -> false (digit, bukan huruf).
function _isSingleLetter(word) {
  return /^[a-zA-Z]$/.test(_core(word));
}

// Normalisasi angka 2-4 digit yang menempel di kata: "TAHUN2020" ->
// "TAHUN 2020", "NOMOR20" -> "NOMOR 20", "Pasal12" -> "Pasal 12".
// "Rp1.500" aman (2 huruf), "MP3" aman, "2020an" aman (mulai digit).
// (v30.4) Pola "NOMOR4TAHUN" (angka terjepit dua kata legal) -> "NOMOR 4 TAHUN".
function normalizeGluedWordNumber(text) {
  return text
    .replace(/\b(NOMOR)(\d{1,4})(TAHUN)\b/gi, '$1 $2 $3')
    .replace(/\b([A-Za-z]{3,})(\d{2,4})\b/g, '$1 $2');
}

// Normalisasi angka Romawi yang menempel di "BAB": "BABI" -> "BAB I",
// "BABII" -> "BAB II", "BABIV" -> "BAB IV". "BABINSA" aman (huruf N setelah
// I memutus [IVXLCDM]+), "BAB I" yang sudah berspasi tidak kena.
function normalizeGluedBABRoman(text) {
  return text.replace(/\b(BAB)([IVXLCDM]+)\b/g, '$1 $2');
}

// Rasio konsonan pada inti token (huruf saja): "s88rsT" -> 4/5 = 0.8,
// "Bupati" -> 3/6 = 0.5, "DPRD" -> 4/4 = 1.0. Digit/simbol murni -> null.
function _consonantRatio(word) {
  const c = _core(word);
  const letters = (c.match(/[a-zA-Z]/g) || []).length;
  if (letters === 0) return null;
  const vowels = (c.match(/[aeiouAEIOU]/g) || []).length;
  return (letters - vowels) / letters;
}

// Normalisasi dot internal pada kata huruf murni: "SAL.INAN" -> "SALINAN"
// (artefak OCR mirror). Aman: butuh >= 2 huruf di kedua sisi, jadi
// "Drs.", "a.n.", "e.g.", "P.T.", "NIP." (punct di tepi) tidak tersentuh.
function fixInternalDots(text) {
  return text.replace(/\b([A-Za-z]{2,})\.([A-Za-z]{2,})\b/g, '$1$2');
}

function cleanLineText(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';

  const words = t.split(' ');
  const removable = words.map((w) => isOutputGarbageToken(w));

  // Deteksi run fragmen mirror: blok berurutan token bare. Seluruh run
  // dihapus bila panjang >= 2 DAN memuat minimal satu huruf tunggal —
  // "T E" hilang, "kota kecil Kota 1 1" (digit saja) tetap utuh.
  const runRemovable = words.map(() => false);
  let i = 0;
  while (i < words.length) {
    if (!isGarbageRunToken(words[i])) {
      i++;
      continue;
    }
    let j = i;
    let hasLetter = false;
    while (j < words.length && isGarbageRunToken(words[j])) {
      if (_isSingleLetter(words[j])) hasLetter = true;
      j++;
    }
    if (j - i >= 2 && hasLetter) {
      for (let k = i; k < j; k++) runRemovable[k] = true;
    }
    i = j;
  }

  const kept = words.filter((w, idx) => {
    if (removable[idx] || runRemovable[idx]) return false;
    // Huruf tunggal yang mengikuti langsung penanda daftar ("b. I",
    // "d. F", "e. k" — sisa OCR kolom kecil di tabel): "b." penanda sah,
    // "I"/"F"/"k" fragmen angka/garbage. "a. 1" aman (digit), "a. b." aman
    // (marker bertanda titik).
    if (idx > 0 && isListMarker(words[idx - 1]) && _isSingleLetter(w) && !isListMarker(w)) return false;
    return true;
  });

  const result = fixInternalDots(normalizeGluedBABRoman(normalizeGluedWordNumber(kept.join(' '))));

  // (v30) Gabung kata terpecah ("Dala m" -> "Dalam", "kerjasa ma" ->
  // "kerjasama") berbasis kamus — aman: "di mana", "huruf a", "kota
  // kecil", "peraturan daerah" (frasa sah) tidak tersentuh.
  const merged = mergeSplitWords(result);

  // (v30.1) Normalisasi typo OCR ("BAE" -> "BAB", "se:besar" ->
  // "sebesar", "lkegiatan" -> "kegiatan") — berlaku pipeline + sel
  // tabel + legacy (satu sumber kebenaran).
  const typoFixed = fixOcrTypos(merged);

  // Baris tabel mirror/OCR rusak: seluruh token nyaris tanpa vokal
  // ("| s88rsT smuA rdsqms& rlslmsi Istsxgrnimsq ... |" — tabel yang ter-OCR
  // dengan arah salah). Baris dengan >= 5 token yang >70% konsonan-dense
  // adalah garbage murni. Baris prosa Indonesia normal selalu memuat vokal
  // cukup, dan runtun singkatan pendek (< 5 token) aman.
  const ratioList = typoFixed
    .split(' ')
    .map((w) => _consonantRatio(w))
    .filter((r) => r !== null);
  if (ratioList.length >= 5 && ratioList.filter((r) => r >= 0.7).length / ratioList.length >= 0.7) {
    return '';
  }
  return typoFixed;
}

// Versi multi-baris: tiap baris dibersihkan sendiri, baris yang tersisa
// kosong dipertahankan sebagai baris kosong (struktur paragraf utuh).
function cleanGarbageText(text) {
  if (!text) return '';
  return (text || '')
    .split('\n')
    .map((line) => cleanLineText(line))
    .join('\n');
}

module.exports = {
  CJK_RE,
  SYMBOL_RE,
  PAGE_NUMBER_RE,
  SALINAN_STAMP_RE,
  E_STAMP_RE,
  NIP_LINE_RE,
  TTD_LINE_RE,
  SALINAN_SESUAI_RE,
  KEPALA_BAGIAN_HUKUM_RE,
  PREAMBLE_HEADING_RE,
  isOutputGarbageToken,
  isGarbageRunToken,
  isListMarker,
  normalizeGluedWordNumber,
  normalizeGluedBABRoman,
  fixInternalDots,
  cleanLineText,
  cleanGarbageText,
};
