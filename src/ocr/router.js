const config = require('../config');
const logger = require('../services/logger');
const factory = require('./engineFactory');
const { preprocessImage } = require('./preprocessor');
const { computePageScore, shouldRetry, selectRetryStrategy } = require('./qualityMetrics');
const { PaddleEngine } = require('./engines/paddleEngine');
const { TesseractEngine } = require('./engines/tesseractEngine');
const { SuryaEngine } = require('./engines/suryaEngine');

factory.registerEngine('paddle', PaddleEngine);
factory.registerEngine('tesseract', TesseractEngine);
factory.registerEngine('surya', SuryaEngine);

let _activeEngine = null;
let _engineConfig = null;
const _preprocessedCache = [];

function getEngineConfig() {
  if (_engineConfig) return _engineConfig;

  const ocrCfg = config.ocr || {};
  _engineConfig = {
    engine: ocrCfg.engine || 'paddle',
    preprocess: ocrCfg.preprocess === true || ocrCfg.preprocess === 'true',
    preprocessSteps: ocrCfg.preprocessSteps
      ? ocrCfg.preprocessSteps.split(',')
      : ['grayscale', 'denoise', 'threshold'],
    minimumConfidence: ocrCfg.minimumConfidence || 0.3,
    lang: ocrCfg.lang || 'id',
    serviceUrl: config.structureServiceUrl || '',
    timeout: config.sidecarTimeout || 120000,
  };

  _engineConfig.serviceUrl = _engineConfig.serviceUrl || process.env.SURYA_SERVICE_URL || '';

  return _engineConfig;
}

async function getActiveEngine() {
  if (_activeEngine) return _activeEngine;

  const engCfg = getEngineConfig();

  try {
    _activeEngine = await factory.resolveEngine(engCfg);
    logger.info(`  OCR Engine aktif: ${_activeEngine.getMetadata().name}`);
  } catch (err) {
    logger.warn(`  Gagal resolve engine: ${err.message}. Fallback ke PaddleEngine...`);
    _activeEngine = await factory.createEngine('paddle', engCfg);
  }

  return _activeEngine;
}

async function resetEngine() {
  if (_activeEngine) {
    try {
      await _activeEngine.destroy();
    } catch (_) {}
    _activeEngine = null;
  }
}

async function performOcr(imageBuffers, onProgress) {
  const results = [];
  const engCfg = getEngineConfig();
  const maxRetries = config.ocr?.maxConfidenceRetries || 2;
  _preprocessedCache.length = 0;

  for (let i = 0; i < imageBuffers.length; i++) {
    const engine = await getActiveEngine();
    const engineName = engine.getMetadata().name;

    logger.info(`  OCR halaman ${i + 1}/${imageBuffers.length} (${engineName})...`);

    let pageText = '';
    let bestText = '';
    let bestScore = { confidence: 0, garbageRatio: 1 };

    for (let retry = 0; retry <= maxRetries; retry++) {
      try {
        let img = imageBuffers[i];

        if (engCfg.preprocess && img) {
          if (retry === 0) {
            img = await preprocessImage(img, { steps: engCfg.preprocessSteps });
            _preprocessedCache[i] = img;
          } else {
            img = _preprocessedCache[i] || img;
          }
        }

        const blocks = await engine.recognizeBlocks(img);
        const score = computePageScore(blocks);
        pageText = blocks.map(b => b.text).join('\n');

        if (score.confidence > bestScore.confidence) {
          bestScore = score;
          bestText = pageText;
        }

        if (!shouldRetry(score, retry, { maxRetries })) {
          break;
        }

        logger.info(`  Halaman ${i + 1} kualitas rendah (conf: ${score.confidence.toFixed(2)}, garbage: ${score.garbageRatio.toFixed(2)}), retry ${retry + 1}/${maxRetries}...`);

        const strategy = selectRetryStrategy(retry + 1);
        if (strategy.engine && retry < maxRetries) {
          await trySwitchEngine(strategy.engine);
        }
      } catch (error) {
        logger.warn(`  OCR halaman ${i + 1} percobaan ${retry + 1} gagal: ${error.message}.`);
        if (retry < maxRetries) {
          logger.info('  Mencoba engine alternatif...');
          await trySwitchEngine('auto');
        } else {
          pageText = '';
        }
      }
    }

    results.push(bestText || pageText);

    if (onProgress) {
      onProgress(i + 1, imageBuffers.length);
    }
  }

  return results;
}

