// Diag v26: cek sumber teks mirror (hal 30 & 34) — OCR biasa / region-repair / table-aware.
const path = require('path');
const fs = require('fs');
const { openDocument, renderPage } = require('C:/Users/ACER/jdi-document-converter/src/pdf/imageConverter');
const { performOcrBlocks } = require('C:/Users/ACER/jdi-document-converter/src/ocr/engine');

const PDF = 'C:/Users/ACER/jdi-document-converter/Perbub No 2 Tahun 2020 ttg Kebijakan Pengelolaan Sampah-min.pdf';
const MIRROR = /qedurrs|NOLERA TA RORANS|Iue rsesoIed|uesureinsued|srenarrL|rsesoIed/;
const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/g;

(async () => {
  const buf = fs.readFileSync(PDF);
  const doc = await openDocument(new Uint8Array(buf));
  for (const pageNum of [30, 34]) {
    const img = await renderPage(doc, pageNum, 2.0);
    const blocks = await performOcrBlocks([img]);
    let flagged = 0;
    let totalCjk = 0;
    for (const b of blocks) {
      const t = typeof b.text === 'string' ? b.text : '';
      totalCjk += (t.match(CJK_RE) || []).length;
      const box = b.bbox
        ? `${Math.round(b.bbox.x || b.bbox.x1 || 0)},${Math.round(b.bbox.y || b.bbox.y1 || 0)} ${Math.round(b.bbox.w || (b.bbox.x2 ? b.bbox.x2 - b.bbox.x : 0))}x${Math.round(b.bbox.h || (b.bbox.y2 ? b.bbox.y2 - b.bbox.y : 0))}`
        : 'no-bbox';
      if (MIRROR.test(t) || (t.match(CJK_RE) || []).length > 0 || (b.source || '').includes('rescue')) {
        flagged++;
        const snippet = t.replace(/\n/g, ' | ').slice(0, 150);
        console.log(`hal ${pageNum} [src=${b.source}] conf=${b.confidence} bbox=${box} ${snippet}`);
      }
    }
    console.log(`hal ${pageNum}: blok terpilih ${flagged} / total blok ${blocks.length}, TOTAL CJK ${totalCjk}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
