const { OcrEngine } = require('../interface');
const logger = require('../../services/logger');

class SuryaEngine extends OcrEngine {
  constructor() {
    super();
    this._url = '';
    this._timeout = 120000;
  }

  async init(config) {
    this._url = (config && config.serviceUrl) || 'http://localhost:5001';
    this._timeout = (config && config.timeout) || 120000;

    logger.info(`  Surya OCR sidecar: ${this._url}`);

    const ok = await this._healthCheck();
    if (!ok) {
      throw new Error(`Surya sidecar tidak reachable di ${this._url}`);
    }

    logger.info('  Surya OCR sidecar siap digunakan');
  }

  async recognize(image) {
    const result = await this._analyze([image]);
    if (result.length === 0) return [];
    return result[0].blocks || [];
  }

  async recognizePage(image) {
    const result = await this._analyze([image]);
    if (result.length === 0) return '';
    return result[0].text || '';
  }

  getMetadata() {
    return {
      name: 'surya',
      version: '0.4+',
      lang: 'id',
      type: 'surya-ocr (sidecar)',
    };
  }

  async destroy() {}

  async _analyze(images) {
    const base64Images = [];

    for (const img of images) {
      const isCanvas = typeof img.toBuffer === 'function';
      if (isCanvas) {
        const buf = img.toBuffer('image/png');
        base64Images.push(buf.toString('base64'));
      } else if (Buffer.isBuffer(img)) {
        base64Images.push(img.toString('base64'));
      } else if (typeof img === 'string') {
        base64Images.push(img);
      } else {
        base64Images.push('');
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeout);

    try {
      const response = await fetch(`${this._url}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: base64Images, lang: 'id' }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Surya sidecar error (${response.status}): ${errText}`);
      }

      const data = await response.json();
      return data.pages || [];
    } finally {
      clearTimeout(timer);
    }
  }

  async _healthCheck() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this._url}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }
}

module.exports = { SuryaEngine };
