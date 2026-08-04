// ============================================================
// OCR Typos (v30.1) — normalisasi typo hasil OCR
// ============================================================
// Dua lapisan, keduanya konservatif (tidak menyentuh kata sah):
//
//   Lapisan 1 — Aturan generik (berlaku untuk SEMUA dokumen):
//     a. Kolon di dalam kata: "se:besar" -> "sebesar" — kolon antar
//        huruf tidak pernah valid dalam kata Indonesia ("12:30" aman:
//        kolon antar digit; "a.n." aman: titik).
//     b. Prefiks "¿" (U+00BF): lolos filter karakter textCleaner karena
//        berada di bawah \u00C0 -> di-strip bila diikuti huruf.
//     c. Prefiks "l" + konsonan: "lkegiatan" -> "kegiatan" — hanya bila
//        sisa kata >= 4 huruf DAN ada di kamus ID_WORD_DICT ("lampiran",
//        "lucu" aman: vokal setelah l; "lkjsdf" aman: bukan kata sah).
//     d. Sufiks "nyva" -> "nya": "besarnyva" -> "besarnya" — tidak ada
//        kata Indonesia mengandung "nyva" (v->y artefak OCR miring).
//
//   Lapisan 2 — Token map (OCR_TYPO_MAP): pola kesalahan berulang OCR
//   engine pada korpus dokumen hukum scan (BAE->BAB, Fasal->Pasal, dll).
//   Hanya token yang cocok persis (word boundary, case-preserving:
//   ALL-CAPS -> ALL-CAPS, Kapital -> Kapital). Token yang sudah berupa
//   kata benar ("bab", "pasal", "dengan") tidak pernah jadi kunci map.
// ============================================================

const { ID_WORD_DICT } = require('./wordFixer');

// Kunci lowercase token TYPO -> penggantian.
const OCR_TYPO_MAP = {
  bae: 'bab', // BAE III (cap mirror OCR)
  fasal: 'pasal', // Fasal 5
  daiei: 'dairi', // DAIEI (kabupaten Dairi)
  yancmaha: 'yang maha', // YANCMAHA ESA -> YANG MAHA ESA
  avat: 'ayat', // "avat (2)" -> "ayat (2)"
  nonor: 'nomor', // Nonor 8
  nornor: 'nomor', // Nornor 8
  kepaca: 'kepada', // "kepaca" (a->d)
  cengan: 'dengan', // "cengan" (c->d)
  euvati: 'bupati', // Euvati Dairi (E->B, u->u, v->p)
  memutuiskan: 'memutuskan', // MEMUTUISKAN : (swap u/i)
  udalah: 'sudah', // "¿udalah" setelah strip ¿ (¿ = OCR 's' miring)
};

// Preserve case: "BAE" -> "BAB", "Fasal" -> "Pasal", "avat" -> "ayat".
function _applyCase(token, replacement) {
  if (token === token.toUpperCase()) return replacement.toUpperCase();
  if (token.charAt(0) === token.charAt(0).toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function _applyTokenMap(text) {
  return text.replace(/[A-Za-z]+/g, (token) => {
    const rep = OCR_TYPO_MAP[token.toLowerCase()];
    if (!rep) return token;
    return _applyCase(token, rep);
  });
}

function fixOcrTypos(text) {
  if (!text) return text;
  let t = text;

  // (b) Prefiks ¿ diikuti huruf.
  t = t.replace(/¿(?=[A-Za-z])/g, '');

  // (a) Kolon antar huruf di dalam kata.
  t = t.replace(/([A-Za-z]):([A-Za-z])/g, '$1$2');

  // (d) Sufiks nyva -> nya (case-aware: BESARNYVA -> BESARNYA).
  t = t.replace(/\b([A-Za-z]{3,})nyva\b/g, (m, p1) => p1 + (/NYVA$/.test(m) ? 'NYA' : 'nya'));

  // (c) Prefiks l+konsonan dengan sisa kata sah di kamus.
  t = t.replace(/\b[lL][a-zA-Z]+\b/g, (w) => {
    if (w.length < 5) return w;
    const second = w.charAt(1).toLowerCase();
    if (!/[bcdfghjklmnpqrstvwxyz]/.test(second)) return w;
    const rest = w.slice(1);
    if (!ID_WORD_DICT.has(rest.toLowerCase())) return w;
    if (w.charAt(0) === 'L') return rest.charAt(0).toUpperCase() + rest.slice(1);
    return rest;
  });

  // (Lapisan 2) Token map.
  return _applyTokenMap(t);
}

module.exports = { fixOcrTypos, OCR_TYPO_MAP };
