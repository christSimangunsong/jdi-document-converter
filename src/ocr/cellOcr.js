const config = require('../config');
const logger = require('../services/logger');
const { preprocessImage } = require('./preprocessor');

async function ocrTableCell(fullCanvas, bbox, engine) {
  try {
    const { x, y, w, h } = normalizeBbox(bbox, fullCanvas.width, fullCanvas.height);
    if (w < 5 || h < 5) return '';

    const { createCanvas } = await import('@napi-rs/canvas');
    const cellCanvas = createCanvas(w * 2, h * 2);
    const ctx = cellCanvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, cellCanvas.width, cellCanvas.height);
    ctx.scale(2, 2);
    ctx.drawImage(fullCanvas, x, y, w, h, 0, 0, w, h);

    let processed = cellCanvas;
    if (config.ocr?.preprocess) {
      const steps = ['grayscale', 'threshold'];
      processed = await preprocessImage(cellCanvas, { steps });
    }

    const result = await engine.recognizePage(processed);
    return (result || '').trim();
  } catch (err) {
    logger.warn(`  Cell OCR gagal: ${err.message}`);
    return '';
  }
}

function normalizeBbox(bbox, imgW, imgH) {
  let x, y, w, h;

  if (Array.isArray(bbox)) {
    if (bbox.length === 4) {
      if (typeof bbox[0] === 'object') {
        x = bbox[0].x || bbox[0][0] || 0;
        y = bbox[0].y || bbox[0][1] || 0;
        if (bbox.length === 4 && typeof bbox[2] === 'object') {
          w = (bbox[2].x || bbox[2][0] || imgW) - x;
          h = (bbox[2].y || bbox[2][1] || imgH) - y;
        } else {
          w = (bbox[1].x || bbox[1][0] || imgW) - x;
          h = (bbox[2].y || bbox[2][1] || imgH) - y;
        }
      } else {
        x = Math.min(bbox[0], bbox[2]);
        y = Math.min(bbox[1], bbox[3]);
        w = Math.abs(bbox[2] - bbox[0]);
        h = Math.abs(bbox[3] - bbox[1]);
      }
    } else if (bbox.length === 8) {
      const xs = [bbox[0], bbox[2], bbox[4], bbox[6]];
      const ys = [bbox[1], bbox[3], bbox[5], bbox[7]];
      x = Math.min(...xs);
      y = Math.min(...ys);
      w = Math.max(...xs) - x;
      h = Math.max(...ys) - y;
    } else {
      x = 0;
      y = 0;
      w = imgW;
      h = imgH;
    }
  } else if (bbox && typeof bbox === 'object') {
    x = bbox.x || bbox.left || 0;
    y = bbox.y || bbox.top || 0;
    w = bbox.w || bbox.width || bbox.right ? bbox.right - x : imgW;
    h = bbox.h || bbox.height || bbox.bottom ? bbox.bottom - y : imgH;
  } else {
    x = 0;
    y = 0;
    w = imgW;
    h = imgH;
  }

  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    w: Math.min(Math.ceil(w), imgW - Math.max(0, Math.floor(x))),
    h: Math.min(Math.ceil(h), imgH - Math.max(0, Math.floor(y))),
  };
}

const SYMBOL_MAP = [
  { re: /^v$/i, sym: '✓' },
  { re: /^\\\/$/, sym: '✓' },
  { re: /^[oO0]$/, sym: '☐' },
  { re: /^\[\s*\]$/, sym: '☐' },
  { re: /^\[[vx]\]$/i, sym: '☑' },
  { re: /^[oO0][vx]$/i, sym: '☑' },
  { re: /^->$/, sym: '→' },
  { re: /^=>$/, sym: '⇒' },
  { re: /^[oO*]$/, sym: '•' },
  { re: /^[xX*]$/, sym: '×' },
  { re: /^\(?v\)?$/, sym: '✓' },
];

function fixTableCellSymbol(text) {
  const t = (text || '').trim();
  if (!t || t.length > 3) return text;
  for (const { re, sym } of SYMBOL_MAP) {
    if (re.test(t)) return sym;
  }
  return text;
}

