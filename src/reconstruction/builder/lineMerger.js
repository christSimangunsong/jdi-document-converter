const { Line, Block } = require('../models/documentModel');

const lineMerger = {
  merge(blocks, options = {}) {
    if (!blocks || blocks.length === 0) return [];
    const threshold = options.sameLineThreshold != null ? options.sameLineThreshold : 12;
    const groups = [];
    let currentGroup = [blocks[0]];
    for (let i = 1; i < blocks.length; i++) {
      const prev = blocks[i - 1];
      const curr = blocks[i];
      const sameLine = this._isSameLine(prev, curr, threshold);
      const samePage = (prev.page || 0) === (curr.page || 0);
      if (sameLine && samePage) {
        currentGroup.push(curr);
      } else {
        groups.push(currentGroup);
        currentGroup = [curr];
      }
    }
    if (currentGroup.length > 0) groups.push(currentGroup);
    return groups.map((g, i) => this._toLine(g, i));
  },

  _isSameLine(a, b, threshold) {
    if (a.bbox && b.bbox) {
      const ay = a.bbox.y + a.bbox.h / 2;
      const by = b.bbox.y + b.bbox.h / 2;
      return Math.abs(ay - by) < threshold;
    }
    return false;
  },

  _toLine(blocks, index) {
    const mergedText = blocks
      .map(b => b.text || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const firstBlock = blocks[0];
    let bbox = null;
    if (firstBlock && firstBlock.bbox && blocks.length > 1) {
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock.bbox) {
        bbox = {
          x: firstBlock.bbox.x,
          y: firstBlock.bbox.y,
          w: (lastBlock.bbox.x + lastBlock.bbox.w) - firstBlock.bbox.x,
          h: firstBlock.bbox.h,
        };
      }
    } else if (firstBlock && firstBlock.bbox) {
      bbox = { ...firstBlock.bbox };
    }

    const blockInstances = blocks.map(b => new Block({
      text: b.text, confidence: b.confidence, bbox: b.bbox,
      page: b.page, order: b.order, source: b.source,
    }));

    return new Line({
      blocks: blockInstances,
      text: mergedText,
      bbox,
      page: firstBlock ? firstBlock.page : 0,
      order: index,
    });
  },
};

module.exports = { lineMerger };
