const config = require('../config');
const logger = require('../services/logger');
const axios = require('axios');

const SIDECAR_TIMEOUT = 15000;
const HOUGH_MAX_PIXELS = 1000000;
let _tesseractWorker = null;

async function deskewImage(canvas, options = {}) {
  const deskewCfg = config.deskew || {};
  const engine = deskewCfg.engine || 'auto';
  const minConfidence = deskewCfg.minConfidence || 0.3;
  const skipOsd = options.skipOsd === true;

  if (engine === 'projection') {
    return await projectionFallback(canvas);
  }

  // 1) Orientasi 0/90/180/270° — OSD duluan. Hough-lite bisa "menahan" halaman yang
  //    sebenarnya miring 90° dengan sudut kecil palsu (baris teks vertikal), sehingga
  //    OSD tidak pernah dieksekusi dan halaman tetap terrotasi.
  if (!skipOsd && (engine === 'tesseract' || engine === 'auto')) {
    const result = await tryTesseractOsd(canvas);
    if (result) {
      if (result.angle !== 0 && result.confidence >= minConfidence) {
        logger.info(`  Tesseract OSD: orientasi ${result.angle}° (confidence: ${result.confidence})`);
        return result.canvas;
      }
    }
    if (engine === 'tesseract') {
      return canvas;
    }
  }

  // 2) Fine deskew — Hough-lite pure-JS (±maxAngle)
  if (engine === 'hough' || engine === 'auto') {
    const lite = await tryHoughLite(canvas);
    if (lite && lite.confidence >= minConfidence) {
      logger.info(`  Hough-lite deskew: ${lite.angle.toFixed(2)}° (confidence: ${lite.confidence.toFixed(2)})`);
      return await rotateCanvas(canvas, -lite.angle);
    }

    // 3) Hough sidecar OpenCV (±30°)
    const result = await tryHoughSidecar(canvas);
    if (result) {
      if (result.confidence >= minConfidence) {
        logger.info(`  Hough deskew: ${result.angle}° (confidence: ${result.confidence})`);
        return result.canvas;
      }
    }
    if (engine === 'hough') {
      return canvas;
    }
  }

  // 4) Fallback projection (±5°)
  return await projectionFallback(canvas);
}

async function _toGrayDownsampled(canvas, maxPixels) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const total = width * height;
  let sw = width;
  let sh = height;

  if (total > maxPixels) {
    const scale = Math.sqrt(maxPixels / total);
    sw = Math.max(8, Math.floor(width * scale));
    sh = Math.max(8, Math.floor(height * scale));
  }

  if (sw === width && sh === height) {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
    }
    return { gray, w: sw, h: sh };
  }

  const { createCanvas } = await import('@napi-rs/canvas');
  const small = createCanvas(sw, sh);
  const sctx = small.getContext('2d');
  sctx.drawImage(canvas, 0, 0, sw, sh);
  const imageData = sctx.getImageData(0, 0, sw, sh);
  const data = imageData.data;
  const gray = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) {
    gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
  }
  return { gray, w: sw, h: sh };
}

function _otsuThreshold(gray, w, h) {
  const total = w * h;
  const hist = new Uint32Array(256);
  for (let i = 0; i < total; i++) hist[gray[i]]++;

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let maxVariance = 0;
  let threshold = 128;

  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const meanB = sumB / wB;
    const meanF = (sum - sumB) / wF;
    const variance = wB * wF * (meanB - meanF) * (meanB - meanF);
    if (variance >= maxVariance) {
      maxVariance = variance;
      threshold = i;
    }
  }
  return threshold;
}

