const logger = require('../../services/logger');

const textExtractor = {
  async extract(pdfBuffer) {
    const pdfParse = require('pdf-parse');
    // pdf-parse (pdf.js v1.10.100) gagal dengan Buffer — butuh Uint8Array
    const data = await pdfParse(new Uint8Array(pdfBuffer));
    const pages = this._splitPages(data.text || '', data.numpages || 1);
    return {
      pages,
      fullText: data.text || '',
      pageCount: data.numpages || 1,
      metadata: data.metadata || {},
    };
  },

  _splitPages(text, numPages) {
    if (!text || numPages <= 1) {
      return [{ pageNum: 1, text: text || '' }];
    }
    const pages = [];
    const formFeed = '\f';
    const parts = text.split(formFeed);
    for (let i = 0; i < numPages; i++) {
      pages.push({
        pageNum: i + 1,
        text: parts[i] || '',
      });
    }
    return pages;
  },
};

module.exports = { textExtractor };
