function computeCer(hypothesis, reference) {
  if (!reference) return hypothesis ? 1 : 0;
  if (!hypothesis) return 1;

  const h = hypothesis.toLowerCase().trim();
  const r = reference.toLowerCase().trim();

  const dp = levenshteinMatrix(h, r);
  const dist = dp[h.length][r.length];
  return dist / Math.max(r.length, 1);
}

function computeWer(hypothesis, reference) {
  const hWords = (hypothesis || '').trim().split(/\s+/).filter(Boolean);
  const rWords = (reference || '').trim().split(/\s+/).filter(Boolean);

  if (rWords.length === 0) return hWords.length > 0 ? 1 : 0;

  const dp = levenshteinMatrix(hWords, rWords);
  const dist = dp[hWords.length][rWords.length];
  return dist / rWords.length;
}

function levenshteinMatrix(a, b) {
  const aLen = a.length;
  const bLen = b.length;
  const dp = Array.from({ length: aLen + 1 }, () => new Uint32Array(bLen + 1));

  for (let i = 0; i <= aLen; i++) dp[i][0] = i;
  for (let j = 0; j <= bLen; j++) dp[0][j] = j;

  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp;
}

function computeAverageConfidence(blocks) {
  if (!blocks || blocks.length === 0) return 0;
  const confs = blocks.map((b) => b.confidence || 0).filter((c) => c > 0);
  if (confs.length === 0) return 0;
  return confs.reduce((a, b) => a + b, 0) / confs.length;
}

function computeSpeed(numPages, durationMs) {
  if (durationMs <= 0) return 0;
  return (numPages / durationMs) * 1000;
}

function scoreLayoutQuality(hypothesis, reference) {
  if (!reference || !hypothesis) return 0;

  const refLines = reference.split('\n').filter((l) => l.trim());
  const hypLines = hypothesis.split('\n').filter((l) => l.trim());

  const refParaBreaks = countParagraphBreaks(refLines);
  const hypParaBreaks = countParagraphBreaks(hypLines);

  if (refParaBreaks === 0 && hypParaBreaks === 0) return 1;
  if (refParaBreaks === 0) return hypParaBreaks === 0 ? 1 : 0;

  const ratio = Math.min(hypParaBreaks / refParaBreaks, refParaBreaks / hypParaBreaks);
  return ratio;
}

function countParagraphBreaks(lines) {
  let breaks = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i - 1].endsWith('.') || lines[i - 1].endsWith(':') || lines[i - 1].endsWith('"')) {
      breaks++;
    }
  }
  return breaks;
}

function scoreTableQuality(hypothesis) {
  const tableMarkers = (hypothesis || '').match(/\+[-+]+\+/g);
  if (!tableMarkers) return 0;

  const tableLines = tableMarkers.length;
  const body = (hypothesis || '').split('\n').filter((l) => l.startsWith('|'));

  if (tableLines < 2 || body.length < 2) return 0.1;

  const colCounts = body.map((l) => (l.match(/\|/g) || []).length - 1);
  const consistent = colCounts.every((c) => c === colCounts[0]);

  const base = Math.min(1, tableLines / 10);
  return consistent ? Math.min(1, base + 0.3) : base;
}

function scoreStructureQuality(text) {
  if (!text) return 0;

  const hasBab = /\bBAB\s+(?:[IVXLCDM]+\b|\d+)/i.test(text);
  const hasPasal = /\bPasal\s+\d+/i.test(text);
  const hasAyat = /\(\d+[a-z]?\)/.test(text) || /\bAyat\s+/i.test(text);
  const hasBagian = /\bBagian\s+(?:Kesatu|Kedua|Ketiga)/i.test(text);

  let score = 0;
  if (hasBab) score += 0.3;
  if (hasPasal) score += 0.3;
  if (hasAyat) score += 0.2;
  if (hasBagian) score += 0.2;

  return score;
}

function computeAllMetrics(engineResult, groundTruth, durationMs, numPages) {
  const text = engineResult.text || '';
  const blocks = engineResult.blocks || [];
  const gt = groundTruth || '';

  return {
    cer: computeCer(text, gt),
    wer: computeWer(text, gt),
    avgConfidence: computeAverageConfidence(blocks),
    speed: computeSpeed(numPages, durationMs),
    layoutQuality: scoreLayoutQuality(text, gt),
    tableQuality: scoreTableQuality(text),
    structureQuality: scoreStructureQuality(text),
    durationMs,
    numPages,
  };
}

module.exports = {
  computeCer,
  computeWer,
  computeAverageConfidence,
  computeSpeed,
  scoreLayoutQuality,
  scoreTableQuality,
  scoreStructureQuality,
  computeAllMetrics,
};
