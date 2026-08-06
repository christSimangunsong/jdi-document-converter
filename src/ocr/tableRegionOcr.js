const logger = require('../services/logger');
const config = require('../config');
const { deskewImage } = require('./deskewRouter');
const { preprocessImage } = require('./preprocessor');
const { normalizeBbox, ocrTableCell, formatAsciiTable, fixTableCellSymbol } = require('./cellOcr');
const { computeQualityScore } = require('./qualityMetrics');

const REGION_PADDING = 12;
const REGION_UPSCALE = 2;
const LINE_DENSITY_THRESHOLD = 0.6;
const MIN_REGION_SIZE = 40;
const GRID_VERT_MARGIN = 0.05;
const GRID_MIN_INNER_VERT = 3;
const MIN_CELL_W = 10;

function _toGrayData(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
  }
  return { gray, w: width, h: height };
}

function _otsu(gray, w, h) {
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

function _detectHorizLines(gray, w, h, thr) {
  const lines = [];
  let y = 0;
  while (y < h) {
    let darkCount = 0;
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] < thr) darkCount++;
    }
    if (darkCount > w * LINE_DENSITY_THRESHOLD) {
      let runStart = y;
      let runEnd = y;
      while (runEnd + 1 < h) {
        let nextCount = 0;
        for (let x = 0; x < w; x++) {
          if (gray[(runEnd + 1) * w + x] < thr) nextCount++;
        }
        if (nextCount <= w * LINE_DENSITY_THRESHOLD) break;
        runEnd++;
      }
      lines.push(Math.floor((runStart + runEnd) / 2));
      y = runEnd + 1;
    } else {
      y++;
    }
  }
  return lines;
}

function _detectVertLines(gray, w, h, thr) {
  const lines = [];
  let x = 0;
  while (x < w) {
    let darkCount = 0;
    for (let y = 0; y < h; y++) {
      if (gray[y * w + x] < thr) darkCount++;
    }
    if (darkCount > h * LINE_DENSITY_THRESHOLD) {
      let runStart = x;
      let runEnd = x;
      while (runEnd + 1 < w) {
        let nextCount = 0;
        for (let y = 0; y < h; y++) {
          if (gray[y * w + runEnd + 1] < thr) nextCount++;
        }
        if (nextCount <= h * LINE_DENSITY_THRESHOLD) break;
        runEnd++;
      }
      lines.push(Math.floor((runStart + runEnd) / 2));
      x = runEnd + 1;
    } else {
      x++;
    }
  }
  return lines;
}

function _regionsFromGrid(horiz, vert, w) {
  const regions = [];

  for (let i = 0; i < horiz.length - 1; i++) {
    const y0 = horiz[i];
    const y1 = horiz[i + 1];
    if (y1 - y0 < MIN_REGION_SIZE) continue;

    const inBand = vert.filter((x) => x > 2 && x < w - 2);
    if (inBand.length < 2) continue;

    const x0 = Math.min(...inBand);
    const x1 = Math.max(...inBand);
    if (x1 - x0 < MIN_REGION_SIZE) continue;

    regions.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }

  if (regions.length === 0 && horiz.length >= 2) {
    const x0 = Math.floor(w * 0.05);
    const x1 = Math.floor(w * 0.95);
    let bandStart = horiz[0];
    let bandEnd = horiz[horiz.length - 1];
    if (bandEnd - bandStart >= MIN_REGION_SIZE && x1 - x0 >= MIN_REGION_SIZE) {
      regions.push({ x: x0, y: bandStart, w: x1 - x0, h: bandEnd - bandStart });
    }
  }

  return _mergeRegions(regions);
}

function _mergeRegions(regions) {
  const merged = [];
  for (const r of regions) {
    let absorbed = false;
    for (const m of merged) {
      const gapY = Math.max(r.y, m.y) - Math.min(r.y + r.h, m.y + m.h);
      const gapX = Math.max(r.x, m.x) - Math.min(r.x + r.w, m.x + m.w);
      if (gapY < 10 && gapX < 10) {
        m.x = Math.min(m.x, r.x);
        m.y = Math.min(m.y, r.y);
        m.w = Math.max(m.x + m.w, r.x + r.w) - m.x;
        m.h = Math.max(m.y + m.h, r.y + r.h) - m.y;
        absorbed = true;
        break;
      }
    }
    if (!absorbed) merged.push({ ...r });
  }
  return merged;
}

