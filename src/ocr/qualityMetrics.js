const config = require('../config');

function computePageScore(blocks) {
  if (!blocks || blocks.length === 0) {
    return { confidence: 0, wordCount: 0, garbageRatio: 1, avgWordLength: 0 };
  }

  let totalConf = 0;
  let wordCount = 0;
  let garbageWords = 0;
  let totalWordLength = 0;
  let confCount = 0;

  for (const block of blocks) {
    const text = block.text || '';
    const words = text.split(/\s+/).filter(w => w.length > 0);

    for (const word of words) {
      wordCount++;
      totalWordLength += word.length;

      const digitRatio = (word.match(/\d/g) || []).length / word.length;
      const hasAlpha = /[a-zA-Z\u00C0-\u024F\u0400-\u04FF]/g.test(word);

      if (!hasAlpha && digitRatio > 0.5 && word.length <= 3) {
        garbageWords++;
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

  return { confidence, wordCount, garbageRatio, avgWordLength };
}

function computeTextQuality(text) {
  if (!text || text.trim().length === 0) {
    return { score: 0, garbageRatio: 1, avgLineLength: 0, lineCount: 0 };
  }

  const lines = text.split('\n').filter(l => l.trim().length > 0);
  const lineCount = lines.length;
  let garbageLines = 0;
  let totalLineLength = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    totalLineLength += trimmed.length;
    const words = trimmed.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) continue;

    const shortWords = words.filter(w => w.length <= 2).length;
    const digitWords = words.filter(w => /^\d{1,2}$/.test(w)).length;
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
    const words = text.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) continue;
    totalCells++;

    const allNumeric = words.every(w => /^[\d.,%Rp]+$/.test(w));
    if (allNumeric) numCells++;
  }

  const numRatio = totalCells > 0 ? numCells / totalCells : 0;
  const isTable = numRatio > 0.3 || blocks.some(b => b.type === 'table');

  const avgConf = blocks.reduce((s, b) => s + (b.confidence || 0), 0) / blocks.length;
  return { isTable, confidence: avgConf, numericRatio: numRatio };
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
    { dpiBoost: 1.0, preprocess: 'enhanced', engine: null },
    { dpiBoost: 2.0, preprocess: 'light', engine: null },
    { dpiBoost: 2.5, preprocess: 'aggressive', engine: 'auto' },
  ];
  return strategies[Math.min(retryCount, strategies.length - 1)];
}

module.exports = {
  computePageScore,
  computeTextQuality,
  computeTableQuality,
  shouldRetry,
  selectRetryStrategy,
};
