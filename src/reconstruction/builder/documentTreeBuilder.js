const logger = require('../../services/logger');
const { DocumentNode, Table } = require('../models/documentModel');
const { detectTableFromLines } = require('../../ocr/tableDetector');
const { cleanLineText } = require('../../utils/garbageTokens');

const HEADING_PATTERNS = {
  BAB: /^BAB\s+([IVXLCDM]+|[0-9]+)/i,
  BAGIAN:
    /^BAGIAN\s+(PERTAMA|KEDUA|KETIGA|KEEMPAT|KELIMA|KEENAM|KETUJUH|KEDELAPAN|KESEMBILAN|KESEPULUH|[I VXLCDM]+|[0-9]+)/i,
  PARAGRAF: /^(\u00a7\s*|Paragraf\s+)([0-9]+|[IVXLCDM]+)/i,
  PASAL: /^Pasal\s+([0-9]+|[IVXLCDM]+)/i,
  LAMPIRAN: /^Lampiran\s+([IVXLCDM]+|[0-9]+)/i,
  BAB_BAGIAN: /^(BAB|BAGIAN|PARAGRAF)\s+/i,
  PASAL_REGEX: /^Pasal\s+\d+/i,
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

    const paragraphs = this._groupIntoParagraphs(lines, tableLineIdx);
    const groups = this._detectTables(paragraphs);
    for (const tr of tableResults) {
      const tableNode = new Table({
        headers: (tr.table.headers || []).map((c) => cleanLineText(c)),
        rows: (tr.table.rows || []).map((r) => r.map((c) => cleanLineText(c))),
      });
      groups.push({ type: 'table', content: tableNode, pos: tr.startIdx });
    }
    groups.sort((a, b) => this._groupPos(a) - this._groupPos(b));

    const root = this._buildStructure(groups, { lang, debug });
    if (debug) logger.info(`  Pohon dokumen: ${this._countNodes(root)} node`);
    return root;
  },

  _groupPos(group) {
    return group.pos != null ? group.pos : Number.MAX_SAFE_INTEGER;
  },

  _emptyRoot() {
    return new DocumentNode({ type: 'root', title: 'root', children: [] });
  },

  _groupIntoParagraphs(lines, skipIdx) {
    const paragraphs = [];
    let current = [];
    let startIdx = -1;
    let prevPage = null;
    const flush = () => {
      if (current.length > 0) {
        current._startIdx = startIdx;
        paragraphs.push(current);
        current = [];
      }
    };
    for (let i = 0; i < lines.length; i++) {
      if (skipIdx && skipIdx.has(i)) {
        flush();
        prevPage = null;
        continue;
      }
      const line = lines[i];
      const text = (line.text || '').trim();
      if (!text) {
        flush();
        prevPage = null;
        continue;
      }
      const page = line.page || 0;
      if (prevPage != null && page !== prevPage) flush();
      if (this._isHeading(text)) {
        flush();
        current = [line];
        startIdx = i;
        prevPage = page;
        flush();
        continue;
      }
      if (/^\(\d+\)\s+|^[a-z][.)]\s+/i.test(text)) {
        flush();
        current = [line];
        startIdx = i;
        prevPage = page;
        flush();
        continue;
      }
      if (current.length === 0) startIdx = i;
      current.push(line);
      prevPage = page;
    }
    flush();
    return paragraphs;
  },

  _isHeading(text) {
    return Object.values(HEADING_PATTERNS).some((p) => p.test(text));
  },

  _detectTables(paragraphs) {
    const groups = [];
    let inTable = false;
    let tableBuffer = [];
    let tableStartIdx = -1;
    for (const para of paragraphs) {
      const firstText = para[0] ? (para[0].text || '').trim() : '';
      const isTableLine = TABLE_ROW_PATTERN.test(firstText) || TABLE_SEP_PATTERN.test(firstText);
      const looksLikeTable =
        firstText.length > 20 && (firstText.includes('|') || firstText.includes('+') || firstText.includes('\t'));

      if (isTableLine || looksLikeTable) {
        if (tableBuffer.length === 0) tableStartIdx = para._startIdx;
        tableBuffer.push(para);
        inTable = true;
      } else {
        if (inTable && tableBuffer.length > 0) {
          groups.push({ type: 'table', content: tableBuffer.splice(0), pos: tableStartIdx });
          inTable = false;
        }
        groups.push({ type: 'paragraph', content: para, pos: para._startIdx });
      }
    }
    if (inTable && tableBuffer.length > 0) {
      groups.push({ type: 'table', content: tableBuffer, pos: tableStartIdx });
    }
    return groups;
  },

  _buildStructure(groups) {
    const root = new DocumentNode({ type: 'root', title: 'root', level: 0 });
    const stack = [root];

    for (const group of groups) {
      if (group.type === 'table') {
        const table = this._parseTable(group.content);
        if (table) root.children.push(table);
        continue;
      }

      const node = this._classifyParagraph(group.content);
      if (!node) continue;

      if (node.type === 'bab' || node.type === 'bagian' || node.type === 'paragraf' || node.type === 'lampiran') {
        const level = node.level || 1;
        while (stack.length - 1 >= level) stack.pop();
        const parent = stack[stack.length - 1];
        parent.children.push(node);
        node.children = node.children || [];
        stack.push(node);
      } else {
        const parent = stack[stack.length - 1];
        parent.children.push(node);
        node.children = node.children || [];
        if (node.type === 'pasal') {
          while (stack[stack.length - 1].type === 'pasal') stack.pop();
          stack.push(node);
        }
      }
    }

    this._cleanupTree(root);
    return root;
  },

  _classifyParagraph(lines) {
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
    const titleMatch = text.match(/^(PERATURAN|KEPUTUSAN|UNDANG-UNDANG|INSTRUKSI|NOTA KESEPAHAMAN|MEMORANDUM)\b/i);
    if (titleMatch && (text.length >= 25 || /\b(NOMOR|TAHUN|TENTANG)\b/i.test(text))) {
      return this._createNode('title', text, lines, { level: 0, originalType: 'JUDUL' });
    }
    if (HEADING_PATTERNS.BAGIAN.test(text)) {
      return this._createNode('bagian', text, lines, { level: 2, originalType: 'BAGIAN' });
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
        level: 5,
        originalType: 'AYAT',
        number: parseInt(ayatMatch[1]),
        bbox: firstLine.bbox,
        page,
      });
    }
    const hurufMatch = text.match(/^([a-z])[.)]\s*(.+)/i);
    if (hurufMatch && text.length < 100) {
      return this._createNode('huruf', hurufMatch[2].trim(), lines, {
        level: 6,
        originalType: 'HURUF',
        number: hurufMatch[1],
        bbox: firstLine.bbox,
        page,
      });
    }
    const angkaMatch = text.match(/^(\d+)[.)]\s*(.+)/);
    if (angkaMatch && text.length < 100) {
      return this._createNode('angka', angkaMatch[2].trim(), lines, {
        level: 6,
        originalType: 'ANGKA',
        number: parseInt(angkaMatch[1]),
        bbox: firstLine.bbox,
        page,
      });
    }
    return this._createNode('paragraph', text, lines, { level: 6, bbox: firstLine.bbox, page });
  },

  _createNode(type, text, lines, extra = {}) {
    const fullText = lines
      .map((l, i) => {
        let t = (l.text || '').trim();
        if (i === 0 && type === 'ayat') t = t.replace(/^\(\d+\)\s*/, '');
        if (i === 0 && (type === 'huruf' || type === 'angka')) t = t.replace(/^[a-z0-9][.)]\s*/i, '');
        return t;
      })
      .filter((t) => t)
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
      for (const line of group.content || group) {
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
    // Perbaikan v29.1: teks tabel TIDAK lewat pipeline cleanLines (hanya
    // ctx.lines) — sel berisi garbage OCR/mirror ("1 1 T T 1 1") harus
    // dirapikan di sini sebelum dirender.
    const cleaned = rows.map((r) => r.map((c) => cleanLineText(c)));
    const headers = cleaned[0];
    const dataRows = cleaned.slice(1).filter((r) => r.length >= 1);
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
