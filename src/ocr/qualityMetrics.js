const config = require('../config');

const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;

// Simbol non-Latin hasil OCR arah salah/miring: Yunani (ν), matematika (∪),
// superscript (¹), misc technical, box-drawing. Tidak pernah muncul dalam
// teks hukum Indonesia yang sah. Arrows (2190-21FF) & dingbats (2600-27BF)
// TIDAK termasuk — dipakai sah untuk ✓/☐/→ di sel tabel.
const SYMBOL_RE = /[\u0370-\u03FF\u2200-\u22FF\u2300-\u23FF\u2500-\u257F\u2070-\u209F\u00B2\u00B3\u00B9\u00BC-\u00BE]/;
const SYMBOL_RE_G = /[\u0370-\u03FF\u2200-\u22FF\u2300-\u23FF\u2500-\u257F\u2070-\u209F\u00B2\u00B3\u00B9\u00BC-\u00BE]/g;
const SUPERSCRIPT_RE_G = /[\u2070-\u209F\u00B2\u00B3\u00B9]/g;

function isGarbageWord(word) {
  const w = word || '';
  if (!w) return false;

  const digitRatio = (w.match(/\d/g) || []).length / w.length;
  const hasAlpha = /[a-zA-Z\u00C0-\u024F\u0400-\u04FF]/g.test(w);
  const hasCjk = CJK_RE.test(w);

  if (!hasAlpha && digitRatio > 0.5 && w.length <= 3) return true;
  if (hasCjk && !digitRatio && w.length <= 4) return true;
  if (!hasAlpha && hasCjk && digitRatio > 0 && w.length <= 6) return true;

  // Word sarat simbol non-Latin (≥40% karakter) tanpa huruf Latin sah —
  // ciri OCR arah salah ("ν1", "∪ aua", "₁₅aux").
  if (w.length >= 2) {
    const symbolCount = (w.match(SYMBOL_RE_G) || []).length;
    const hasRealLatin = /[a-zA-Z\u00C0-\u024F]/.test(w);
    if (symbolCount / w.length >= 0.4 && !hasRealLatin) return true;
    // Superscript berulang ("u¹5nu1¹5aux") — ¹ tidak pernah sah di kata.
    if ((w.match(SUPERSCRIPT_RE_G) || []).length >= 2) return true;
  } else if (SYMBOL_RE.test(w) && !/^[a-zA-Z\u00C0-\u024F]/.test(w)) {
    // Simbol terisolasi 1 karakter ("∪", "ν", "¹") — sel tabel garbage.
    return true;
  }

  // Digit-dominan dengan huruf ≤ 2 ("bo20202") — angka dengan 1-2 huruf
  // terselip (bukan "Rp1.500" / "1.000" / "tahun2020" yang sah).
  if (w.length >= 5 && /[a-zA-Z]/.test(w)) {
    const digits = (w.match(/\d/g) || []).length;
    const letters = (w.match(/[a-zA-Z]/g) || []).length;
    if (digits / w.length > 0.5 && letters <= 2 && !/^Rp/i.test(w)) return true;
  }

  // Token Latin terisolasi 1 karakter (selain "a"/"i") — ciri khas teks yang
  // terbaca MIRING (OCR memecah karakter menjadi simbol tunggal terpisah).
  // "I" (roman) & "A" dikecualikan karena kata sah ("BAB I", "Lampiran IA").
  if (hasAlpha && !hasCjk && /^[a-zA-Z]$/.test(w) && !/^[aiAI]$/.test(w)) return true;

  return false;
}

function computePageScore(blocks) {
  if (!blocks || blocks.length === 0) {
    return { confidence: 0, wordCount: 0, garbageRatio: 1, avgWordLength: 0 };
  }

  let totalConf = 0;
  let wordCount = 0;
  let garbageWords = 0;
  let cjkWords = 0;
  let totalWordLength = 0;
  let confCount = 0;

  for (const block of blocks) {
    const text = block.text || '';
    const words = text.split(/\s+/).filter((w) => w.length > 0);

    for (const word of words) {
      wordCount++;
      totalWordLength += word.length;

      if (isGarbageWord(word)) {
        garbageWords++;
      }

      if (CJK_RE.test(word) && !/[a-zA-Z\u00C0-\u024F\u0400-\u04FF]/.test(word)) {
        cjkWords++;
      }

      if (block.confidence !== undefined && block.confidence !== null) {
        totalConf += block.confidence;
        confCount++;
      }
    }
  }

  const confidence = confCount > 0 ? totalConf / confCount : 0;
  const garbageRatio = wordCount > 0 ? garbageWords / wordCount : 1;
  const avgWordLength = wordCount > 0 ? totalWordLength / wordCount : 0;

  return { confidence, wordCount, garbageRatio, avgWordLength, cjkWords };
}

