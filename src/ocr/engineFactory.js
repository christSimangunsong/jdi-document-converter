const logger = require('../services/logger');

const ENGINE_REGISTRY = {};

function registerEngine(name, engineClass) {
  ENGINE_REGISTRY[name] = engineClass;
}

function getAvailableEngines() {
  return Object.keys(ENGINE_REGISTRY);
}

async function createEngine(name, config) {
  const EngineClass = ENGINE_REGISTRY[name];
  if (!EngineClass) {
    throw new Error(`Engine tidak dikenal: "${name}". Tersedia: ${getAvailableEngines().join(', ')}`);
  }

  const engine = new EngineClass();
  await engine.init(config);
  return engine;
}

async function resolveEngine(ocrConfig) {
  const preferred = ocrConfig.engine || 'paddle';

  if (preferred === 'auto') {
    return resolveAuto(ocrConfig);
  }

  if (!ENGINE_REGISTRY[preferred]) {
    logger.warn(`Engine "${preferred}" tidak tersedia, fallback ke "paddle"`);
    return createEngine('paddle', ocrConfig);
  }

  return createEngine(preferred, ocrConfig);
}

async function resolveAuto(ocrConfig) {
  const order = ['surya', 'tesseract', 'paddle'];

  for (const name of order) {
    if (!ENGINE_REGISTRY[name]) continue;
    try {
      const engine = await createEngine(name, ocrConfig);
      logger.info(`  Auto-select: "${name}" — sidecar reachable, menggunakan engine ini`);
      return engine;
    } catch (err) {
      logger.warn(`  Auto-select: "${name}" tidak tersedia (${err.message}), coba berikutnya...`);
    }
  }

  logger.info('  Auto-select: fallback ke "paddle" (local, tanpa sidecar)');
  return createEngine('paddle', ocrConfig);
}

async function loadEngines(names, configs) {
  const engines = [];
  for (const name of names) {
    try {
      const eng = await createEngine(name, configs[name] || configs);
      engines.push(eng);
    } catch (err) {
      logger.warn(`  Gagal memuat engine "${name}": ${err.message}`);
    }
  }
  return engines;
}

module.exports = {
  registerEngine,
  getAvailableEngines,
  createEngine,
  resolveEngine,
  loadEngines,
};
