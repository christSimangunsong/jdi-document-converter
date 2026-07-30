const logger = require('../../services/logger');
const { DocumentNode, Table, Heading, Paragraph, ListItem } = require('../models/documentModel');
const { detectTableFromLines } = require('../../ocr/tableDetector');

const HEADING_PATTERNS = {
  'BAB': /^BAB\s+([IVXLCDM]+|[0-9]+)/i,
  'BAGIAN': /^BAGIAN\s+(PERTAMA|KEDUA|KETIGA|KEEMPAT|KELIMA|KEENAM|KETUJUH|KEDELAPAN|KESEMBILAN|KESEPULUH|[I VXLCDM]+|[0-9]+)/i,
  'PARAGRAF': /^(\u00a7\s*|Paragraf\s+)([0-9]+|[IVXLCDM]+)/i,
  'PASAL': /^Pasal\s+([0-9]+|[IVXLCDM]+)/i,
  'LAMPIRAN': /^Lampiran\s+([IVXLCDM]+|[0-9]+)/i,
  'BAB_BAGIAN': /^(BAB|BAGIAN|PARAGRAF)\s+/i,
  'PASAL_REGEX': /^Pasal\s+\d+/i,
};

const TABLE_ROW_PATTERN = /^[|+].*[|+]$/;
const TABLE_SEP_PATTERN = /^[|+][-+=:\s]+[|+]$/;

