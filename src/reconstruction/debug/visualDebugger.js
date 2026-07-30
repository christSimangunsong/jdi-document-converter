const fs = require('fs');
const path = require('path');
const logger = require('../../services/logger');

const visualDebugger = {
  async generate(ctx, debugDir) {
    const dir = path.resolve(debugDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const baseName = `doc_${Date.now()}`;
    const files = [];

    if (ctx.ocrBlocks && ctx.ocrBlocks.length > 0) {
      const blocksJson = JSON.stringify(ctx.ocrBlocks.slice(0, 500), null, 2);
      fs.writeFileSync(path.join(dir, `${baseName}_blocks.json`), blocksJson, 'utf-8');
      files.push(`${baseName}_blocks.json`);
    }

    if (ctx.lines && ctx.lines.length > 0) {
      const linesData = ctx.lines.map(l => ({
        order: l.order,
        text: l.text,
        page: l.page,
        bbox: l.bbox ? { x: l.bbox.x, y: l.bbox.y, w: l.bbox.w, h: l.bbox.h } : null,
      }));
      fs.writeFileSync(path.join(dir, `${baseName}_lines.json`), JSON.stringify(linesData, null, 2), 'utf-8');
      files.push(`${baseName}_lines.json`);
    }

    if (ctx.tree) {
      const treeJson = JSON.stringify(ctx.tree.toJSON ? ctx.tree.toJSON() : ctx.tree, null, 2);
      fs.writeFileSync(path.join(dir, `${baseName}_tree.json`), treeJson, 'utf-8');
      files.push(`${baseName}_tree.json`);

      const treeHtml = this._treeToHtml(ctx.tree);
      fs.writeFileSync(path.join(dir, `${baseName}_tree.html`), treeHtml, 'utf-8');
      files.push(`${baseName}_tree.html`);
    }

    if (ctx.markdown) {
      fs.writeFileSync(path.join(dir, `${baseName}_output.md`), ctx.markdown, 'utf-8');
      files.push(`${baseName}_output.md`);
    }

    logger.info(`  Debug: ${files.join(', ')}`);
  },

  _treeToHtml(root) {
    const lines = [
      '<!DOCTYPE html><html lang="id"><head>',
      '<meta charset="UTF-8"><title>Debug Tree</title>',
      '<style>',
      'body { font-family: monospace; padding: 20px; }',
      '.node { margin: 2px 0; padding: 2px 0 2px 20px; border-left: 2px solid #ccc; }',
      '.bab { border-left-color: #e74c3c; }',
      '.pasal { border-left-color: #3498db; }',
      '.ayat { border-left-color: #2ecc71; }',
      '.meta { color: #888; font-size: 0.9em; }',
      '.text { color: #333; }',
      '</style></head><body>',
      '<h1>Document Tree</h1>',
    ];
    this._renderNodeHtml(root, lines, 0);
    lines.push('</body></html>');
    return lines.join('\n');
  },

  _renderNodeHtml(node, lines, depth) {
    if (!node) return;
    const cls = node.type || 'node';
    const text = (node.title || node.text || '').substring(0, 120);
    lines.push(
      `<div class="node ${cls}" style="margin-left:${depth * 20}px">`,
      `  <span class="meta">[${node.type}]${node.number ? ' #' + node.number : ''}</span>`,
      `  <span class="text">${this._esc(text)}</span>`,
      `</div>`
    );
    if (node.children) {
      for (const c of node.children) this._renderNodeHtml(c, lines, depth + 1);
    }
  },

  _esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },
};

module.exports = { visualDebugger };