async function trySwitchEngine(preferred) {
  try {
    await resetEngine();
    if (preferred === 'auto' || !preferred) {
      const current = _engineConfig?.engine || 'paddle';
      const alternatives = { paddle: 'tesseract', tesseract: 'paddle', surya: 'paddle' };
      _engineConfig.engine = alternatives[current] || 'paddle';
    } else {
      _engineConfig.engine = preferred;
    }
    logger.info(`  Beralih engine ke: ${_engineConfig.engine}`);
  } catch (err) {
    logger.warn(`  Gagal ganti engine: ${err.message}`);
  }
}

async function performOcrBlocks(imageBuffers, onProgress) {
  const results = [];
  const engCfg = getEngineConfig();
  const maxRetries = config.ocr?.maxConfidenceRetries || 2;
  _preprocessedCache.length = 0;

  for (let i = 0; i < imageBuffers.length; i++) {
    const engine = await getActiveEngine();
    const engineName = engine.getMetadata().name;

    logger.info(`  OCR blocks halaman ${i + 1}/${imageBuffers.length} (${engineName})...`);

    let pageBlocks = [];
    let bestScore = { confidence: 0, garbageRatio: 1 };

    for (let retry = 0; retry <= maxRetries; retry++) {
      try {
        let img = imageBuffers[i];
        if (engCfg.preprocess && img) {
          if (retry === 0) {
            img = await preprocessImage(img, { steps: engCfg.preprocessSteps });
            _preprocessedCache[i] = img;
          } else {
            img = _preprocessedCache[i] || img;
          }
        }
        const blocks = await engine.recognizeBlocks(img);
        const score = computePageScore(blocks);

        if (score.confidence > bestScore.confidence) {
          bestScore = score;
          pageBlocks = blocks;
        }

        if (!shouldRetry(score, retry, { maxRetries })) {
          break;
        }

        logger.info(`  Halaman ${i + 1} kualitas rendah (conf: ${score.confidence.toFixed(2)}, garbage: ${score.garbageRatio.toFixed(2)}), retry ${retry + 1}/${maxRetries}...`);

        const strategy = selectRetryStrategy(retry + 1);
        if (strategy.engine && retry < maxRetries) {
          await trySwitchEngine(strategy.engine);
        }
      } catch (error) {
        logger.warn(`  OCR blocks halaman ${i + 1} percobaan ${retry + 1} gagal: ${error.message}.`);
        if (retry < maxRetries) {
          await trySwitchEngine('auto');
        } else {
          pageBlocks = [];
        }
      }
    }

    for (const b of pageBlocks) {
      b.page = i;
      b.order = results.length + (b.order || 0);
    }
    results.push(...pageBlocks);

    if (onProgress) onProgress(i + 1, imageBuffers.length);
  }

  return results;
}

async function performOcrWithEngine(engine, imageBuffers, onProgress) {
  const results = [];
  const engCfg = getEngineConfig();
  const engineName = engine.getMetadata().name;

  for (let i = 0; i < imageBuffers.length; i++) {
    logger.info(`  OCR halaman ${i + 1}/${imageBuffers.length} (${engineName})...`);

    try {
      let img = imageBuffers[i];

      if (engCfg.preprocess && img) {
        img = await preprocessImage(img, { steps: engCfg.preprocessSteps });
      }

      const pageText = await engine.recognizePage(img);
      results.push(pageText);
    } catch (error) {
      logger.warn(`  OCR halaman ${i + 1} gagal: ${error.message}. Dilewati.`);
      results.push('');
    }

    if (onProgress) {
      onProgress(i + 1, imageBuffers.length);
    }
  }

  return results;
}

const ocrRouter = {
  performOcr,
  performOcrBlocks,
  performOcrWithEngine,
  getActiveEngine,
  resetEngine,
  getEngineConfig,
  getAvailableEngines: factory.getAvailableEngines,
  loadEngines: factory.loadEngines,
};

module.exports = { ocrRouter };
