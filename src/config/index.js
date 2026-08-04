const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const config = {
  outputDir: path.resolve(process.env.OUTPUT_DIR || './output'),
  logDir: path.resolve(process.env.LOG_DIR || './logs'),
  maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 3,
  retryDelayMs: parseInt(process.env.RETRY_DELAY_MS, 10) || 2000,
  downloadTimeout: parseInt(process.env.DOWNLOAD_TIMEOUT, 10) || 60000,
  ocrLang: process.env.OCR_LANG || 'id',
  pdfRenderScale: parseFloat(process.env.PDF_RENDER_SCALE) || 2.0,
  linksPath: path.resolve('./data/links.json'),
  structureServiceUrl: process.env.STRUCTURE_SERVICE_URL || '',
  sidecarTimeout: parseInt(process.env.SIDECAR_TIMEOUT, 10) || 120000,
  ocr: {
    engine: process.env.OCR_ENGINE || 'paddle',
    preprocess: process.env.OCR_PREPROCESS === 'true' || process.env.OCR_PREPROCESS === '1',
    preprocessSteps: process.env.OCR_PREPROCESS_STEPS || 'grayscale,denoise,threshold',
    minimumConfidence: parseFloat(process.env.OCR_MIN_CONFIDENCE) || 0.3,
    lang: process.env.OCR_LANG || 'id',
    engineFallback: process.env.OCR_ENGINE_FALLBACK !== 'false' && process.env.OCR_ENGINE_FALLBACK !== '0',
    qualityGate: process.env.OCR_QUALITY_GATE !== 'false' && process.env.OCR_QUALITY_GATE !== '0',
    minWordCount: parseInt(process.env.OCR_MIN_WORD_COUNT, 10) || 5,
    maxGarbageRatio: parseFloat(process.env.OCR_MAX_GARBAGE_RATIO) || 0.4,
    maxConfidenceRetries: parseInt(process.env.OCR_MAX_CONFIDENCE_RETRIES, 10) || 2,
  },
  db: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    name: process.env.DB_NAME || 'jdi_document_converter',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
  },
  reconstruction: {
    enabled: process.env.RECONSTRUCTION_ENABLED === 'true' || process.env.RECONSTRUCTION_ENABLED === '1',
    debug: process.env.RECONSTRUCTION_DEBUG === 'true' || process.env.RECONSTRUCTION_DEBUG === '1',
    debugDir: path.resolve(process.env.RECONSTRUCTION_DEBUG_DIR || './debug'),
    chunkSize: parseInt(process.env.RECONSTRUCTION_CHUNK_SIZE, 10) || 1000,
    chunkOverlap: parseInt(process.env.RECONSTRUCTION_CHUNK_OVERLAP, 10) || 200,
    outputFormat: process.env.RECONSTRUCTION_OUTPUT_FORMAT || 'markdown',
  },
  projection: {
    minRatio: parseFloat(process.env.PROJECTION_MIN_RATIO) || 1.8,
    ambiguousThreshold: parseFloat(process.env.PROJECTION_AMBIGUOUS_THRESHOLD) || 0.65,
  },
  osd: {
    enabled: process.env.OSD_ENABLED !== 'false' && process.env.OSD_ENABLED !== '0',
    minConfidence: parseFloat(process.env.OSD_MIN_CONFIDENCE) || 8,
    timeout: parseInt(process.env.OSD_TIMEOUT, 10) || 5000,
  },
  deskew: {
    engine: process.env.DESKEW_ENGINE || 'auto',
    serviceUrl:
      process.env.DESKEW_SERVICE_URL || process.env.STRUCTURE_SERVICE_URL
        ? process.env.STRUCTURE_SERVICE_URL.replace(':5000', ':5002')
        : '',
    minConfidence: parseFloat(process.env.DESKEW_MIN_CONFIDENCE) || 0.3,
    perspectiveCorrection: process.env.DESKEW_PERSPECTIVE === 'true' || process.env.DESKEW_PERSPECTIVE === '1',
    maxAngle: parseFloat(process.env.DESKEW_MAX_ANGLE) || 15,
  },
  perspective: {
    enabled: process.env.PERSPECTIVE_ENABLED === 'true' || process.env.PERSPECTIVE_ENABLED === '1',
    minArea: parseFloat(process.env.PERSPECTIVE_MIN_AREA) || 0.2,
  },
  table: {
    detect: process.env.TABLE_DETECT !== 'false' && process.env.TABLE_DETECT !== '0',
    preserveGrid: process.env.TABLE_PRESERVE_GRID !== 'false' && process.env.TABLE_PRESERVE_GRID !== '0',
    splitCells: process.env.TABLE_SPLIT_CELLS !== 'false' && process.env.TABLE_SPLIT_CELLS !== '0',
    renderScale: parseFloat(process.env.TABLE_RENDER_SCALE) || 3.0,
  },
  tableAware: {
    enabled: process.env.TABLE_AWARE_ENABLED === 'true' || process.env.TABLE_AWARE_ENABLED === '1',
    serviceUrl: process.env.TABLE_AWARE_SERVICE_URL || '',
    timeout: parseInt(process.env.TABLE_AWARE_TIMEOUT, 10) || 1800000,
  },
  sidecar: {
    autostart: process.env.SIDECAR_AUTOSTART !== 'false' && process.env.SIDECAR_AUTOSTART !== '0',
    pythonBin: process.env.PYTHON_BIN || 'python',
  },
  review: {
    enabled: process.env.REVIEW_ENABLED !== 'false' && process.env.REVIEW_ENABLED !== '0',
    maxIssues: parseInt(process.env.REVIEW_MAX_ISSUES, 10) || 50,
  },
  outputCleanup: {
    maxAgeDays: parseInt(process.env.OUTPUT_CLEANUP_MAX_AGE_DAYS, 10) || 30,
    intervalMs: parseInt(process.env.OUTPUT_CLEANUP_INTERVAL_MS, 10) || 6 * 60 * 60 * 1000,
  },
};

module.exports = config;
