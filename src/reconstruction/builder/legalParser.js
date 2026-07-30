const logger = require('../../services/logger');

const LEGAL_PATTERNS = {
  UNDANG_UNDANG: /^UNDANG-UNDANG\s+(REPUBLIK\s+)?INDONESIA/i,
  PERATURAN: /^PERATURAN\s+(PRESIDEN|GUBERNUR|BUPATI|WALIKOT|MENTERI|DAERAH|PEMERINTAH)/i,
  PERPU: /^PERATURAN\s+ PEMERINTAH\s+PENGGANTI\s+UNDANG-UNDANG/i,
  KEPUTUSAN: /^KEPUTUSAN\s+(PRESIDEN|GUBERNUR|BUPATI|WALIKOT|MENTERI|KEPALA)/i,
  INSTRUKSI: /^INSTRUKSI\s+(PRESIDEN|GUBERNUR|BUPATI|WALIKOT|MENTERI)/i,
  SURAT_EDARAN: /^SURAT\s+EDARAN/i,
  PENETAPAN: /^PENETAPAN\s+(PRESIDEN|GUBERNUR|BUPATI|WALIKOT|MENTERI)/i,
  PERDES: /^PERATURAN\s+DESA/i,
  PERKADES: /^PERATURAN\s+KEPALA\s+DESA/i,
};

const DOCUMENT_TYPE_ORDER = [
  'UNDANG_UNDANG', 'PERPU', 'PERATURAN', 'KEPUTUSAN', 'INSTRUKSI',
  'SURAT_EDARAN', 'PENETAPAN', 'PERDES', 'PERKADES',
];

const MENIMBANG = /^Menimbang\s*:/i;
const MENGINGAT = /^Mengingat\s*:/i;
const MEMUTUSKAN = /^MEMUTUSKAN\s*:/i;
const MENETAPKAN = /^Menetapkan\s*:/i;
const DENGAN = /^DENGAN\s+(PERSETUJUAN|PERTIMBANGAN|RESTU)/i;

const legalParser = {
  parse(root) {
    if (!root || !root.children) return root;
    const types = this._detectDocumentTypes(root);
    root.metadata = root.metadata || {};
    root.metadata.documentTypes = types;
    this._tagLegalComponents(root);
    this._inferStructure(root);
    return root;
  },

  _detectDocumentTypes(root) {
    const types = [];
    const allText = this._collectText(root).join('\n');
    for (const [name, pattern] of Object.entries(LEGAL_PATTERNS)) {
      if (pattern.test(allText)) {
        types.push(name);
      }
    }
    return types;
  },

  _collectText(node) {
    const texts = [];
    if (node.text) texts.push(node.text);
    if (node.children) {
      for (const c of node.children) texts.push(...this._collectText(c));
    }
    return texts;
  },

  _tagLegalComponents(root) {
    this._walk(root, (node) => {
      if (!node.text) return;
      if (MENIMBANG.test(node.text)) {
        node.metadata = node.metadata || {};
        node.metadata.legalComponent = 'menimbang';
        node.type = 'menimbang';
      }
      if (MENGINGAT.test(node.text)) {
        node.metadata = node.metadata || {};
        node.metadata.legalComponent = 'mengingat';
        node.type = 'mengingat';
      }
      if (MEMUTUSKAN.test(node.text)) {
        node.metadata = node.metadata || {};
        node.metadata.legalComponent = 'memutuskan';
        node.type = 'memutuskan';
      }
      if (MENETAPKAN.test(node.text)) {
        node.metadata = node.metadata || {};
        node.metadata.legalComponent = 'menetapkan';
        node.type = 'menetapkan';
      }
    });
  },

  _inferStructure(root) {
    let pasalCounter = 0;
    let hasBab = root.children.some(c => c.type === 'bab');
    this._walk(root, (node) => {
      if (node.type === 'pasal' && node.number) {
        pasalCounter++;
      }
      if (node.type === 'bab' && hasBab) {
        node.level = 1;
      }
    });
    root.metadata.pasalCount = pasalCounter;
  },

  _walk(node, fn) {
    fn(node);
    if (node.children) {
      for (const c of node.children) this._walk(c, fn);
    }
  },
};

module.exports = { legalParser };
