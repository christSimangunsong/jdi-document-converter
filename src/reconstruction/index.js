const { Pipeline } = require('./pipeline');
const config = require('../config');
const logger = require('../services/logger');

let _pipeline = null;

function getPipeline() {
  if (_pipeline) return _pipeline;
  const reconstCfg = config.reconstruction || {};
  _pipeline = new Pipeline({
    debug: reconstCfg.debug === true || reconstCfg.debug === 'true',
    debugDir: reconstCfg.debugDir || './debug',
    outputDir: config.outputDir || './output',
    lang: config.ocrLang || 'id',
    chunkSize: reconstCfg.chunkSize || 1000,
    chunkOverlap: reconstCfg.chunkOverlap || 200,
    review: config.review || { enabled: true, maxIssues: 50 },
  });
  return _pipeline;
}

async function runReconstruction(pdfBuffer, ocrBlocks, options = {}) {
  const pipeline = getPipeline();
  logger.info('  Memulai rekonstruksi dokumen...');
  const doc = await pipeline.run(pdfBuffer, ocrBlocks, options);
  logger.info(`  Output: ${doc.markdown ? doc.markdown.length + ' chars markdown' : 'none'}`);
  return doc;
}

module.exports = { runReconstruction, getPipeline };
