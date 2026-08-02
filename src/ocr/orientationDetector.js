const logger = require('../services/logger');
const config = require('../config');
const { tryTesseractOsd } = require('./deskewRouter');
const { commonWordRatio } = require('../pdf/textLayerValidator');

let _osdEngine = null;

async function correctOrientation(canvas) {
  const { width, height } = canvas;
  if (width < 10 || height < 10) return canvas;

  if (height < width) {
    logger.info('  Halaman landscape (height < width), rotate -90°');
    return await rotateCanvas(canvas, -90);
  }

  // Halaman portrait: konten lampiran tabel (landscape) bisa discan miring
  // 90/180/270° DI DALAM halaman portrait (ukuran halaman tetap portrait).
  if (config.osd && config.osd.enabled === false) return canvas;

  // 1) Tesseract OSD (tesseract.js) - akurat & murah utk 0/90/180/270.
  try {
    const result = await tryTesseractOsd(canvas);
    if (result && result.angle) {
      const raw = result.confidence || 0;
      const confPct = raw <= 1 ? raw * 100 : raw; // normalisasi 0-1 -> 0-100
      if (confPct >= (config.osd.minConfidence || 8)) {
        logger.info(`  Konten miring ${result.angle}° di halaman portrait, dikoreksi (OSD)`);
        return result.canvas;
      }
      logger.warn(
        `  OSD deteksi rotasi ${result.angle}° tapi confidence ${confPct.toFixed(1)} < ${config.osd.minConfidence}, dilewati`,
      );
      return canvas;
    }
    if (result) return canvas; // angle 0 -> sudah tegak
  } catch (err) {
    logger.warn(`  OSD orientasi gagal: ${err.message}`);
  }
  // result null -> worker OSD tidak tersedia, lanjut fallback kontur.

  // 2) Fallback: analisis kontur (agregat komponen vertikal vs horizontal)
  // + OCR multi-arah (paddle, downscale) untuk menentukan arah.
  try {
    const res = await detectTextOrientation(canvas);
    if (!res) return canvas;
    if (res.rotated) {
      logger.info(`  Kontur: teks vertikal (θ=${res.theta.toFixed(0)}°) di halaman portrait`);
      const angle = await pickRotationByOcr(canvas);
      if (!angle) return canvas;
      logger.info(`  Konten miring di halaman portrait, dikoreksi ${angle}° (kontur+OCR)`);
      return await rotateCanvas(canvas, angle);
    }
    if (res.ambiguous) {
      logger.info(`  Kontur: orientasi ambigu (ratio=${res.ratio.toFixed(2)}), cek OCR 4-rotasi`);
      const angle = await pickRotationByOcr(canvas, { include180: true });
      if (!angle) return canvas;
      logger.info(`  Konten dikoreksi ${angle}° (OCR 4-rotasi)`);
      return await rotateCanvas(canvas, angle);
    }
    return canvas; // tegak
  } catch (err) {
    logger.warn(`  Deteksi orientasi kontur gagal: ${err.message}, dilewati`);
    return canvas;
  }
}

// ---------------------------------------------------------------------------
// Fallback kontur + OCR arah (dipakai saat tesseract.js OSD tidak tersedia)
// ---------------------------------------------------------------------------

async function _getOsdEngine() {
  if (_osdEngine) return _osdEngine;
  if (_osdEngine === false) return null;
  try {
    // Reuse engine paddle pipeline (cache router) supaya tidak memuat 2x
    // model OCR dalam satu proses.
    const { ocrRouter } = require('./router');
    const active = await ocrRouter.getActiveEngine();
    if (active && active.getMetadata && active.getMetadata().name === 'paddle') {
      _osdEngine = active;
      return active;
    }
    const { PaddleEngine } = require('./engines/paddleEngine');
    _osdEngine = new PaddleEngine();
    await _osdEngine.init();
  } catch (err) {
    logger.warn(`  Engine orientasi (paddle) gagal init: ${err.message}`);
    _osdEngine = false;
  }
  return _osdEngine || null;
}

async function downscaleCanvas(canvas, maxDim) {
  const { width, height } = canvas;
  const largest = Math.max(width, height);
  if (largest <= maxDim) return canvas;
  const scale = maxDim / largest;
  const sw = Math.max(8, Math.round(width * scale));
  const sh = Math.max(8, Math.round(height * scale));
  const { createCanvas } = await import('@napi-rs/canvas');
  const small = createCanvas(sw, sh);
  const sctx = small.getContext('2d');
  sctx.fillStyle = '#FFFFFF';
  sctx.fillRect(0, 0, sw, sh);
  sctx.drawImage(canvas, 0, 0, sw, sh);
  return small;
}

function _otsuThreshold(data, total) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) hist[data[i]]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let maxVar = 0;
  let thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const meanB = sumB / wB;
    const meanF = (sum - sumB) / wF;
    const variance = wB * wF * (meanB - meanF) * (meanB - meanF);
    if (variance >= maxVar) {
      maxVar = variance;
      thr = i;
    }
  }
  return thr;
}

