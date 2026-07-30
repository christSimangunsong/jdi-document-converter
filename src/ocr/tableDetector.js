const config = require('../config');
const logger = require('../services/logger');
const axios = require('axios');
const { performOcr } = require('./engine');

const SIDECAR_TIMEOUT = 30000;

async function detectTableStructure(canvas) {
  const result = await tryPpStructure(canvas);
  if (result) return result;

  const suryaResult = await trySurya(canvas);
  if (suryaResult) return suryaResult;

  return await detectTableHeuristic(canvas);
}

async function tryPpStructure(canvas) {
  const url = config.structureServiceUrl;
  if (!url) return null;

  try {
    const buf = canvas.toBuffer('image/png');
    const b64 = buf.toString('base64');
    const resp = await axios.post(`${url}/analyze`, {
      images: [b64],
      lang: config.ocrLang || 'id',
    }, { timeout: SIDECAR_TIMEOUT });

    if (!resp.data || !resp.data.pages || resp.data.pages.length === 0) return null;

    const page = resp.data.pages[0];
    const hasTables = page.tables && page.tables.length > 0;

    if (hasTables) {
      logger.info('  PP-StructureV3: tabel terdeteksi');
      return {
        source: 'ppstructure',
        text: page.text || '',
        tables: page.tables.map(t => ({
          html: t.html || '',
          confidence: t.confidence || 0,
        })),
        confidence: Math.max(...page.tables.map(t => t.confidence || 0), 0),
      };
    }

    if (page.text && page.text.trim().length > 50) {
      return {
        source: 'ppstructure',
        text: page.text,
        tables: [],
        confidence: 0.5,
      };
    }

    return null;
  } catch (err) {
    logger.warn(`  PP-StructureV3 tidak tersedia: ${err.message}`);
    return null;
  }
}

async function trySurya(canvas) {
  const suryaUrl = process.env.SURYA_SERVICE_URL || 'http://localhost:5001';
  if (!suryaUrl) return null;

  try {
    const buf = canvas.toBuffer('image/png');
    const b64 = buf.toString('base64');
    const resp = await axios.post(`${suryaUrl}/analyze`, {
      images: [b64],
      lang: config.ocrLang || 'id',
    }, { timeout: SIDECAR_TIMEOUT });

    if (!resp.data || !resp.data.pages || resp.data.pages.length === 0) return null;

    const page = resp.data.pages[0];
    const blocks = page.blocks || [];

    if (blocks.length < 5) return null;

    const avgConf = blocks.reduce((s, b) => s + (b.confidence || 0), 0) / blocks.length;
    const digitBlocks = blocks.filter(b => {
      const words = (b.text || '').split(/\s+/).filter(w => w.length > 0);
      return words.length > 0 && words.every(w => /^[\d.,%Rp]+$/.test(w));
    });

    if (digitBlocks.length > blocks.length * 0.2 || blocks.length > 15) {
      logger.info(`  Surya: ${blocks.length} blok terdeteksi, ${digitBlocks.length} numerik`);
      return {
        source: 'surya',
        text: blocks.map(b => b.text).join('\n'),
        blocks: blocks.map(b => ({
          text: b.text || '',
          confidence: b.confidence || 0,
          bbox: b.bbox || null,
        })),
        confidence: avgConf,
        isTable: digitBlocks.length > blocks.length * 0.15,
      };
    }

    return null;
  } catch (err) {
    logger.warn(`  Surya tidak tersedia: ${err.message}`);
    return null;
  }
}

async function detectTableHeuristic(canvas) {
  try {
    const text = await performOcr([canvas]);
    const pageText = text[0] || '';
    if (!pageText || pageText.trim().length < 20) return null;

    const lines = pageText.split('\n').filter(l => l.trim().length > 0);
    if (lines.length < 3) return null;

    let digitLineCount = 0;
    let totalLines = 0;
    let columnAligned = true;
    let prevColCount = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      const words = trimmed.split(/\s+/).filter(w => w.length > 0);
      if (words.length < 2) continue;
      totalLines++;

      const digitWords = words.filter(w => /^[\d.,%Rp]+$/.test(w));
      if (digitWords.length > words.length * 0.4) {
        digitLineCount++;
      }

      if (prevColCount > 0 && Math.abs(words.length - prevColCount) > 2) {
        columnAligned = false;
      }
      prevColCount = words.length;
    }

    const isTable = totalLines > 0 && (
      (digitLineCount / totalLines > 0.3 && columnAligned) ||
      lines.some(l => l.includes('No.') || l.includes('DESA') || l.includes('JUMLAH'))
    );

    if (isTable) {
      logger.info(`  Heuristic: tabel terdeteksi (${digitLineCount}/${totalLines} baris numerik)`);
      return {
        source: 'heuristic',
        text: pageText,
        blocks: [],
        confidence: 0.3,
        isTable: true,
      };
    }

    return null;
  } catch (err) {
    logger.warn(`  Heuristic table detection gagal: ${err.message}`);
    return null;
  }
}

function detectTableFromLines(lines) {
  if (!lines || lines.length < 3) return [];
  const tables = [];
  let startIdx = -1;
  let tableLines = [];
  let prevCols = null;

  function flushTable() {
    if (tableLines.length >= 3) {
      const t = buildTable(tableLines);
      if (t) {
        tables.push({ table: t, lines: tableLines.slice(), startIdx });
      }
    }
    tableLines = [];
    prevCols = null;
    startIdx = -1;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const blocks = (line.blocks || []).filter(b => b.bbox && typeof b.bbox.x === 'number' && !isNaN(b.bbox.x));
    if (blocks.length < 2) { flushTable(); continue; }

    const cols = blocks.map(b => ({
      x: b.bbox.x, w: b.bbox.w,
      text: b.text || '',
    }));

    if (prevCols && colStructMatch(cols, prevCols)) {
      if (tableLines.length === 0) startIdx = i;
      tableLines.push(line);
    } else if (tableLines.length >= 3) {
      const t = buildTable(tableLines);
      if (t) tables.push({ table: t, lines: tableLines.slice(), startIdx });
      tableLines = [line];
      prevCols = cols;
      startIdx = i;
    } else {
      tableLines = [];
      prevCols = null;
      startIdx = -1;
    }
    prevCols = cols;
  }

  if (tableLines.length >= 3) {
    const t = buildTable(tableLines);
    if (t) tables.push({ table: t, lines: tableLines.slice(), startIdx });
  }

  return tables;
}

function colStructMatch(curr, prev) {
  if (curr.length !== prev.length) return false;
  const cn = curr.length;
  if (cn < 2) return false;
  let matches = 0;
  for (let i = 0; i < cn; i++) {
    const cMid = curr[i].x + curr[i].w / 2;
    const pMid = prev[i].x + prev[i].w / 2;
    if (Math.abs(cMid - pMid) < Math.max(curr[i].w, prev[i].w) * 0.6) matches++;
  }
  return matches >= cn * 0.6;
}

function buildTable(tableLines) {
  const blockRows = tableLines.map(line =>
    (line.blocks || []).filter(b => b.bbox && typeof b.bbox.x === 'number')
  );
  const maxCols = Math.max(...blockRows.map(r => r.length));
  if (maxCols < 2) return null;
  const normalized = blockRows.map(row => {
    const cells = row.map(b => b.text || '');
    while (cells.length < maxCols) cells.push('');
    return cells;
  });
  return { headers: normalized[0], rows: normalized.slice(1) };
}

module.exports = {
  detectTableStructure,
  detectTableFromLines,
};