function detectSkewHoughLite(gray, w, h, maxAngle) {
  const limit = Math.min(maxAngle || 15, 45);
  const threshold = _otsuThreshold(gray, w, h);
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const R = Math.ceil(Math.sqrt(cx * cx + cy * cy)) + 1;
  const step = 0.5;
  const numTheta = Math.floor((limit * 2) / step) + 1;
  const rhoBins = 2 * R + 1;
  const acc = new Float32Array(numTheta * rhoBins);

  const edgeStep = 2;
  for (let y = edgeStep; y < h - edgeStep; y += edgeStep) {
    const row = y * w;
    for (let x = edgeStep; x < w - edgeStep; x += edgeStep) {
      const v = gray[row + x];
      if (v >= threshold) continue;
      const gx = Math.abs(gray[row + x + 1] - gray[row + x - 1]);
      const gy = Math.abs(gray[row + w + x] - gray[row - w + x]);
      if (gx + gy < 60) continue;

      const dx = x - cx;
      const dy = y - cy;
      for (let t = 0; t < numTheta; t++) {
        const rad = ((90 - limit + t * step) * Math.PI) / 180;
        const rho = Math.round(dx * Math.cos(rad) + dy * Math.sin(rad)) + R;
        if (rho >= 0 && rho < rhoBins) acc[t * rhoBins + rho] += 1;
      }
    }
  }

  let maxVotes = 0;
  for (let i = 0; i < acc.length; i++) {
    if (acc[i] > maxVotes) maxVotes = acc[i];
  }

  if (maxVotes < 8) return null;

  const minVote = Math.max(4, maxVotes * 0.6);
  const angleVotes = new Map();
  for (let t = 0; t < numTheta; t++) {
    let peak = 0;
    const base = t * rhoBins;
    for (let r = 0; r < rhoBins; r++) {
      if (acc[base + r] > peak) peak = acc[base + r];
    }
    if (peak >= minVote) angleVotes.set(-limit + t * step, peak);
  }

  if (angleVotes.size === 0) return null;

  const entries = Array.from(angleVotes.entries());
  const totalTop = entries.reduce((s, [, v]) => s + v, 0);
  const weightedAngle = entries.reduce((s, [a, v]) => s + a * v, 0) / totalTop;
  const confidence = Math.min(1, totalTop / Math.max(maxVotes * 3, 1));

  if (Math.abs(weightedAngle) < 0.3) return null;

  return { angle: Math.round(weightedAngle * 100) / 100, confidence: Math.round(confidence * 100) / 100 };
}

async function tryHoughLite(canvas) {
  try {
    const { gray, w, h } = await _toGrayDownsampled(canvas, HOUGH_MAX_PIXELS);
    const maxAngle = config.deskew?.maxAngle || 15;
    const result = detectSkewHoughLite(gray, w, h, maxAngle);
    return result || null;
  } catch (err) {
    logger.warn(`  Hough-lite gagal: ${err.message}`);
    return null;
  }
}

async function tryHoughSidecar(canvas) {
  const serviceUrl = config.deskew?.serviceUrl || process.env.DESKEW_SERVICE_URL;
  if (!serviceUrl) return null;

  try {
    const buf = canvas.toBuffer('image/png');
    const b64 = buf.toString('base64');
    const maxAngle = config.deskew?.maxAngle || 15;
    const resp = await axios.post(
      `${serviceUrl}/deskew`,
      {
        image: b64,
        max_angle: maxAngle,
      },
      { timeout: SIDECAR_TIMEOUT },
    );
    if (!resp.data || !resp.data.rotated) return null;
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const imgBuf = Buffer.from(resp.data.rotated, 'base64');
    const image = await loadImage(imgBuf);
    const rotated = createCanvas(image.width, image.height);
    const ctx = rotated.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return { canvas: rotated, angle: resp.data.angle, confidence: resp.data.confidence };
  } catch (err) {
    logger.warn(`  Hough sidecar tidak tersedia: ${err.message}`);
    return null;
  }
}

async function getTesseractWorker() {
  try {
    if (!_tesseractWorker) {
      const { createWorker } = await import('tesseract.js');
      _tesseractWorker = await createWorker('osd');
    }
    return _tesseractWorker;
  } catch (err) {
    logger.warn(`  Gagal membuat Tesseract worker: ${err.message}`);
    _tesseractWorker = null;
    return null;
  }
}

async function _toOsdCanvas(canvas) {
  const { width, height } = canvas;
  if (width * height <= HOUGH_MAX_PIXELS) return canvas;
  const scale = Math.sqrt(HOUGH_MAX_PIXELS / (width * height));
  const sw = Math.max(8, Math.floor(width * scale));
  const sh = Math.max(8, Math.floor(height * scale));
  const { createCanvas } = await import('@napi-rs/canvas');
  const small = createCanvas(sw, sh);
  const sctx = small.getContext('2d');
  sctx.fillStyle = '#FFFFFF';
  sctx.fillRect(0, 0, sw, sh);
  sctx.drawImage(canvas, 0, 0, sw, sh);
  return small;
}

async function tryTesseractOsd(canvas) {
  if (config.osd && config.osd.enabled === false) return null;
  const worker = await getTesseractWorker();
  if (!worker) return null;

  const timeoutMs = (config.osd && config.osd.timeout) || 5000;
  try {
    const small = await _toOsdCanvas(canvas);
    const buf = small.toBuffer('image/png');
    const result = await Promise.race([
      worker.recognize(buf).then((r) => ({ data: r.data, timeout: false })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), timeoutMs)),
    ]);
    if (result.timeout) {
      logger.warn(`  Tesseract OSD timeout (${timeoutMs}ms), dilewati`);
      return null;
    }
    const { data } = result;
    if (!data || data.orientation_degrees === undefined) return null;
    const angle = data.orientation_degrees;
    const confidence = data.orientation_conf || 0;
    if (angle === 0 || confidence < 0.3) {
      return { canvas, angle, confidence };
    }
    const rotated = await rotateCanvas(canvas, angle);
    return { canvas: rotated, angle, confidence };
  } catch (err) {
    logger.warn(`  Tesseract OSD gagal: ${err.message}, reset worker...`);
    try {
      await worker.terminate();
    } catch (e) {
      /* skip */
    }
    _tesseractWorker = null;
    return null;
  }
}

