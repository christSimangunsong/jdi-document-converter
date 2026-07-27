const path = require('path');
const fs = require('fs-extra');
const url = require('url');
const config = require('../config');
const logger = require('../services/logger');

async function convertPdfToImages(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const { createCanvas } = await import('@napi-rs/canvas');

  const workerPath = path.join(
    path.dirname(require.resolve('pdfjs-dist/package.json')),
    'legacy', 'build', 'pdf.worker.mjs'
  );
  pdfjs.GlobalWorkerOptions.workerSrc = url.pathToFileURL(workerPath).href;

  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data }).promise;
  const pageCount = doc.numPages;
  const images = [];

  logger.info(`  Merender ${pageCount} halaman ke gambar...`);

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: config.pdfRenderScale });

    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    const renderContext = {
      canvasContext: ctx,
      viewport,
    };

    await page.render(renderContext).promise;
    page.cleanup();

    images.push(canvas);

    logger.info(`  Halaman ${i}/${pageCount} selesai di-render`);
  }

  await doc.cleanup();

  return { images, pageCount };
}

module.exports = { convertPdfToImages };
