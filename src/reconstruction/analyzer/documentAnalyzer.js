const logger = require('../../services/logger');

const documentAnalyzer = {
  async analyze(pdfBuffer, ocrBlocks) {
    const pdfInfo = this._detectPdfType(pdfBuffer);
    const ocrInfo = this._analyzeOcrBlocks(ocrBlocks);
    const digital = this._isDigitalPdf(pdfBuffer, ocrBlocks);
    const type = digital ? 'digital' : 'scan';

    const result = {
      type,
      pageCount: pdfInfo.pageCount || ocrInfo.pageCount || 0,
      title: null,
      fileSize: pdfBuffer ? pdfBuffer.length : 0,
      hasTextLayer: digital,
      hasTables: ocrInfo.hasTables,
      pageSize: pdfInfo.pageSize || null,
      estimatedWords: ocrInfo.wordCount || 0,
      languages: ['id'],
      pages: [],
    };

    if (!digital && ocrBlocks.length > 0) {
      result.pages = this._groupBlocksByPage(ocrBlocks);
    }

    logger.info(`  Analisis: ${type} PDF, ${result.pageCount} halaman, ${result.estimatedWords} kata`);
    return result;
  },

  _detectPdfType(buffer) {
    if (!buffer || buffer.length < 10) return {};
    const header = buffer.slice(0, 8).toString('latin1');
    if (!header.startsWith('%PDF')) return {};
    const verMatch = header.match(/%PDF-(\d+\.\d+)/);
    const version = verMatch ? verMatch[1] : null;
    let pageCount = 0;
    const pageMatches = buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
    pageCount = pageMatches ? pageMatches.length : 0;
    if (pageCount === 0) {
      const pagesMatch = buffer.toString('latin1').match(/\/Pages\s*\[/g);
      pageCount = pagesMatch ? pagesMatch.length : 1;
    }
    return { version, pageCount };
  },

  _analyzeOcrBlocks(blocks) {
    if (!blocks || blocks.length === 0) return { wordCount: 0, hasTables: false };
    let wordCount = 0;
    let hasTables = false;
    for (const b of blocks) {
      const words = (b.text || '').split(/\s+/).filter((w) => w.length > 0);
      wordCount += words.length;
      if (words.length > 3 && words.every((w) => /^\d+$/.test(w))) hasTables = true;
      if (b.type === 'table') hasTables = true;
    }
    return { wordCount, hasTables };
  },

  _isDigitalPdf(buffer, ocrBlocks) {
    if (ocrBlocks && ocrBlocks.length > 0 && ocrBlocks.some((b) => b.source === 'pdf-text')) return true;
    if (!buffer || buffer.length < 100) return false;
    const content = buffer.toString('latin1');
    const textOps = (content.match(/\([^)]{3,}\)/g) || []).length;
    const tjOps = (content.match(/TJ/g) || []).length;
    const digitalScore = textOps + tjOps * 5;
    const pages = (content.match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (pages > 0 && digitalScore / pages > 3) return true;
    return digitalScore > 20;
  },

  _groupBlocksByPage(blocks) {
    const pageMap = {};
    for (const b of blocks) {
      const p = b.page != null ? b.page : 0;
      if (!pageMap[p]) pageMap[p] = { pageNum: p, blocks: [] };
      pageMap[p].blocks.push(b);
    }
    return Object.values(pageMap).sort((a, b) => a.pageNum - b.pageNum);
  },
};

module.exports = { documentAnalyzer };
