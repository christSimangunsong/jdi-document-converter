const config = require('../config');
const logger = require('../services/logger');
const factory = require('./engineFactory');
const { preprocessImage } = require('./preprocessor');
const { computeQualityScore, shouldAcceptPage } = require('./qualityMetrics');
const { repairTableBlocks } = require('./tableRegionOcr');
const { PaddleEngine } = require('./engines/paddleEngine');
const { TesseractEngine } = require('./engines/tesseractEngine');
const { SuryaEngine } = require('./engines/suryaEngine');

factory.registerEngine('paddle', PaddleEngine);
factory.registerEngine('tesseract', TesseractEngine);
factory.registerEngine('surya', SuryaEngine);

let _engineConfig = null;
let _engineCache = {};
let _preprocessedCache = [];

function getEngineConfig() {
  if (_engineConfig) return _engineConfig;

  const ocrCfg = config.ocr || {};
  _engineConfig = {
    engine: ocrCfg.engine || 'paddle',
    preprocess: ocrCfg.preprocess === true || ocrCfg.preprocess === 'true',
    preprocessSteps: ocrCfg.preprocessSteps ? ocrCfg.preprocessSteps.split(',') : ['grayscale', 'denoise', 'threshold'],
    minimumConfidence: ocrCfg.minimumConfidence || 0.3,
    lang: ocrCfg.lang || 'id',
    serviceUrl: config.structureServiceUrl || '',
    timeout: config.sidecarTimeout || 120000,
    engineFallback: ocrCfg.engineFallback !== false,
    qualityGate: ocrCfg.qualityGate !== false,
    maxRetries: ocrCfg.maxConfidenceRetries != null ? ocrCfg.maxConfidenceRetries : 2,
  };

  _engineConfig.serviceUrl = _engineConfig.serviceUrl || process.env.SURYA_SERVICE_URL || '';

  return _engineConfig;
}

function getEngineCandidates(preferred) {
  const available = factory.getAvailableEngines();
  const fallbackEnabled = config.ocr ? config.ocr.engineFallback !== false : true;

  let order;
  if (preferred === 'auto') {
    order = ['surya', 'tesseract', 'paddle'];
  } else {
    order = [preferred, ...available.filter((e) => e !== preferred)];
  }
  const candidates = order.filter((e) => available.includes(e));
  return fallbackEnabled ? candidates : candidates[0] ? [candidates[0]] : [];
}

async function getEngine(name, engCfg) {
  if (_engineCache[name]) return _engineCache[name];
  try {
    let engine;
    if (name === 'auto') {
      engine = await factory.resolveEngine(engCfg);
    } else {
      engine = await factory.createEngine(name, engCfg);
    }
    _engineCache[name] = engine;
    logger.info(`  OCR engine "${name}" siap`);
    return engine;
  } catch (err) {
    logger.warn(`  OCR engine "${name}" tidak bisa dibuat: ${err.message}`);
    return null;
  }
}

async function getActiveEngine() {
  const engCfg = getEngineConfig();
  const candidates = getEngineCandidates(engCfg.engine);
  for (const name of candidates) {
    const engine = await getEngine(name, engCfg);
    if (engine) return engine;
  }
  throw new Error('Tidak ada engine OCR yang tersedia');
}

async function resetEngine() {
  for (const name of Object.keys(_engineCache)) {
    try {
      await _engineCache[name].destroy();
    } catch (_) {
      /* abaikan error destroy engine */
    }
  }
  _engineCache = {};
}

function _stepsForRetry(engCfg, retry) {
  const base =
    engCfg.preprocessSteps && engCfg.preprocessSteps.length > 0
      ? engCfg.preprocessSteps.slice()
      : ['grayscale', 'threshold'];

  if (retry === 1) return [...base, 'upscale'];
  if (retry === 2) return [...base, 'upscale', 'denoise', 'perspective'];
  return base;
}

function _engineForRetry(engCfg, retry, maxRetries) {
  if (retry >= maxRetries && engCfg.engineFallback) return 'auto';
  return engCfg.engine;
}

function _getPageImage(imageBuffers, i, retry, engCfg) {
  if (!engCfg.preprocess || !imageBuffers[i]) return Promise.resolve(imageBuffers[i]);

  if (!_preprocessedCache[i]) _preprocessedCache[i] = [];
  if (_preprocessedCache[i][retry]) return Promise.resolve(_preprocessedCache[i][retry]);

  const steps = _stepsForRetry(engCfg, retry);
  const options = { steps };
  if (retry > 0) options.upscaleFactor = 1.5 * retry;

  return preprocessImage(imageBuffers[i], options).then((img) => {
    _preprocessedCache[i][retry] = img;
    return img;
  });
}