function clusterBlocksToGrid(blocks, imgW, imgH) {
  if (!blocks || blocks.length === 0) return null;

  const avgH =
    blocks.filter((b) => b.bbox).reduce((sum, b) => sum + (normalizeBbox(b.bbox, imgW || 1, imgH || 1).h || 15), 0) /
    Math.max(1, blocks.filter((b) => b.bbox).length);
  const ROW_THRESHOLD = Math.max(8, avgH * 0.8);

  const rows = new Map();

  for (const block of blocks) {
    const nb = block.bbox ? normalizeBbox(block.bbox, imgW || 1, imgH || 1) : { y: 0, h: 0 };
    const cy = nb.y + nb.h / 2;
    let assigned = false;
    for (const [rowY, rowBlocks] of rows) {
      if (Math.abs(cy - rowY) < ROW_THRESHOLD) {
        rowBlocks.push(block);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      rows.set(cy, [block]);
    }
  }

  const sortedRows = Array.from(rows.entries())
    .sort(([a], [b]) => a - b)
    .map(([, rowBlocks]) => {
      return rowBlocks.sort((a, b) => {
        const ax = a.bbox ? normalizeBbox(a.bbox, imgW || 1, imgH || 1).x : 0;
        const bx = b.bbox ? normalizeBbox(b.bbox, imgW || 1, imgH || 1).x : 0;
        return ax - bx;
      });
    });

  return sortedRows;
}

async function reconstructTableFromBlocks(fullCanvas, blocks, engine) {
  const iw = fullCanvas ? fullCanvas.width : 1;
  const ih = fullCanvas ? fullCanvas.height : 1;
  const grid = clusterBlocksToGrid(blocks, iw, ih);
  if (!grid || grid.length < 2) return null;

  logger.info(`  Rekonstruksi tabel: ${grid.length} baris terdeteksi`);

  const maxCols = Math.max(...grid.map((row) => row.length));
  const tableLines = [];

  for (const row of grid) {
    const cellTexts = [];
    for (const cell of row) {
      let text = cell.text || '';
      if (fullCanvas) {
        text = fixTableCellSymbol(text);
      }
      if (!text && cell.bbox && fullCanvas) {
        text = await ocrTableCell(fullCanvas, cell.bbox, engine);
        text = fixTableCellSymbol(text);
      }
      cellTexts.push(text.trim());
    }
    while (cellTexts.length < maxCols) cellTexts.push('');
    tableLines.push(cellTexts.slice(0, maxCols));
  }

  return formatAsciiTable(tableLines);
}

function formatAsciiTable(rows) {
  if (!rows || rows.length === 0) return '';

  const colCount = Math.max(...rows.map((r) => r.length));
  const colWidths = [];

  for (let c = 0; c < colCount; c++) {
    let maxWidth = 0;
    for (const row of rows) {
      if (c < row.length) {
        maxWidth = Math.max(maxWidth, (row[c] || '').length);
      }
    }
    colWidths.push(Math.min(Math.max(maxWidth + 2, 5), 60));
  }

  const sep = '+' + colWidths.map((w) => '-'.repeat(w)).join('+') + '+';
  const lines = [sep];

  for (const row of rows) {
    const maxLines = Math.max(
      1,
      ...row.map((cell) => {
        const text = cell || '';
        const w = colWidths[row.indexOf(cell)] - 2;
        return w > 0 ? Math.ceil(text.length / w) : 1;
      }),
    );

    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
      let line = '|';
      for (let c = 0; c < colCount; c++) {
        const text = c < row.length ? row[c] || '' : '';
        const w = colWidths[c] - 2;
        const start = lineIdx * Math.max(w, 1);
        const part = text.substring(start, start + Math.max(w, 1));
        line += ' ' + part.padEnd(Math.max(w, 0)) + ' |';
      }
      lines.push(line);
    }
    lines.push(sep);
  }

  return lines.join('\n');
}

module.exports = {
  ocrTableCell,
  normalizeBbox,
  clusterBlocksToGrid,
  reconstructTableFromBlocks,
  formatAsciiTable,
  fixTableCellSymbol,
};