const documentTreeBuilder = {
  async build(lines, options = {}) {
    const lang = options.lang || 'id';
    const debug = options.debug || false;
    if (!lines || lines.length === 0) {
      return this._emptyRoot();
    }

    const tableResults = detectTableFromLines(lines);
    const tableLineIdx = new Set();
    for (const tr of tableResults) {
      for (let j = 0; j < tr.lines.length; j++) {
        tableLineIdx.add(tr.startIdx + j);
      }
    }
    const textLines = lines.filter((_, i) => !tableLineIdx.has(i));

    const paragraphs = this._groupIntoParagraphs(textLines);
    const groups = this._detectTables(paragraphs);
    for (const tr of tableResults) {
      const tableNode = new Table({ headers: tr.table.headers, rows: tr.table.rows });
      groups.push({ type: 'table', content: tableNode });
    }

    const root = this._buildStructure(groups, { lang, debug });
    if (debug) logger.info(`  Pohon dokumen: ${this._countNodes(root)} node`);
    return root;
  },

  _emptyRoot() {
    return new DocumentNode({ type: 'root', title: 'root', children: [] });
  },

  _groupIntoParagraphs(lines) {
    const paragraphs = [];
    let current = [];
    for (const line of lines) {
      const text = (line.text || '').trim();
      if (!text) {
        if (current.length > 0) {
          paragraphs.push(current);
          current = [];
        }
        continue;
      }
      if (this._isHeading(text)) {
        if (current.length > 0) paragraphs.push(current);
        current = [line];
        paragraphs.push(current);
        current = [];
        continue;
      }
      current.push(line);
    }
    if (current.length > 0) paragraphs.push(current);
    return paragraphs;
  },

  _isHeading(text) {
    return Object.values(HEADING_PATTERNS).some(p => p.test(text));
  },

  _detectTables(paragraphs) {
    const groups = [];
    let inTable = false;
    let tableBuffer = [];
    for (const para of paragraphs) {
      const firstText = para[0] ? (para[0].text || '').trim() : '';
      const isTableLine = TABLE_ROW_PATTERN.test(firstText) || TABLE_SEP_PATTERN.test(firstText);
      const looksLikeTable = firstText.length > 20 &&
        (firstText.includes('|') || firstText.includes('+') || firstText.includes('\t'));

      if (isTableLine || looksLikeTable) {
        tableBuffer.push(para);
        inTable = true;
      } else {
        if (inTable && tableBuffer.length > 0) {
          groups.push({ type: 'table', content: tableBuffer.splice(0) });
          inTable = false;
        }
        groups.push({ type: 'paragraph', content: para });
      }
    }
    if (inTable && tableBuffer.length > 0) {
      groups.push({ type: 'table', content: tableBuffer });
    }
    return groups;
  },

  _buildStructure(groups, options) {
    const root = new DocumentNode({ type: 'root', title: 'root', level: 0 });
    const stack = [root];
    let sectionCounters = { bab: 0, pasal: 0 };

    for (const group of groups) {
      if (group.type === 'table') {
        const table = this._parseTable(group.content);
        if (table) root.children.push(table);
        continue;
      }

      const node = this._classifyParagraph(group.content, options, stack);
      if (!node) continue;

      if (node.type === 'heading' && node.originalType) {
        const level = node.level || 1;
        while (stack.length > level) stack.pop();
        const parent = stack[stack.length - 1];
        parent.children.push(node);
        node.children = node.children || [];
        stack.push(node);
      } else {
        const parent = stack[stack.length - 1];
        parent.children.push(node);
        node.children = node.children || [];
        if (node.type === 'pasal') stack.push(node);
      }
    }

    this._cleanupTree(root);
    return root;
  },

  _classifyParagraph(lines, options, stack) {
    const firstLine = lines[0];
    if (!firstLine) return null;
    const text = (firstLine.text || '').trim();
    const page = firstLine.page || 0;

    if (HEADING_PATTERNS.BAB.test(text)) {
      return this._createNode('bab', text, lines, { level: 1, originalType: 'BAB' });
    }
    if (HEADING_PATTERNS.LAMPIRAN.test(text)) {
      return this._createNode('lampiran', text, lines, { level: 1, originalType: 'LAMPIRAN' });
    }
    if (HEADING_PATTERNS.BAGIAN.test(text)) {
      return this._createNode('bagian', text, lines, {
        level: stack.length >= 2 ? 3 : 2, originalType: 'BAGIAN',
      });
    }
    if (HEADING_PATTERNS.PARAGRAF.test(text)) {
      return this._createNode('paragraf', text, lines, { level: 3, originalType: 'PARAGRAF' });
    }
    if (HEADING_PATTERNS.PASAL.test(text)) {
      return this._createNode('pasal', text, lines, { level: 4, originalType: 'PASAL' });
    }
    const ayatMatch = text.match(/^\((\d+)\)\s*(.+)/);
    if (ayatMatch) {
      return this._createNode('ayat', ayatMatch[2].trim(), lines, {
        level: 5, originalType: 'AYAT', number: parseInt(ayatMatch[1]), bbox: firstLine.bbox, page,
      });
    }
    const hurufMatch = text.match(/^([a-z])[\.\)]\s*(.+)/i);
    if (hurufMatch && text.length < 100) {
      return this._createNode('huruf', hurufMatch[2].trim(), lines, {
        level: 6, originalType: 'HURUF', number: hurufMatch[1], bbox: firstLine.bbox, page,
      });
    }
    const angkaMatch = text.match(/^(\d+)[\.\)]\s*(.+)/);
    if (angkaMatch && text.length < 100) {
      return this._createNode('angka', angkaMatch[2].trim(), lines, {
        level: 6, originalType: 'ANGKA', number: parseInt(angkaMatch[1]), bbox: firstLine.bbox, page,
      });
    }
    return this._createNode('paragraph', text, lines, { level: 6, bbox: firstLine.bbox, page });
  },

  _createNode(type, text, lines, extra = {}) {
    const fullText = lines
      .map(l => (l.text || '').trim())
      .filter(t => t)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const number = (() => {
      let num = null;
      if (type === 'bab') {
        const m = text.match(HEADING_PATTERNS.BAB);
        if (m) num = m[1];
      }
      if (type === 'pasal') {
        const m = text.match(HEADING_PATTERNS.PASAL);
        if (m) num = m[1];
      }
      return num;
    })();

    return new DocumentNode({
      type,
      originalType: extra.originalType || null,
      number: extra.number || number,
      title: text,
      text: fullText,
      level: extra.level || 0,
      children: [],
      bbox: extra.bbox || null,
      page: extra.page || 0,
      metadata: {},
    });
  },

  _parseTable(groups) {
    const tableLines = [];
    for (const group of groups) {
      for (const line of (group.content || group)) {
        tableLines.push((line.text || '').trim());
      }
    }
    if (tableLines.length === 0) return null;
    const rows = [];
    for (const line of tableLines) {
      const clean = line.replace(/^[|+]\s*/, '').replace(/\s*[|+]$/, '');
      const cells = clean.split(/\s*[|+]\s*/);
      if (cells.length > 1 && !TABLE_SEP_PATTERN.test(line)) {
        rows.push(cells);
      }
    }
    if (rows.length === 0) return null;
    const headers = rows[0];
    const dataRows = rows.slice(1).filter(r => r.length >= 1);
    return new Table({ headers, rows: dataRows });
  },

  _cleanupTree(node) {
    if (!node || !node.children) return;
    const cleaned = [];
    let lastPasal = null;
    for (const child of node.children) {
      if (child.type === 'pasal') {
        lastPasal = child;
        cleaned.push(child);
      } else if (child.type === 'ayat' || child.type === 'huruf' || child.type === 'angka') {
        if (lastPasal) {
          lastPasal.children.push(child);
        } else {
          cleaned.push(child);
        }
      } else {
        cleaned.push(child);
      }
    }
    node.children = cleaned;
    for (const child of node.children) {
      this._cleanupTree(child);
    }
  },

  _countNodes(node) {
    let count = 1;
    if (node.children) {
      for (const c of node.children) count += this._countNodes(c);
    }
    return count;
  },
};

module.exports = { documentTreeBuilder };