function computeTextQuality(text) {
  if (!text || text.trim().length === 0) {
    return { score: 0, garbageRatio: 1, avgLineLength: 0, lineCount: 0 };
  }

  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const lineCount = lines.length;
  let garbageLines = 0;
  let totalLineLength = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    totalLineLength += trimmed.length;
    const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) continue;

    const shortWords = words.filter((w) => w.length <= 2).length;
    const digitWords = words.filter((w) => /^\d{1,2}$/.test(w)).length;
    const allDigitRatio = digitWords / words.length;
    const shortRatio = shortWords / words.length;

    const hasAlpha = /[a-zA-Z\u00C0-\u024F]/g.test(trimmed);
    if (allDigitRatio > 0.6 && shortRatio > 0.6 && !hasAlpha && trimmed.length > 3) {
      garbageLines++;
    }
  }

  const avgLineLength = lineCount > 0 ? totalLineLength / lineCount : 0;
  const garbageRatio = lineCount > 0 ? garbageLines / lineCount : 1;
  const score = Math.max(0, Math.min(1, 1 - garbageRatio * 0.8));

  return { score, garbageRatio, avgLineLength, lineCount };
}

function computeTableQuality(blocks) {
  if (!blocks || blocks.length < 3) return { isTable: false, confidence: 0 };

  let totalCells = 0;
  let numCells = 0;

  for (const block of blocks) {
    const text = block.text || '';
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) continue;
    totalCells++;

    const allNumeric = words.every((w) => /^[\d.,%Rp]+$/.test(w));
    if (allNumeric) numCells++;
  }

  const numRatio = totalCells > 0 ? numCells / totalCells : 0;
  const isTable = numRatio > 0.3 || blocks.some((b) => b.type === 'table');

  const avgConf = blocks.reduce((s, b) => s + (b.confidence || 0), 0) / blocks.length;
  return { isTable, confidence: avgConf, numericRatio: numRatio };
}

function computeQualityScore(blocks) {
  const pageScore = computePageScore(blocks);
  const confidence = pageScore.confidence || 0;
  const garbageRatio = pageScore.garbageRatio || 1;
  const wordCount = pageScore.wordCount || 0;
  const wordFactor = Math.min(wordCount / 20, 1);
  const score = confidence * 0.5 + (1 - garbageRatio) * 0.35 + wordFactor * 0.15;
  return { ...pageScore, score: Number(score.toFixed(4)) };
}

function shouldAcceptPage(pageScore, thresholds) {
  const t = thresholds || {
    minConfidence: config.ocr?.minimumConfidence || 0.3,
    maxGarbageRatio: config.ocr?.maxGarbageRatio || 0.4,
    minWordCount: config.ocr?.minWordCount || 5,
    minQualityScore: 0.3,
  };
  if (!pageScore) return false;
  if ((pageScore.wordCount || 0) < t.minWordCount) return false;
  if ((pageScore.confidence || 0) < t.minConfidence) return false;
  if ((pageScore.garbageRatio || 1) > t.maxGarbageRatio) return false;
  if ((pageScore.score || 0) < t.minQualityScore) return false;
  return true;
}

function shouldRetry(pageScore, retryCount, thresholds) {
  const t = thresholds || {
    minConfidence: config.ocr?.minimumConfidence || 0.3,
    maxGarbageRatio: 0.4,
    minWordCount: 5,
    maxRetries: config.ocr?.maxConfidenceRetries || 2,
  };

  if (retryCount >= t.maxRetries) return false;

  if (pageScore.wordCount < t.minWordCount) return true;
  if (pageScore.confidence < t.minConfidence && pageScore.wordCount > 0) return true;
  if (pageScore.garbageRatio > t.maxGarbageRatio && pageScore.wordCount >= t.minWordCount) return true;

  return false;
}

function selectRetryStrategy(retryCount) {
  const strategies = [
    { dpiBoost: 1.5, preprocess: 'enhanced', engine: 'auto' },
    { dpiBoost: 2.0, preprocess: 'light', engine: 'auto' },
    { dpiBoost: 2.5, preprocess: 'aggressive', engine: 'auto' },
  ];
  return strategies[Math.min(retryCount, strategies.length - 1)];
}

module.exports = {
  isGarbageWord,
  computePageScore,
  computeQualityScore,
  computeTextQuality,
  computeTableQuality,
  shouldAcceptPage,
  shouldRetry,
  selectRetryStrategy,
};