async function rotateCanvas(canvas, angle) {
  if (!angle || isNaN(angle)) return canvas;
  const { createCanvas } = await import('@napi-rs/canvas');
  const rad = (angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const newW = Math.floor(canvas.width * cos + canvas.height * sin);
  const newH = Math.floor(canvas.width * sin + canvas.height * cos);
  const rotated = createCanvas(newW, newH);
  const ctx = rotated.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, newW, newH);
  ctx.translate(newW / 2, newH / 2);
  ctx.rotate(rad);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return rotated;
}

async function correctPerspective(canvas) {
  const deskewCfg = config.deskew || {};
  if (!deskewCfg.perspectiveCorrection) return canvas;
  const result = await tryPerspectiveCorrection(canvas);
  if (result) {
    logger.info('  Koreksi perspektif berhasil');
    return result;
  }
  return canvas;
}

async function tryPerspectiveCorrection(canvas) {
  const serviceUrl = config.deskew?.serviceUrl || process.env.DESKEW_SERVICE_URL;
  if (!serviceUrl) return null;

  try {
    const buf = canvas.toBuffer('image/png');
    const b64 = buf.toString('base64');
    const resp = await axios.post(
      `${serviceUrl}/correct-perspective`,
      {
        image: b64,
      },
      { timeout: SIDECAR_TIMEOUT },
    );
    if (!resp.data || !resp.data.success) return null;
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const imgBuf = Buffer.from(resp.data.image, 'base64');
    const image = await loadImage(imgBuf);
    const corrected = createCanvas(image.width, image.height);
    const ctx = corrected.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return corrected;
  } catch (err) {
    logger.warn(`  Perspective correction tidak tersedia: ${err.message}`);
    return null;
  }
}

function detectSkewAngle(gray, w, h) {
  const step = 4;
  let bestAngle = 0;
  let bestVariance = 0;

  for (let angle = -5; angle <= 5; angle += 0.5) {
    const rad = (angle * Math.PI) / 180;
    const projections = new Array(h).fill(0);

    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const origX = Math.round(x * Math.cos(rad) - y * Math.sin(rad));
        const origY = Math.round(x * Math.sin(rad) + y * Math.cos(rad));
        if (origX >= 0 && origX < w && origY >= 0 && origY < h) {
          if (gray[origY * w + origX] < 128) {
            projections[Math.round(y)]++;
          }
        }
      }
    }

    let sum = 0;
    let count = 0;
    for (const p of projections) {
      sum += p;
      count++;
    }
    const mean = sum / count;
    let variance = 0;
    for (const p of projections) {
      variance += (p - mean) ** 2;
    }
    variance /= count;

    if (variance > bestVariance) {
      bestVariance = variance;
      bestAngle = angle;
    }
  }

  return bestAngle;
}

async function projectionFallback(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  if (width * height > 2000000) {
    const scale = Math.sqrt(2000000 / (width * height));
    const sw = Math.floor(width * scale);
    const sh = Math.floor(height * scale);
    const { createCanvas } = await import('@napi-rs/canvas');
    const small = createCanvas(sw, sh);
    const sctx = small.getContext('2d');
    sctx.drawImage(canvas, 0, 0, sw, sh);
    const imageData = sctx.getImageData(0, 0, sw, sh);
    const data = imageData.data;
    const gray = new Uint8Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) gray[i] = data[i * 4];
    const angle = detectSkewAngle(gray, sw, sh);
    if (Math.abs(angle) < 0.5) return canvas;
    logger.info(`  Projection deskew: ${angle.toFixed(1)}°`);
    return await rotateCanvas(canvas, angle);
  } else {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) gray[i] = data[i * 4];
    const angle = detectSkewAngle(gray, width, height);
    if (Math.abs(angle) < 0.5) return canvas;
    logger.info(`  Projection deskew: ${angle.toFixed(1)}°`);
    return await rotateCanvas(canvas, angle);
  }
}

module.exports = { deskewImage, correctPerspective, tryTesseractOsd, tryHoughLite, detectSkewHoughLite };