function detectTableRegions(canvas) {
  if (!canvas) return [];
  try {
    const { gray, w, h } = _toGrayData(canvas);
    if (w * h < 10000) return [];
    const thr = _otsu(gray, w, h);
    const horiz = _detectHorizLines(gray, w, h, thr);
    if (horiz.length < 2) return [];
    const vert = _detectVertLines(gray, w, h, thr);
    return _regionsFromGrid(horiz, vert, w);
  } catch (err) {
    logger.warn(`  Deteksi region tabel gagal: ${err.message}`);
    return [];
  }
}

/**
 * Gate ketat untuk grid WIRED (border penuh): hanya halaman/region dengan
 * minimal `GRID_MIN_INNER_VERT` garis vertikal di dalam band antar dua garis
 * horizontal berturutan (vertikal diukur terhadap TINGGI BAND, margin 5% tepi)
 * yang dianggap tabel. TANPA fallback horizontal-only (sumber false positive
 * pada paragraf padat) dan menolak border kotak halaman (tepi 5%).
 * Dipakai sebagai triase murah (~140 ms/halaman) penentu engine sidecar
 * table-aware: paddlex untuk grid wired (colspan), img2table untuk lainnya.
 */
function detectWiredGridRegions(canvas) {
  if (!canvas) return [];
  try {
    const { gray, w, h } = _toGrayData(canvas);
    if (w * h < 10000) return [];
    const thr = _otsu(gray, w, h);
    const horiz = _detectHorizLines(gray, w, h, thr);
    if (horiz.length < 2) return [];

    const margin = Math.floor(w * GRID_VERT_MARGIN);
    const regions = [];
    for (let i = 0; i < horiz.length - 1; i++) {
      const y0 = horiz[i];
      const y1 = horiz[i + 1];
      if (y1 - y0 < MIN_REGION_SIZE) continue;

      const bandH = y1 - y0;
      const minDark = bandH * LINE_DENSITY_THRESHOLD;
      const verts = [];
      let x = margin;
      while (x < w - margin) {
        let dark = 0;
        for (let y = y0; y <= y1; y++) {
          if (gray[y * w + x] < thr) dark++;
        }
        if (dark > minDark) {
          let runEnd = x;
          while (runEnd + 1 < w - margin) {
            let nextDark = 0;
            for (let y = y0; y <= y1; y++) {
              if (gray[y * w + runEnd + 1] < thr) nextDark++;
            }
            if (nextDark <= minDark) break;
            runEnd++;
          }
          verts.push(Math.floor((x + runEnd) / 2));
          x = runEnd + 1;
        } else {
          x++;
        }
      }

      if (verts.length < GRID_MIN_INNER_VERT) continue;
      const x0 = verts[0];
      const x1 = verts[verts.length - 1];
      if (x1 - x0 < MIN_REGION_SIZE) continue;
      regions.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    return _mergeRegions(regions);
  } catch (err) {
    logger.warn(`  Deteksi grid wired gagal: ${err.message}`);
    return [];
  }
}

function _clampRegion(region, imgW, imgH) {
  const pad = REGION_PADDING;
  const x = Math.max(0, Math.floor(region.x) - pad);
  const y = Math.max(0, Math.floor(region.y) - pad);
  const w = Math.min(Math.ceil(region.w) + pad * 2, imgW - x);
  const h = Math.min(Math.ceil(region.h) + pad * 2, imgH - y);
  return { x, y, w, h };
}

async function _cropAndEnhance(pageCanvas, region) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const { x, y, w, h } = region;

  const scaledW = w * REGION_UPSCALE;
  const scaledH = h * REGION_UPSCALE;
  const enhanced = createCanvas(scaledW, scaledH);
  const ctx = enhanced.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, scaledW, scaledH);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(pageCanvas, x, y, w, h, 0, 0, scaledW, scaledH);

  return enhanced;
}

