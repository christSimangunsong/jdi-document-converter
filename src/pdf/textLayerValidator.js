// Validasi kewarasan text-layer PDF (port murni dari table_aware_ocr.py)
// Logika TIDAK diubah: common_word_ratio() + text_layer_is_trustworthy()
// dari modul referensi yang sudah divalidasi empiris.

const MIN_CHARS_PER_PAGE = 40;
const COMMON_WORD_RATIO_THRESHOLD = 0.05;

// Kata umum Bahasa Indonesia + istilah baku dokumen hukum
const COMMON_WORDS = new Set([
  'yang',
  'dan',
  'dalam',
  'pada',
  'dengan',
  'tahun',
  'ayat',
  'pasal',
  'tentang',
  'atau',
  'untuk',
  'dari',
  'ini',
  'di',
  'ke',
  'adalah',
  'sebagaimana',
  'dimaksud',
  'peraturan',
  'daerah',
  'pemerintah',
]);

function commonWordRatio(text) {
  const words = (text || '').toLowerCase().match(/[a-zA-Z]+/g) || [];
  if (words.length < 15) return null;
  const hits = words.filter((w) => COMMON_WORDS.has(w)).length;
  return hits / words.length;
}

function textLayerIsTrustworthy(text) {
  if (!text || text.trim().length < MIN_CHARS_PER_PAGE) return false;
  const ratio = commonWordRatio(text);
  if (ratio === null) return true;
  return ratio >= COMMON_WORD_RATIO_THRESHOLD;
}

module.exports = { commonWordRatio, textLayerIsTrustworthy };
