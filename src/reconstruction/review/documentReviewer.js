const config = require('../../config');
const logger = require('../../services/logger');

const ROMAN_VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

function _romanToInt(s) {
  if (!/^[IVXLCDM]+$/.test(s)) return null;
  let total = 0;
  let prev = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = ROMAN_VALUES[s[i]];
    if (v < prev) total -= v;
    else total += v;
    prev = v;
  }
  return total;
}

function _parseNum(num) {
  if (num == null) return null;
  if (typeof num === 'number') return num;
  const s = String(num).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return _romanToInt(s.toUpperCase());
}

const HEADING_TYPES = new Set(['bab', 'bagian', 'paragraf', 'pasal', 'lampiran']);

const documentReviewer = {
  review(ctx) {
    const issues = [];
    const maxIssues = config.review ? config.review.maxIssues : 50;
    const tree = ctx.tree;

    if (tree) {
      this._checkHeadingSequences(tree, issues);
      this._checkHeadingPlacement(tree, issues);
      this._checkTables(tree, issues);
      this._checkTitlePreamble(tree, issues);
    }
    this._checkPageOrder(ctx.lines || [], issues);
    this._checkOcrQuality(ctx, issues);

    issues.sort((a, b) => this._severityWeight(b.severity) - this._severityWeight(a.severity));
    const trimmed = issues.slice(0, maxIssues);
    const score = this._computeScore(trimmed);

    return { score, issueCount: trimmed.length, issues: trimmed };
  },

  _severityWeight(sev) {
    return sev === 'error' ? 3 : sev === 'warning' ? 2 : 1;
  },

  _computeScore(issues) {
    let weight = 0;
    for (const issue of issues) {
      weight += issue.severity === 'error' ? 0.25 : issue.severity === 'warning' ? 0.1 : 0.03;
    }
    return Number(Math.max(0, 1 - weight).toFixed(3));
  },

  _walk(node, cb, path = []) {
    if (!node) return;
    cb(node, path);
    for (const child of node.children || []) {
      this._walk(child, cb, [...path, node]);
    }
  },

  _issue(severity, type, message, page, path) {
    const last = path && path.length > 0 ? path[path.length - 1] : null;
    return { severity, type, message, page: page != null ? page : last ? last.page : null, path };
  },

  _checkHeadingSequences(tree, issues) {
    let babSeq = null;
    let babRaw = null;
    let pasalSeq = null;
    let pasalRaw = null;

    this._walk(tree, (node, path) => {
      if (node.type === 'bab') {
        const num = _parseNum(node.number);
        if (num != null) {
          if (babSeq != null && num < babSeq) {
            issues.push(
              this._issue(
                'warning',
                'bab-order',
                `Urutan BAB tidak naik: "${node.title || node.text}" setelah BAB ${babRaw}`,
                node.page,
              ),
            );
          }
          if (babSeq != null && num === babSeq) {
            issues.push(
              this._issue('warning', 'bab-duplicate', `BAB ${node.number} muncul lebih dari sekali`, node.page),
            );
          }
          babSeq = num;
          babRaw = node.number;
        }
        pasalSeq = null;
        pasalRaw = null;
      } else if (node.type === 'lampiran') {
        pasalSeq = null;
        pasalRaw = null;
      } else if (node.type === 'pasal') {
        const num = _parseNum(node.number);
        if (num != null) {
          if (pasalSeq != null && num < pasalSeq) {
            issues.push(
              this._issue(
                'error',
                'pasal-order',
                `Urutan Pasal tidak naik: "${node.title || node.text}" setelah Pasal ${pasalRaw}`,
                node.page,
              ),
            );
          }
          if (pasalSeq != null && num === pasalSeq) {
            issues.push(
              this._issue('warning', 'pasal-duplicate', `Pasal ${node.number} muncul lebih dari sekali`, node.page),
            );
          }
          pasalSeq = num;
          pasalRaw = node.number;
        }
      } else if (node.type === 'ayat') {
        const parentPasal = path
          .slice()
          .reverse()
          .find((p) => p.type === 'pasal');
        if (parentPasal) {
          const ayats = (parentPasal.children || []).filter((c) => c.type === 'ayat' && c.number != null);
          const nums = ayats.map((a) => _parseNum(a.number));
          for (let i = 1; i < nums.length; i++) {
            if (nums[i] <= nums[i - 1]) {
              issues.push(
                this._issue(
                  'warning',
                  'ayat-order',
                  `Ayat (${ayats[i].number}) di Pasal ${parentPasal.number} tidak berurutan (setelah ayat (${ayats[i - 1].number}))`,
                  ayats[i].page,
                ),
              );
            }
          }
          if (nums.length > 0 && nums[0] !== 1) {
            issues.push(
              this._issue(
                'info',
                'ayat-start',
                `Pasal ${parentPasal.number} dimulai dari ayat (${ayats[0].number}), bukan (1)`,
                ayats[0].page,
              ),
            );
          }
        }
      }
    });
  },

  _checkHeadingPlacement(tree, issues) {
    this._walk(tree, (node, path) => {
      if (node.type === 'ayat' && !path.some((p) => p.type === 'pasal')) {
        issues.push(
          this._issue('warning', 'orphan-ayat', `Ayat (${node.number}) tidak berada di dalam Pasal`, node.page),
        );
      }
      if ((node.type === 'huruf' || node.type === 'angka') && !path.some((p) => p.type === 'pasal')) {
        issues.push(
          this._issue(
            'info',
            'orphan-item',
            `Item "${node.title || node.text}" tidak berada di dalam Pasal`,
            node.page,
          ),
        );
      }
      if (!HEADING_TYPES.has(node.type)) return;
      if (node.type === 'pasal' && !path.some((p) => p.type === 'bab')) {
        issues.push(
          this._issue('warning', 'heading-parent', `Pasal ${node.number || ''} tidak berada di dalam BAB`, node.page),
        );
      }
      if ((node.type === 'bagian' || node.type === 'paragraf') && !path.some((p) => p.type === 'bab')) {
        issues.push(
          this._issue(
            'info',
            'heading-parent',
            `Heading "${node.title || node.text}" tidak berada di dalam BAB`,
            node.page,
          ),
        );
      }
    });
  },

  _checkTables(tree, issues) {
    const rootChildren = tree.children || [];
    this._walk(tree, (node, path) => {
      if (node.type !== 'table') return;
      if (!node.headers && (!node.rows || node.rows.length === 0)) {
        issues.push(this._issue('warning', 'table-empty', 'Tabel terdeteksi tanpa baris data', node.page));
      }
      if (path.length === 0 && rootChildren.length > 3 && rootChildren[rootChildren.length - 1] === node) {
        issues.push(
          this._issue(
            'info',
            'table-position',
            'Tabel berada di posisi terakhir dokumen — periksa apakah posisinya sudah benar',
            node.page,
          ),
        );
      }
    });
  },

  _checkTitlePreamble(tree, issues) {
    const texts = [];
    this._walk(tree, (node) => {
      if (node.type === 'root') return;
      texts.push(node.text || '');
      if (node.title && !node.text) texts.push(node.title);
    });
    const joined = texts.join('\n').toLowerCase();
    const hasBab = texts.some((t) => /^bab\s+/i.test(t));
    if (!hasBab) return;

    const hasMenimbang = /menimbang/i.test(joined);
    const hasJudul =
      /^(peraturan|keputusan|peraturan desa|peraturan bupati|peraturan gubernur|undang-undang|perda|perbup|perdes)/i.test(
        joined.trim(),
      );
    if (!hasJudul) {
      issues.push(this._issue('info', 'title-missing', 'Judul dokumen tidak terdeteksi di awal teks', null));
    }
    if (!hasMenimbang) {
      issues.push(this._issue('info', 'preamble-missing', 'Bagian "Menimbang" tidak terdeteksi', null));
    }
  },

  _checkPageOrder(lines, issues) {
    if (!lines || lines.length < 2) return;
    let prevPage = lines[0].page || 0;
    for (let i = 1; i < lines.length; i++) {
      const page = lines[i].page || 0;
      if (page < prevPage) {
        issues.push(
          this._issue(
            'error',
            'page-order',
            `Urutan halaman tidak monoton: baris di halaman ${page} muncul setelah halaman ${prevPage}`,
            page,
          ),
        );
        prevPage = page;
      } else {
        prevPage = page;
      }
    }
  },

  _checkOcrQuality(ctx, issues) {
    const pageQuality = ctx.ocrBlocks ? ctx.ocrBlocks.pageQuality : null;
    if (pageQuality && pageQuality.length > 0) {
      const low = pageQuality.filter((p) => p.lowQuality);
      if (low.length > 0) {
        issues.push(
          this._issue(
            'warning',
            'low-quality',
            `${low.length} halaman berkualitas rendah (LOW QUALITY): ${low.map((p) => p.page).join(', ')}`,
            null,
          ),
        );
      }
    }

    const lowBlocks = (ctx.ocrBlocks || []).filter((b) => b.quality === 'low');
    if (lowBlocks.length > 0) {
      const pages = new Set(lowBlocks.map((b) => (typeof b.page === 'number' ? b.page + 1 : b.page)));
      issues.push(
        this._issue(
          'warning',
          'low-quality',
          `${lowBlocks.length} blok OCR dari halaman ${[...pages].join(', ')} ditandai LOW QUALITY`,
          null,
        ),
      );
    }
  },
};

function reviewDocument(ctx) {
  const report = documentReviewer.review(ctx);
  logger.info(`  Review: skor ${report.score}, ${report.issueCount} issue`);
  for (const issue of report.issues.slice(0, 5)) {
    logger.warn(`    [${issue.severity}] ${issue.message}`);
  }
  return report;
}

module.exports = { documentReviewer, reviewDocument };
