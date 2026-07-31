const { OcrEngine } = require('../interface');
const logger = require('../../services/logger');

class PaddleEngine extends OcrEngine {
  constructor() {
    super();
    this._instance = null;
    this._version = '6.2.0';
  }

  async init(config) {
    logger.info('  Menginisialisasi PaddleOCR (ppu-paddle-ocr)...');
    const { PaddleOcrService } = await import('ppu-paddle-ocr');

    this._instance = new PaddleOcrService({
      recognition: {
        minimumConfidence: (config && config.minimumConfidence) || 0.3,
      },
    });

    await this._instance.initialize();
    logger.info('  PaddleOCR siap digunakan');
  }

  async recognize(image) {
    if (!this._instance) throw new Error('PaddleEngine belum diinisialisasi');

    const output = await this._instance.recognize(image);
    return this._formatResult(output);
  }

  async recognizePage(image) {
    const blocks = await this.recognize(image);
    return blocks.map((b) => b.text).join('\n');
  }

  getMetadata() {
    return {
      name: 'paddle',
      version: this._version,
      lang: 'id',
      type: 'ppu-paddle-ocr',
    };
  }

  async destroy() {
    if (this._instance) {
      try {
        await this._instance.close();
      } catch (_) {
        /* abaikan error saat menutup instance */
      }
      this._instance = null;
    }
  }

  _formatResult(result) {
    if (!result || !result.text) return [];

    const lines = [];
    if (typeof result.text === 'string') {
      lines.push({ text: result.text, confidence: result.confidence || 0, bbox: null });
    } else if (Array.isArray(result.text)) {
      for (const item of result.text) {
        if (typeof item === 'string') {
          lines.push({ text: item, confidence: 0, bbox: null });
        } else if (item && item.text) {
          lines.push({
            text: item.text,
            confidence: item.confidence || 0,
            bbox: item.bbox || null,
          });
        }
      }
    }

    return lines;
  }
}

module.exports = { PaddleEngine };
