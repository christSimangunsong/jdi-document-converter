const { v4: uuidv4 } = require('uuid');

class BBox {
  constructor(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
  }

  centerX() {
    return this.x + this.w / 2;
  }
  centerY() {
    return this.y + this.h / 2;
  }
  overlaps(other, threshold = 0.3) {
    const ix = Math.max(0, Math.min(this.x + this.w, other.x + other.w) - Math.max(this.x, other.x));
    const iy = Math.max(0, Math.min(this.y + this.h, other.y + other.h) - Math.max(this.y, other.y));
    const ia = ix * iy;
    const ua = this.w * this.h + other.w * other.h - ia;
    return ua > 0 && ia / ua > threshold;
  }
  toString() {
    return `[${this.x},${this.y},${this.w},${this.h}]`;
  }
}

class Block {
  constructor({ text, confidence, bbox, page, order, source }) {
    this.id = uuidv4();
    this.text = text || '';
    this.confidence = confidence || 0;
    this.bbox = bbox ? new BBox(bbox.x, bbox.y, bbox.w, bbox.h) : null;
    this.page = page || 0;
    this.order = order != null ? order : -1;
    this.source = source || 'ocr';
    this.type = 'block';
  }

  clone() {
    return new Block({
      text: this.text,
      confidence: this.confidence,
      bbox: this.bbox ? { x: this.bbox.x, y: this.bbox.y, w: this.bbox.w, h: this.bbox.h } : null,
      page: this.page,
      order: this.order,
      source: this.source,
    });
  }
}

class Line {
  constructor({ blocks, text, bbox, page, order }) {
    this.id = uuidv4();
    this.blocks = blocks || [];
    this.text = text || this.blocks.map((b) => b.text).join(' ');
    this.bbox = bbox || this._computeBBox();
    // v30 fix: pakai this.blocks (sudah defaulted), bukan param blocks —
    // param bisa undefined → "Cannot read properties of undefined ('0')"
    // saat Line dibuat tanpa page/blocks (mis. test, synthetic lines).
    this.page = page != null ? page : this.blocks[0] ? this.blocks[0].page : 0;
    this.order = order != null ? order : -1;
    this.type = 'line';
  }

  _computeBBox() {
    if (this.blocks.length === 0) return null;
    let x = Infinity,
      y = Infinity,
      x2 = 0,
      y2 = 0;
    for (const b of this.blocks) {
      if (b.bbox) {
        x = Math.min(x, b.bbox.x);
        y = Math.min(y, b.bbox.y);
        x2 = Math.max(x2, b.bbox.x + b.bbox.w);
        y2 = Math.max(y2, b.bbox.y + b.bbox.h);
      }
    }
    return x === Infinity ? null : new BBox(x, y, x2 - x, y2 - y);
  }
}

class Paragraph {
  constructor({ lines, text, bbox, page }) {
    this.id = uuidv4();
    this.lines = lines || [];
    this.text = text || this.lines.map((l) => l.text).join(' ');
    this.bbox = bbox || this._computeBBox();
    this.page = page != null ? page : lines[0] ? lines[0].page : 0;
    this.type = 'paragraph';
    this.children = [];
  }

  _computeBBox() {
    if (this.lines.length === 0) return null;
    let x = Infinity,
      y = Infinity,
      x2 = 0,
      y2 = 0;
    for (const l of this.lines) {
      if (l.bbox) {
        x = Math.min(x, l.bbox.x);
        y = Math.min(y, l.bbox.y);
        x2 = Math.max(x2, l.bbox.x + l.bbox.w);
        y2 = Math.max(y2, l.bbox.y + l.bbox.h);
      }
    }
    return x === Infinity ? null : new BBox(x, y, x2 - x, y2 - y);
  }
}

class Heading {
  constructor({ level, text, originalType, number, bbox, page, children }) {
    this.id = uuidv4();
    this.level = level || 1;
    this.text = text || '';
    this.originalType = originalType || null;
    this.number = number || null;
    this.bbox = bbox || null;
    this.page = page || 0;
    this.type = 'heading';
    this.children = children || [];
  }
}