async function _recognizePageCascade(i, imageBuffers) {
  const engCfg = getEngineConfig();
  const maxRetries = engCfg.maxRetries;
  let bestScore = null;
  let bestBlocks = [];
  let bestText = '';
  let bestEngine = null;
  let bestRetry = 0;
  let lastError = null;

  for (let retry = 0; retry <= maxRetries; retry++) {
    const img = await _getPageImage(imageBuffers, i, retry, engCfg);
    for (const engineName of getEngineCandidates(_engineForRetry(engCfg, retry, maxRetries))) {
      try {
        const engine = await getEngine(engineName, engCfg);
        if (!engine) continue;
        const blocks = await engine.recognizeBlocks(img);
        const score = computeQualityScore(blocks);
        const text = blocks.map((b) => b.text).join('\n');

        if (!bestScore || score.score > bestScore.score) {
          bestScore = score;
          bestBlocks = blocks;
          bestText = text;
          bestEngine = engineName;
          bestRetry = retry;
        }

        if (shouldAcceptPage(score)) {
          return { score, blocks, text, engine: engineName, accepted: true };
        }
      } catch (error) {
        lastError = error;
        logger.warn(`  Halaman ${i + 1} engine "${engineName}" percobaan ${retry + 1} gagal: ${error.message}`);
      }
    }
    if (bestScore && shouldAcceptPage(bestScore)) break;
    if (retry < maxRetries) {
      logger.info(
        `  Halaman ${i + 1} kualitas rendah (score: ${bestScore ? bestScore.score.toFixed(2) : '0.00'}, words: ${bestScore ? bestScore.wordCount : 0}), retry ${retry + 1}/${maxRetries} dengan strategi alternatif...`,
      );
    }
  }

  if (bestEngine && _engineCache[bestEngine] && imageBuffers[i]) {
    try {
      const bestImg =
        _preprocessedCache[i] && _preprocessedCache[i][bestRetry]
          ? _preprocessedCache[i][bestRetry]
          : imageBuffers[i];
      const repair = await repairTableBlocks(bestImg, bestBlocks, _engineCache[bestEngine]);
      if (repair.replaced > 0) {
        const repairedScore = computeQualityScore(repair.blocks);
        if (!bestScore || repairedScore.score > bestScore.score) {
          logger.info(
            `  Halaman ${i + 1}: region repair tabel berhasil (${repair.replaced} blok baru, score ${bestScore ? bestScore.score.toFixed(2) : '0.00'} -> ${repairedScore.score.toFixed(2)})`,
          );
          bestScore = repairedScore;
          bestBlocks = repair.blocks;
          bestText = repair.blocks.map((b) => b.text).join('\n');
        }
      }
    } catch (err) {
      logger.warn(`  Region repair halaman ${i + 1} gagal: ${err.message}`);
    }
  }

  return {
    score: bestScore,
    blocks: bestBlocks,
    text: bestText,
    engine: bestEngine || engCfg.engine,
    accepted: !!(bestScore && shouldAcceptPage(bestScore)),
    lastError,
  };
}

async function performOcr(imageBuffers, onProgress) {
  const results = [];
  const engCfg = getEngineConfig();
  _preprocessedCache.length = 0;
  const pageQuality = [];

  for (let i = 0; i < imageBuffers.length; i++) {
    logger.info(`  OCR halaman ${i + 1}/${imageBuffers.length}...`);
    const outcome = await _recognizePageCascade(i, imageBuffers);
    const pageText = outcome.text || '';

    pageQuality.push({
      page: i + 1,
      accepted: outcome.accepted,
      lowQuality: engCfg.qualityGate && !outcome.accepted,
      score: outcome.score ? Number(outcome.score.score.toFixed(3)) : 0,
      confidence: outcome.score ? Number(outcome.score.confidence.toFixed(3)) : 0,
      garbageRatio: outcome.score ? Number(outcome.score.garbageRatio.toFixed(3)) : 1,
      wordCount: outcome.score ? outcome.score.wordCount : 0,
      engine: outcome.engine,
    });

    if (pageQuality[pageQuality.length - 1].lowQuality) {
      logger.warn(`  Halaman ${i + 1}: kualitas rendah — teks tetap dipakai tapi ditandai LOW QUALITY`);
    }

    results.push(pageText);

    if (onProgress) {
      onProgress(i + 1, imageBuffers.length);
    }
  }

  results.pageQuality = pageQuality;
  return results;
}

async function performOcrBlocks(imageBuffers, onProgress) {
  const results = [];
  const engCfg = getEngineConfig();
  _preprocessedCache.length = 0;
  const pageQuality = [];

  for (let i = 0; i < imageBuffers.length; i++) {
    logger.info(`  OCR blocks halaman ${i + 1}/${imageBuffers.length}...`);
    const outcome = await _recognizePageCascade(i, imageBuffers);
    let pageBlocks = outcome.blocks || [];

    pageQuality.push({
      page: i + 1,
      accepted: outcome.accepted,
      lowQuality: engCfg.qualityGate !== false && !outcome.accepted,
      score: outcome.score ? Number(outcome.score.score.toFixed(3)) : 0,
      confidence: outcome.score ? Number(outcome.score.confidence.toFixed(3)) : 0,
      garbageRatio: outcome.score ? Number(outcome.score.garbageRatio.toFixed(3)) : 1,
      wordCount: outcome.score ? outcome.score.wordCount : 0,
      engine: outcome.engine,
    });

    const low = engCfg.qualityGate && !outcome.accepted;
    if (low) {
      logger.warn(`  Halaman ${i + 1}: kualitas rendah — blok ditandai LOW QUALITY`);
      for (const b of pageBlocks) {
        b.quality = 'low';
      }
    }

    for (const b of pageBlocks) {
      b.page = i;
      b.order = results.length + (b.order || 0);
    }
    results.push(...pageBlocks);

    if (onProgress) onProgress(i + 1, imageBuffers.length);
  }

  results.pageQuality = pageQuality;
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
  getEngineCandidates,
  getAvailableEngines: factory.getAvailableEngines,
  loadEngines: factory.loadEngines,
};

module.exports = { ocrRouter };
