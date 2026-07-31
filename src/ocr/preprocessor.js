const logger = require('../services/logger');
const { correctOrientation } = require('./orientationDetector');
const { deskewImage, correctPerspective } = require('./deskewRouter');

async function preprocessImage(canvas, options = {}) {
  if (!canvas) return canvas;

  const steps = options.steps || ['grayscale', 'threshold'];
  const upscaleFactor = options.upscaleFactor || 0;

  logger.info(`  Preprocessing gambar: ${steps.join(', ')}`);

  let img = canvas;

  for (const step of steps) {
    switch (step) {
      case 'upscale':
        if (upscaleFactor > 1) img = await upscaleCanvas(img, upscaleFactor);
        break;
      case 'grayscale':
        img = await toGrayscale(img);
        break;
      case 'threshold':
        img = await otsuThreshold(img);
        break;
      case 'denoise':
        img = await medianDenoise(img);
        break;
      case 'deskew':
        img = await deskew(img);
        break;
      case 'deskew-adaptive':
        try {
          img = await deskewImage(img);
        } catch (err) {
          logger.warn(`  Deskew adaptif gagal: ${err.message}, dilewati`);
        }
        break;
      case 'perspective':
        try {
          img = await correctPerspective(img);
        } catch (err) {
          logger.warn(`  Perspective correction gagal: ${err.message}, dilewati`);
        }
        break;
      case 'rotate':
        try {
          img = await correctOrientation(img);
        } catch (err) {
          logger.warn(`  Rotasi gagal: ${err.message}, dilewati`);
        }
        break;
      default:
        break;
    }
  }

  return img;
}

async function upscaleCanvas(canvas, factor) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const newW = Math.round(canvas.width * factor);
  const newH = Math.round(canvas.height * factor);
  const scaled = createCanvas(newW, newH);
  const ctx = scaled.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, newW, newH);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, 0, 0, newW, newH);
  logger.info(`  Upscale gambar x${factor.toFixed(1)} (${canvas.width}x${canvas.height} -> ${newW}x${newH})`);
  return scaled;
}

async function toGrayscale(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function otsuThreshold(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const total = width * height;

  const hist = new Uint32Array(256);
  for (let i = 0; i < total; i++) hist[data[i * 4]]++;

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0,
    wB = 0,
    wF = 0;
  let maxVariance = 0,
    threshold = 128;

  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    wF = total - wB;
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

  for (let i = 0; i < total; i++) {
    const val = data[i * 4] > threshold ? 255 : 0;
    data[i * 4] = val;
    data[i * 4 + 1] = val;
    data[i * 4 + 2] = val;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function medianDenoise(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const radius = 1;
  const size = radius * 2 + 1;

  const out = new Uint8ClampedArray(data);

  for (let y = radius; y < height - radius; y++) {
    for (let x = radius; x < width - radius; x++) {
      const r = [],
        g = [],
        b = [];
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const idx = ((y + dy) * width + (x + dx)) * 4;
          r.push(data[idx]);
          g.push(data[idx + 1]);
          b.push(data[idx + 2]);
        }
      }
      r.sort((a, b) => a - b);
      g.sort((a, b) => a - b);
      b.sort((a, b) => a - b);
      const mid = Math.floor((size * size) / 2);
      const idx = (y * width + x) * 4;
      out[idx] = r[mid];
      out[idx + 1] = g[mid];
      out[idx + 2] = b[mid];
      out[idx + 3] = data[idx + 3];
    }
  }

  for (let i = 0; i < out.length; i++) {
    data[i] = out[i];
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function deskew(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const gray = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i++) {
    gray[i] = data[i * 4];
  }

  const angle = detectSkewAngle(gray, width, height);

  if (Math.abs(angle) < 0.5) return canvas;

  logger.info(`  Mendeteksi kemiringan ${angle.toFixed(1)}°, koreksi diterapkan`);

  const { createCanvas } = await import('@napi-rs/canvas');
  const rad = (angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const newW = Math.floor(width * cos + height * sin);
  const newH = Math.floor(width * sin + height * cos);

  const rotated = createCanvas(newW, newH);
  const rctx = rotated.getContext('2d');

  rctx.fillStyle = '#FFFFFF';
  rctx.fillRect(0, 0, newW, newH);

  rctx.translate(newW / 2, newH / 2);
  rctx.rotate(rad);
  rctx.drawImage(canvas, -width / 2, -height / 2);

  return rotated;
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

module.exports = { preprocessImage };
