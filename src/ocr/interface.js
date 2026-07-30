class OcrEngine {
  async init(config) {
    throw new Error('Not implemented');
  }

  async recognize(image) {
    throw new Error('Not implemented');
  }

  async recognizePage(image) {
    const blocks = await this.recognize(image);
    return blocks.map((b) => b.text).join('\n');
  }

  async recognizeBlocks(image) {
    const blocks = await this.recognize(image);
    return blocks.map((b) => ({
      text: b.text,
      confidence: b.confidence || 0,
      bbox: b.bbox || null,
      source: this.getMetadata().name || 'ocr',
    }));
  }

  getMetadata() {
    return { name: 'unknown', version: '0.0.0', lang: 'id' };
  }

  async destroy() {}
}

module.exports = { OcrEngine };