async function detectTextOrientation(canvas) {
  const small = await downscaleCanvas(canvas, 1600);
  const { width: w, height: h } = small;
  if (w < 16 || h < 16) return null;
  const ctx = small.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const total = w * h;
  const thr = _otsuThreshold(d, total);
  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i++) mask[i] = d[i * 4] < thr ? 1 : 0;

  // Connected components (8-connectivity) via runs + union-find.
  const parent = [];
  const runs = [];
  let nextId = 0;
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };

  let lastRow = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    let x = 0;
    const off = y * w;
    while (x < w) {
      while (x < w && !mask[off + x]) x++;
      if (x >= w) break;
      const x0 = x;
      while (x < w && mask[off + x]) x++;
      const x1 = x - 1;
      const id = nextId++;
      parent.push(id);
      runs.push({ id, x0, x1, y });
      for (const lr of lastRow) {
        if (lr.x1 >= x0 && lr.x0 <= x1) {
          const ra = find(id);
          const rb = find(lr.id);
          if (ra !== rb) parent[ra] = rb;
        }
      }
      row.push({ id, x0, x1 });
    }
    lastRow = row;
  }
  if (!runs.length) return null;

  // Akumulasi momen per komponen (root).
  const stats = new Map();
  for (const r of runs) {
    const root = find(r.id);
    let s = stats.get(root);
    if (!s) {
      s = { area: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
      stats.set(root, s);
    }
    const len = r.x1 - r.x0 + 1;
    const sumX = ((r.x0 + r.x1) * len) / 2;
    const sumX2 =
      (r.x1 * (r.x1 + 1) * (2 * r.x1 + 1) - (r.x0 - 1) * r.x0 * (2 * r.x0 - 1)) / 6;
    s.area += len;
    s.sx += sumX;
    s.sy += len * r.y;
    s.sxx += sumX2;
    s.syy += len * r.y * r.y;
    s.sxy += r.y * sumX;
  }

  // Agregat area komponen: vertikal (|θ|≥80) vs horizontal (|θ|≤10).
  // Pakai SEMUA komponen, bukan hanya yang terbesar — halaman tabel grid
  // miring punya komponen garis horizontal palsu ber-area besar (θ≈0)
  // yang menutupi teks vertikal jika hanya komponen terbesar yang dilihat.
  const comps = [];
  let vertArea = 0;
  let horizArea = 0;
  for (const s of stats.values()) {
    if (s.area < total * 0.0005) continue;
    const mx = s.sx / s.area;
    const my = s.sy / s.area;
    const ixx = s.sxx - s.area * mx * mx;
    const iyy = s.syy - s.area * my * my;
    const ixy = s.sxy - s.area * mx * my;
    const theta = (0.5 * Math.atan2(2 * ixy, ixx - iyy) * 180) / Math.PI;
    const a = Math.abs(theta);
    if (a >= 80) vertArea += s.area;
    else if (a <= 10) horizArea += s.area;
    comps.push({ area: s.area, theta });
  }
  if (!comps.length) return null;

  comps.sort((a, b) => b.area - a.area);
  const best = comps[0];
  const sum = vertArea + horizArea;
  const ratio = sum > 0 ? vertArea / sum : 0;
  return {
    theta: best.theta,
    ratio,
    rotated: ratio >= 0.55,
    ambiguous: ratio > 0.45 && ratio < 0.55,
    top: comps.slice(0, 5),
  };
}

// Skor keterbacaan OCR untuk memilih arah rotasi. Kombinasi rasio kata
// umum + huruf + digit (tie-breaker tabel angka-murni), dengan penalti
// karakter CJK (tanda teks miring yang terbaca sebagai simbol).
function _readabilityScore(text) {
  const wr = commonWordRatio(text) || 0;
  const letters = (text.match(/[a-zA-Z]+/g) || []).length;
  const digits = (text.match(/\d/g) || []).length;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return (
    wr * 10 + Math.min(letters / 80, 1) * 0.5 + Math.min(digits / 150, 1) * 0.3 - Math.min(cjk / 300, 1) * 1.5
  );
}

// OCR multi-arah (downscale) untuk menentukan rotasi: coba 0/±90 (+180
// opsional), pilih skor keterbacaan terbaik. Hanya rotate jika kandidat
// jelas lebih baik dari posisi semula (margin ≥ 0.05) — aman dari
// false-positive.
async function pickRotationByOcr(canvas, options = {}) {
  const eng = await _getOsdEngine();
  if (!eng) return 0;
  const probes = options.include180 ? [0, 90, 180, 270] : [0, 90, -90];
  const small = await downscaleCanvas(canvas, 700);
  const results = [];
  for (const angle of probes) {
    try {
      const img = angle === 0 ? small : await rotateCanvas(small, angle);
      const text = await eng.recognizePage(img);
      results.push({ angle, score: _readabilityScore(text) });
    } catch (err) {
      logger.warn(`  OCR probe rotasi ${angle}° gagal: ${err.message}`);
      _osdEngine = null; // engine stale/destroyed (resetEngine) -> coba buat ulang
      return 0;
    }
  }
  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  const upright = results.find((r) => r.angle === 0) || best;
  if (best.score <= 0.05) return 0; // semua arah garbage -> biarkan apa adanya
  if (best.angle === 0) return 0; // posisi semula sudah paling terbaca
  if (best.score - upright.score < 0.05) return 0; // margin terlalu kecil
  return best.angle;
}

async function rotateCanvas(canvas, angle) {
  if (!angle || isNaN(angle) || angle === 0) return canvas;
  const { createCanvas } = await import('@napi-rs/canvas');
  const rad = (angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const newW = Math.floor(canvas.height * sin + canvas.width * cos);
  const newH = Math.floor(canvas.width * sin + canvas.height * cos);
  const rotated = createCanvas(newW || canvas.height, newH || canvas.width);
  const ctx = rotated.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, rotated.width, rotated.height);
  ctx.translate(rotated.width / 2, rotated.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return rotated;
}

module.exports = { correctOrientation, rotateCanvas };
