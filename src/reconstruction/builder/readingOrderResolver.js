const logger = require('../../services/logger');

const readingOrderResolver = {
  resolve(blocks, options = {}) {
    if (!blocks || blocks.length === 0) return [];
    const pages = options.pages || [];
    const hasBBox = blocks.some(b => b.bbox);
    if (!hasBBox) return this._resolveByOrder(blocks);
    return this._resolveByPosition(blocks, pages);
  },

  _resolveByOrder(blocks) {
    return blocks
      .map((b, i) => ({ ...b, order: b.order != null ? b.order : i }))
      .sort((a, b) => a.order - b.order);
  },

  _resolveByPosition(blocks, pages) {
    const grouped = {};
    for (const b of blocks) {
      const p = b.page || 0;
      if (!grouped[p]) grouped[p] = [];
      grouped[p].push(b);
    }
    const result = [];
    const pageKeys = Object.keys(grouped).sort((a, b) => parseInt(a) - parseInt(b));
    for (const pKey of pageKeys) {
      const pageBlocks = grouped[pKey];
      const sorted = this._sortPageBlocks(pageBlocks);
      result.push(...sorted);
    }
    return result.map((b, i) => ({ ...b, order: b.order != null ? b.order : i }));
  },

  _sortPageBlocks(blocks) {
    const sorted = blocks
      .map(b => ({
        ...b,
        centerY: b.bbox ? b.bbox.y + b.bbox.h / 2 : 0,
      }))
      .sort((a, b) => {
        const ydiff = a.centerY - b.centerY;
        if (Math.abs(ydiff) > 10) return ydiff;
        const ax = a.bbox ? a.bbox.x : 0;
        const bx = b.bbox ? b.bbox.x : 0;
        return ax - bx;
      });
    return sorted.map(({ centerY, ...b }) => b);
  },

  _isSameLine(a, b, threshold = 15) {
    if (!a.bbox || !b.bbox) return false;
    const ay = a.bbox.y + a.bbox.h / 2;
    const by = b.bbox.y + b.bbox.h / 2;
    return Math.abs(ay - by) < threshold;
  },
};

module.exports = { readingOrderResolver };