async function ocrTableRegions(pageCanvas, regions, engine) {
  const outBlocks = [];
  if (!regions || regions.length === 0 || !engine) return outBlocks;

  for (const region of regions) {
    const clamped = _clampRegion(region, pageCanvas.width, pageCanvas.height);
    if (clamped.w < 10 || clamped.h < 10) continue;

    try {
      const enhanced = await _cropAndEnhance(pageCanvas, clamped);
      let processed = enhanced;

      try {
        processed = await deskewImage(enhanced, { skipOsd: true });
      } catch (err) {
        logger.warn(`  Deskew region gagal: ${err.message}, dilanjutkan tanpa deskew`);
      }

      processed = await preprocessImage(processed, { steps: ['grayscale', 'threshold'] });
      const blocks = await engine.recognizeBlocks(processed);

      for (const b of blocks || []) {
        const nb = normalizeBbox(b.bbox, processed.width, processed.height);
        outBlocks.push({
          text: b.text || '',
          confidence: b.confidence || 0,
          bbox: {
            x: Math.round(clamped.x + nb.x / REGION_UPSCALE),
            y: Math.round(clamped.y + nb.y / REGION_UPSCALE),
            w: Math.round(nb.w / REGION_UPSCALE),
            h: Math.round(nb.h / REGION_UPSCALE),
          },
          source: (b.source || 'region-ocr') + '-region',
          quality: b.quality || 'ok',
        });
      }
    } catch (err) {
      logger.warn(`  OCR region tabel gagal: ${err.message}`);
    }
  }

  return outBlocks;
}

function _blockCenter(block) {
  const nb = normalizeBbox(block.bbox, 1e9, 1e9);
  return { x: nb.x + nb.w / 2, y: nb.y + nb.h / 2, w: nb.w, h: nb.h };
}

function _blockInRegion(block, region) {
  const c = _blockCenter(block);
  const r = _clampRegion(region, 1e9, 1e9);
  return c.x > r.x && c.x < r.x + r.w && c.y > r.y && c.y < r.y + r.h;
}

