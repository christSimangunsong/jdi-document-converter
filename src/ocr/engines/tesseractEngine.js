const { OcrEngine } = require('../interface');
const logger = require('../../services/logger');

class TesseractEngine extends OcrEngine {
  constructor() {
    super();
    this._worker = null;
    this._lang = 'ind';
  }

  async init(config) {
    logger.info('  Menginisialisasi Tesseract.js...');
    const Tesseract = await import('tesseract.js');

    this._lang = (config && config.lang) || 'ind';
    const workerPath = config && config.workerPath;

    this._worker = await Tesseract.createWorker(this._lang, 1, {
      workerPath,
      logger: (m) => {
        if (m.status === 'recognizing text') {
          logger.info(`    Tesseract: ${Math.round(m.progress * 100)}%`);
        }
      },
    });

    await this._worker.setParameters({
      tessedit_char_whitelist: config && config.charWhitelist ? config.charWhitelist : '',
      preserve_interword_spaces: '1',
    });

    logger.info('  Tesseract.js siap digunakan');
  }

  async recognize(image) {
    if (!this._worker) throw new Error('TesseractEngine belum diinisialisasi');

    const buf = typeof image.toBuffer === 'function' ? image.toBuffer('image/png') : image;

    const { data } = await this._worker.recognize(buf);

    const lines = [];
    if (data.words) {
      for (const word of data.words) {
        lines.push({
          text: word.text,
          confidence: word.confidence / 100,
          bbox: word.bbox || null,
        });
      }
    }

    if (lines.length === 0 && data.text) {
      lines.push({ text: data.text, confidence: data.confidence / 100 || 0, bbox: null });
    }

    return lines;
  }

  async recognizePage(image) {
    if (!this._worker) throw new Error('TesseractEngine belum diinisialisasi');

    const buf = typeof image.toBuffer === 'function' ? image.toBuffer('image/png') : image;

    const { data } = await this._worker.recognize(buf);
    return data.text || '';
  }

  getMetadata() {
    return {
      name: 'tesseract',
      version: '5.x',
      lang: this._lang,
      type: 'tesseract.js',
    };
  }

  async destroy() {
    if (this._worker) {
      try {
        await this._worker.terminate();
      } catch (_) {
        /* abaikan error saat menutup worker */
      }
      this._worker = null;
    }
  }
}

module.exports = { TesseractEngine };
