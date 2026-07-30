const config = require('../config');
const logger = require('../services/logger');

const pageRenderCache = new Map();

function getCacheKey(pageNum, scale) {
  return `${pageNum}_${scale}`;
}

async function renderPage(pdfDoc, pageNum, scale) {
  const cacheKey = getCacheKey(pageNum, scale);
  if (pageRenderCache.has(cacheKey)) {
    return pageRenderCache.get(cacheKey);
  }

  const { Canvas } = await import('@napi-rs/canvas');

  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  const canvas = new Canvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');

  await page.render({ canvasContext: ctx, viewport }).promise;
  pageRenderCache.set(cacheKey, canvas);

  return canvas;
}

function getDefaultScale() {
  return config.pdfRenderScale || 2.0;
}

function selectScale(pageNum, retryCount, isTablePage) {
  const baseScale = getDefaultScale();
  if (isTablePage) {
    if (retryCount === 0) return baseScale * 1.5;
    if (retryCount === 1) return baseScale * 2.0;
    return baseScale * 2.5;
  }
  if (retryCount === 0) return baseScale;
  if (retryCount === 1) return baseScale * 1.5;
  return baseScale * 2.0;
}

async function renderPageAdaptive(pdfDoc, pageNum, retryCount, isTablePage) {
  const scale = selectScale(pageNum, retryCount, isTablePage);
  if (retryCount > 0) {
    logger.info(`  Render ulang halaman ${pageNum} di scale ${scale.toFixed(1)}x`);
  }
  return await renderPage(pdfDoc, pageNum, scale);
}

function clearCache() {
  pageRenderCache.clear();
}

module.exports = { renderPage, renderPageAdaptive, selectScale, getDefaultScale, clearCache };