class Table {
  constructor({ headers, rows, bbox, page }) {
    this.id = uuidv4();
    this.headers = headers || [];
    this.rows = rows || [];
    this.bbox = bbox || null;
    this.page = page || 0;
    this.type = 'table';
    this.children = [];
  }

  toMarkdown() {
    if (this.headers.length === 0 && this.rows.length === 0) return '';
    const lines = [];
    if (this.headers.length > 0) {
      lines.push('| ' + this.headers.join(' | ') + ' |');
      lines.push('| ' + this.headers.map(() => '---').join(' | ') + ' |');
    }
    for (const row of this.rows) {
      lines.push('| ' + row.join(' | ') + ' |');
    }
    return lines.join('\n');
  }
}

class ListItem {
  constructor({ level, number, text, marker, children }) {
    this.id = uuidv4();
    this.level = level || 0;
    this.number = number || null;
    this.text = text || '';
    this.marker = marker || '-';
    this.type = 'list_item';
    this.children = children || [];
  }
}

class Node {
  constructor({ type, text, number, level, children, metadata, bbox, page }) {
    this.id = uuidv4();
    this.type = type || 'section';
    this.text = text || '';
    this.number = number || null;
    this.level = level || 0;
    this.children = children || [];
    this.metadata = metadata || {};
    this.bbox = bbox || null;
    this.page = page || 0;
  }
}

class DocumentNode {
  constructor({ type, originalType, number, title, text, level, children, metadata, bbox, page }) {
    this.id = uuidv4();
    this.type = type || 'section';
    this.originalType = originalType || null;
    this.number = number || null;
    this.title = title || '';
    this.text = text || '';
    this.level = level || 0;
    this.children = children || [];
    this.metadata = metadata || {};
    this.bbox = bbox || null;
    this.page = page || 0;
  }

  toJSON() {
    return {
      type: this.type,
      originalType: this.originalType,
      number: this.number,
      title: this.title,
      text: this.text,
      level: this.level,
      children: this.children.map((c) => (c.toJSON ? c.toJSON() : c)),
      metadata: this.metadata,
    };
  }

  flatten() {
    const result = [this];
    for (const c of this.children) {
      result.push(...(c.flatten ? c.flatten() : [c]));
    }
    return result;
  }
}

class Document {
  constructor({ title, pages, metadata, sections, markdown, html, json, chunks, embedding, review }) {
    this.title = title || '';
    this.pages = pages || 0;
    this.metadata = metadata || {};
    this.sections = sections || [];
    this.root = null;
    this.markdown = markdown || '';
    this.html = html || '';
    this.semanticJson = json || null;
    this.chunks = chunks || [];
    this.embedding = embedding || null;
    this.review = review || null;
  }

  toJSON() {
    return {
      title: this.title,
      pages: this.pages,
      metadata: this.metadata,
      sections: this.sections.map((s) => (s.toJSON ? s.toJSON() : s)),
      markdown: this.markdown,
      semanticJson: this.semanticJson,
      chunks: this.chunks,
      review: this.review,
    };
  }
}

const LEGAL_TYPES = {
  BAB: { level: 1, label: 'Bab' },
  BAGIAN: { level: 2, label: 'Bagian' },
  PARAGRAF: { level: 3, label: 'Paragraf' },
  PASAL: { level: 4, label: 'Pasal' },
  AYAT: { level: 5, label: 'Ayat' },
  HURUF: { level: 6, label: 'Huruf' },
  ANGKA: { level: 6, label: 'Angka' },
  LAMPIRAN: { level: 1, label: 'Lampiran' },
};

module.exports = {
  BBox,
  Block,
  Line,
  Paragraph,
  Heading,
  Table,
  ListItem,
  Node,
  DocumentNode,
  Document,
  LEGAL_TYPES,
};
