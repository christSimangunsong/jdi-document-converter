const logger = require('../services/logger');

async function correctOrientation(canvas) {
  const { width, height } = canvas;
  if (width < 10 || height < 10) return canvas;

  if (height < width) {
    logger.info('  Halaman landscape (height < width), rotate -90°');
    return await rotateCanvas(canvas, -90);
  }

  return canvas;
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

module.exports = { correctOrientation };
