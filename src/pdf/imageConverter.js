const path = require('path');
const url = require('url');
const config = require('../config');
const logger = require('../services/logger');

let _pdfjs = null;
let _Canvas = null;

async function _getPdfjs() {
  if (!_pdfjs) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const workerPath = path.join(
      path.dirname(require.resolve('pdfjs-dist/package.json')),
      'legacy',
      'build',
      'pdf.worker.mjs',
    );
    pdfjs.GlobalWorkerOptions.workerSrc = url.pathToFileURL(workerPath).href;
    _pdfjs = pdfjs;
  }
  return _pdfjs;
}

async function _getCanvas() {
  if (!_Canvas) {
    const mod = await import('@napi-rs/canvas');
    _Canvas = mod;
  }
  return _Canvas;
}

async function openDocument(buffer) {
  const pdfjs = await _getPdfjs();
  const data = new Uint8Array(buffer);
  return await pdfjs.getDocument({ data }).promise;
}

async function renderPage(doc, pageNum, scale) {
  const { createCanvas } = await _getCanvas();
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  const renderContext = { canvasContext: ctx, viewport };
  await page.render(renderContext).promise;
  page.cleanup();
  return canvas;
}

async function convertPdfToImages(buffer, options = {}) {
  const pdfjs = await _getPdfjs();
  const { createCanvas } = await _getCanvas();
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data }).promise;
  const pageCount = doc.numPages;
  const images = [];
  const scale = options.scale || config.pdfRenderScale;
  const adaptive = options.adaptive || false;
  const tablePages = options.tablePages || new Set();
  const tableScale = options.tableScale || scale * 1.5;

  logger.info(`  Merender ${pageCount} halaman ke gambar (scale: ${adaptive ? 'adaptif' : scale + 'x'})...`);

  for (let i = 1; i <= pageCount; i++) {
    try {
      let pageScale = scale;
      if (adaptive && tablePages.has(i)) pageScale = scale * 1.5;
      if (!adaptive && tablePages.has(i)) pageScale = tableScale;
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: pageScale });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, viewport.width, viewport.height);
      const renderContext = { canvasContext: ctx, viewport };
      await page.render(renderContext).promise;
      page.cleanup();
      images.push(canvas);
      if (tablePages.has(i) && pageScale !== scale) {
        logger.info(`  Halaman ${i}/${pageCount} di-render di scale ${pageScale.toFixed(1)}x (tabel)`);
      } else {
        logger.info(`  Halaman ${i}/${pageCount} selesai di-render`);
      }
    } catch (error) {
      logger.warn(`  Halaman ${i}/${pageCount} gagal di-render: ${error.message}. Dilewati.`);
      const { createCanvas: cc } = await _getCanvas();
      const blank = cc(1, 1);
      images.push(blank);
    }
  }

  await doc.cleanup();
  return { images, pageCount };
}

module.exports = { convertPdfToImages, renderPage, openDocument, _getCanvas };