// OCR per-sel berbasis garis grid: deteksi garis horizontal+vertikal →
// rect per sel → OCR tiap sel (2× upscale + grayscale+threshold via
// ocrTableCell) → rakit baris → tabel ASCII. Menjaga kolom tetap selaras —
// menghilangkan interleave kolom hasil OCR whole-page pada tabel grid
// (mis. halaman lampiran miring yang sudah di-rectify).
async function ocrGridCells(pageCanvas, engine) {
  if (!pageCanvas || !engine) return null;
  try {
    const { gray, w, h } = _toGrayData(pageCanvas);
    if (w * h < 10000) return null;
    const thr = _otsu(gray, w, h);
    const horiz = _detectHorizLines(gray, w, h, thr);
    const vert = _detectVertLines(gray, w, h, thr);
    if (horiz.length < 2 || vert.length < 2) return null;

    const rows = [];
    for (let i = 0; i < horiz.length - 1; i++) {
      const y0 = horiz[i];
      const y1 = horiz[i + 1];
      if (y1 - y0 < MIN_REGION_SIZE) continue;
      const row = [];
      for (let j = 0; j < vert.length - 1; j++) {
        const x0 = vert[j];
        const x1 = vert[j + 1];
        if (x1 - x0 < MIN_CELL_W) continue;
        row.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
      if (row.length >= 2) rows.push(row);
    }
    if (rows.length < 2) return null;

    const tableLines = [];
    for (const row of rows) {
      const cells = [];
      for (const cell of row) {
        let text = await ocrTableCell(pageCanvas, cell, engine);
        text = fixTableCellSymbol(text);
        cells.push(text);
      }
      tableLines.push(cells);
    }

    // (v30.4) Mode transkripsi: sel per baris " | " tanpa grid ASCII.
    const text =
      config.transcription && config.transcription.enabled
        ? tableLines.map((r) => r.join(' | ')).join('\n')
        : formatAsciiTable(tableLines);
    if (!text || text.length < 20) return null;
    logger.info(`  OCR grid per-sel: ${rows.length} baris x ${rows[0].length} kolom`);
    return { text, rows: tableLines };
  } catch (err) {
    logger.warn(`  OCR grid per-sel gagal: ${err.message}`);
    return null;
  }
}

async function repairTableBlocks(pageCanvas, blocks, engine) {
  if (!pageCanvas || !blocks || !engine) return { blocks: blocks || [], replaced: 0, regions: [] };

  let canvas = pageCanvas;
  try {
    canvas = await deskewImage(pageCanvas, { skipOsd: true });
  } catch (err) {
    logger.warn(`  Deskew canvas repair gagal: ${err.message}, lanjut tanpa koreksi`);
  }

  const regions = detectTableRegions(canvas);
  if (regions.length === 0) return { blocks, replaced: 0, regions: [] };

  logger.info(`  Repair tabel: ${regions.length} region terdeteksi, OCR per-region...`);
  const newBlocks = await ocrTableRegions(canvas, regions, engine);

  if (newBlocks.length === 0) {
    // Region terdeteksi tapi OCR region gagal → coba grid per-sel langsung
    // dari blok yang ada.
    const grid = await ocrGridCells(canvas, engine);
    if (!grid) return { blocks, replaced: 0, regions };
    const gridScore = computeQualityScore([{ text: grid.text, confidence: 1 }]);
    const curScore = computeQualityScore(blocks);
    if (gridScore.score <= curScore.score) return { blocks, replaced: 0, regions };
    logger.info(
      `  Repair tabel: grid per-sel menggantikan blok region (score ${curScore.score.toFixed(2)} -> ${gridScore.score.toFixed(2)})`,
    );
    return {
      blocks: [{ text: grid.text, confidence: 1, source: 'grid-cells', quality: 'ok' }],
      replaced: 1,
      regions,
    };
  }

  const kept = blocks.filter((b) => !regions.some((r) => _blockInRegion(b, r)));
  const merged = [...kept, ...newBlocks].sort((a, b) => {
    const ca = _blockCenter(a);
    const cb = _blockCenter(b);
    return ca.y - cb.y || ca.x - cb.x;
  });

  // Grid per-sel: untuk tabel wired, sel di-OCR satu per satu agar kolom
  // selaras. Hanya menggantikan bila skor kualitas lebih tinggi (tanpa
  // regresi); blok whole-page yang kontennya sudah tercakup tabel dibuang.
  const grid = await ocrGridCells(canvas, engine);
  if (grid) {
    const gridScore = computeQualityScore([{ text: grid.text, confidence: 1 }]);
    const mergedScore = computeQualityScore(merged);
    if (gridScore.score > mergedScore.score) {
      const gridLower = grid.text.toLowerCase();
      const keptFiltered = kept.filter((b) => {
        const isWholePage = !(b.bbox && (b.bbox.w || b.bbox.x2 || b.bbox.h || b.bbox.y2));
        if (!isWholePage) return true;
        const lines = (b.text || '')
          .split('\n')
          .map((l) => l.trim().toLowerCase())
          .filter(Boolean);
        if (lines.length < 4) return true;
        let matched = 0;
        for (const line of lines) {
          const toks = line.split(/\s+/).filter((w) => w.length >= 4);
          if (toks.length > 0 && toks.every((t) => gridLower.includes(t))) matched++;
        }
        return matched / lines.length < 0.6;
      });
      logger.info(
        `  Repair tabel: grid per-sel menang (score ${mergedScore.score.toFixed(2)} -> ${gridScore.score.toFixed(2)})`,
      );
      return {
        blocks: [...keptFiltered, { text: grid.text, confidence: 1, source: 'grid-cells', quality: 'ok' }],
        replaced: newBlocks.length,
        regions,
      };
    }
  }

  logger.info(`  Repair tabel: ${newBlocks.length} blok baru menggantikan blok dalam region`);
  return { blocks: merged, replaced: newBlocks.length, regions };
}

module.exports = {
  detectTableRegions,
  detectWiredGridRegions,
  ocrTableRegions,
  ocrGridCells,
  repairTableBlocks,
  blockInRegion: _blockInRegion,
};
