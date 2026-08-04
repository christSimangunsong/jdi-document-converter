const { Document, DocumentNode } = require('./models/documentModel');
const { documentAnalyzer } = require('./analyzer/documentAnalyzer');
const { textExtractor } = require('./analyzer/textExtractor');
const { readingOrderResolver } = require('./builder/readingOrderResolver');
const { lineMerger } = require('./builder/lineMerger');
const { documentTreeBuilder } = require('./builder/documentTreeBuilder');
const { legalParser } = require('./builder/legalParser');
const { markdownGenerator } = require('./output/markdownGenerator');
const { htmlGenerator } = require('./output/htmlGenerator');
const { semanticJsonGenerator } = require('./output/semanticJsonGenerator');
const { chunkBuilder } = require('./output/chunkBuilder');
const { embeddingFormatter } = require('./output/embeddingFormatter');
const { visualDebugger } = require('./debug/visualDebugger');
const { reviewDocument } = require('./review/documentReviewer');
const { cleanLines, filterPageChrome } = require('./cleaner/outputCleaner');
const logger = require('../services/logger');

class Pipeline {
  constructor(config = {}) {
    this.config = {
      debug: config.debug || false,
      debugDir: config.debugDir || './debug',
      outputDir: config.outputDir || './output',
      lang: config.lang || 'id',
      chunkSize: config.chunkSize || 1000,
      chunkOverlap: config.chunkOverlap || 200,
      ...config,
    };
    this.stages = [];
  }

  use(name, fn) {
    this.stages.push({ name, fn });
    return this;
  }

  buildDefaultPipeline() {
    this.stages = [
      { name: 'analyzer', fn: () => {} },
      { name: 'readingOrder', fn: () => {} },
      { name: 'lineMerger', fn: () => {} },
      { name: 'treeBuilder', fn: () => {} },
      { name: 'legalParser', fn: () => {} },
      { name: 'markdown', fn: () => {} },
      { name: 'html', fn: () => {} },
      { name: 'json', fn: () => {} },
      { name: 'chunks', fn: () => {} },
    ];
  }

  async run(pdfBuffer, ocrBlocks, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const ctx = {
      pdfBuffer,
      ocrBlocks: ocrBlocks || [],
      pages: [],
      lines: [],
      tree: null,
      document: null,
      markdown: '',
      html: '',
      json: null,
      chunks: [],
      config: this.config,
    };

    const startTime = Date.now();

    onProgress(0, 'Menganalisis dokumen...');
    const analysis = await documentAnalyzer.analyze(pdfBuffer, ocrBlocks);
    ctx.analysis = analysis;
    ctx.pages = analysis.pages || [];
    onProgress(0.05, `${analysis.type} PDF: ${analysis.pageCount} halaman`);

    if (ocrBlocks.length > 0) {
      const sampleTexts = ocrBlocks.slice(0, 3).map((b) => (b.text || '').substring(0, 60));
      logger.info(`  DEBUG: ocrBlocks[0..2] = ${JSON.stringify(sampleTexts)}`);
      onProgress(0.15, `${ocrBlocks.length} blok OCR diterima`);
    } else if (analysis.type === 'digital') {
      const extracted = await textExtractor.extract(pdfBuffer);
      ctx.pages = extracted.pages;
      const blocks = [];
      for (const page of extracted.pages) {
        const lines = page.text.split('\n').filter((l) => l.trim());
        for (let i = 0; i < lines.length; i++) {
          blocks.push({
            text: lines[i],
            confidence: 1,
            page: page.pageNum,
            bbox: { x: 0, y: i * 20, w: 100, h: 16 },
            order: blocks.length,
          });
        }
      }
      ctx.ocrBlocks = blocks;
      onProgress(0.15, 'Teks digital diekstrak');
    } else {
      throw new Error('Scan PDF membutuhkan OCR blocks');
    }

    onProgress(0.3, 'Menentukan urutan baca...');
    ctx.ocrBlocks = readingOrderResolver.resolve(ctx.ocrBlocks, { pages: ctx.pages });
    logger.info(`  DEBUG: after readingOrderResolver — ${ctx.ocrBlocks.length} blocks`);
    onProgress(0.4, 'Menggabungkan baris...');
    ctx.lines = lineMerger.merge(ctx.ocrBlocks);
    ctx.lines = cleanLines(ctx.lines);
    ctx.lines = filterPageChrome(ctx.lines);
    logger.info(
      `  DEBUG: after lineMerger — ${ctx.lines.length} lines, first text: "${((ctx.lines[0] && ctx.lines[0].text) || '').substring(0, 80)}"`,
    );
    onProgress(0.5, 'Membangun pohon dokumen...');
    ctx.tree = await documentTreeBuilder.build(ctx.lines, {
      lang: this.config.lang,
      debug: this.config.debug,
    });
    logger.info(`  DEBUG: after documentTreeBuilder — ${(ctx.tree.children || []).length} children`);
    onProgress(0.65, 'Parsing struktur hukum...');
    ctx.tree = legalParser.parse(ctx.tree);
    onProgress(0.7, 'Review struktur dokumen...');
    ctx.review = this.config.review && this.config.review.enabled === false ? null : reviewDocument(ctx);
    onProgress(0.75, 'Menghasilkan Markdown...');
    ctx.markdown = markdownGenerator.generate(ctx.tree, analysis);
    logger.info(
      `  DEBUG: markdown length = ${(ctx.markdown || '').length}, first 200 chars: "${(ctx.markdown || '').substring(0, 200)}"`,
    );
    onProgress(0.8, 'Menghasilkan HTML...');
    ctx.html = htmlGenerator.generate(ctx.tree, analysis);
    onProgress(0.85, 'Menghasilkan JSON semantik...');
    ctx.json = semanticJsonGenerator.generate(ctx.tree, analysis);
    onProgress(0.9, 'Membangun chunk...');
    ctx.chunks = chunkBuilder.build(ctx.tree, {
      chunkSize: this.config.chunkSize,
      chunkOverlap: this.config.chunkOverlap,
    });
    onProgress(0.95, 'Memformat embedding...');
    ctx.embedding = embeddingFormatter.format(ctx.chunks, analysis);

    ctx.duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`  Rekonstruksi selesai dalam ${ctx.duration}s`);

    if (this.config.debug && ocrBlocks.length > 0) {
      try {
        await visualDebugger.generate(ctx, this.config.debugDir);
      } catch (err) {
        logger.warn(`  Visual debug gagal: ${err.message}`);
      }
    }

    const doc = new Document({
      title: analysis.title || 'untitled',
      pages: analysis.pageCount || 0,
      metadata: {
        ...analysis,
        duration: ctx.duration,
        config: { ocrEngine: options.ocrEngine, lang: this.config.lang },
      },
      sections: ctx.tree ? ctx.tree.children : [],
      markdown: ctx.markdown,
      html: ctx.html,
      json: ctx.json,
      chunks: ctx.chunks,
      review: ctx.review,
    });
    doc.root = ctx.tree;

    return doc;
  }
}

module.exports = { Pipeline };
