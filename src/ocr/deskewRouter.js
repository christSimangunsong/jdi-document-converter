const config = require('../config');
const logger = require('../services/logger');
const axios = require('axios');

const SIDECAR_TIMEOUT = 15000;
let _tesseractWorker = null;

async function deskewImage(canvas) {
  const deskewCfg = config.deskew || {};
  const engine = deskewCfg.engine || 'auto';
  const minConfidence = deskewCfg.minConfidence || 0.3;

  if (engine === 'projection') {
    return await projectionFallback(canvas);
  }

  if (engine === 'hough' || engine === 'auto') {
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

  if (engine === 'tesseract' || engine === 'auto') {
    const result = await tryTesseractOsd(canvas);
    if (result) {
      if (result.confidence >= minConfidence) {
        logger.info(`  Tesseract OSD: orientasi ${result.angle}° (confidence: ${result.confidence})`);
        return result.canvas;
      }
    }
    if (engine === 'tesseract') {
      return canvas;
    }
  }

  return await projectionFallback(canvas);
}

async function tryHoughSidecar(canvas) {
  const serviceUrl = config.deskew?.serviceUrl || process.env.DESKEW_SERVICE_URL;
  if (!serviceUrl) return null;

  try {
    const buf = canvas.toBuffer('image/png');
    const b64 = buf.toString('base64');
    const maxAngle = config.deskew?.maxAngle || 15;
    const resp = await axios.post(`${serviceUrl}/deskew`, {
      image: b64,
      max_angle: maxAngle,
    }, { timeout: SIDECAR_TIMEOUT });
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

async function tryTesseractOsd(canvas) {
  const worker = await getTesseractWorker();
  if (!worker) return null;

  try {
    const buf = canvas.toBuffer('image/png');
    const { data } = await worker.recognize(buf);
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
    try { await worker.terminate(); } catch (e) { /* skip */ }
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
    const resp = await axios.post(`${serviceUrl}/correct-perspective`, {
      image: b64,
    }, { timeout: SIDECAR_TIMEOUT });
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
    for (const p of projections) { sum += p; count++; }
    const mean = sum / count;
    let variance = 0;
    for (const p of projections) { variance += (p - mean) ** 2; }
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

module.exports = { deskewImage, correctPerspective, tryTesseractOsd };
