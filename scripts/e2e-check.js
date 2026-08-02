// E2E v25: pipeline penuh (render boost -> OCR blocks -> reconstruction) pada sample.
// Laporan per halaman: CJK chars (tanda sisa simbol), word count, accepted.
const path = require('path');
const fs = require('fs');
const { convertPdfToImages } = require('C:/Users/ACER/jdi-document-converter/src/pdf/imageConverter');
const { performOcrBlocks } = require('C:/Users/ACER/jdi-document-converter/src/ocr/engine');
const { detectTableRegions } = require('C:/Users/ACER/jdi-document-converter/src/ocr/tableRegionOcr');
const { deskewImage } = require('C:/Users/ACER/jdi-document-converter/src/ocr/deskewRouter');
const { correctOrientation } = require('C:/Users/ACER/jdi-document-converter/src/ocr/orientationDetector');
const config = require('C:/Users/ACER/jdi-document-converter/src/config');

const PDF = 'C:/Users/ACER/jdi-document-converter/Perbub No 2 Tahun 2020 ttg Kebijakan Pengelolaan Sampah-min.pdf';
const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/g;

async function renderWithTableBoost(pdfBuffer) {
  const { images: lowImages } = await convertPdfToImages(pdfBuffer, { scale: 1.0 });
  const tablePages = new Set();
  for (let i = 0; i < lowImages.length; i++) {
    let img = lowImages[i];
    try {
      img = await correctOrientation(img);
      img = await deskewImage(img, { skipOsd: true });
    } catch { /* lanjut tanpa koreksi */ }
    if (detectTableRegions(img).length > 0) tablePages.add(i + 1);
  }
  const scale = config.pdfRenderScale || 2.0;
  const tableScale = (config.table && config.table.renderScale) || 3.0;
  const { images, pageCount } = await convertPdfToImages(pdfBuffer, { scale, tablePages, tableScale });
  return { images, pageCount, tablePages };
}

(async () => {
  const buf = fs.readFileSync(PDF);
  const { images, pageCount, tablePages } = await renderWithTableBoost(buf);
  console.log(`pages=${pageCount} tablePages=${[...tablePages].join(',')}`);
  const blocks = await performOcrBlocks(images);
  const pq = blocks.pageQuality || [];

  const perPage = new Map();
  for (const b of blocks) {
    const p = b.page || 0;
    const t = typeof b.text === 'string' ? b.text : '';
    if (!perPage.has(p)) perPage.set(p, { chars: 0, cjk: 0, words: 0 });
    const s = perPage.get(p);
    s.chars += t.length;
    s.cjk += (t.match(CJK_RE) || []).length;
    s.words += (t.match(/[a-zA-Z]+/g) || []).length;
  }

  let totalCjk = 0;
  for (let p = 0; p < pageCount; p++) {
    const s = perPage.get(p) || { chars: 0, cjk: 0, words: 0 };
    const q = pq[p] || {};
    totalCjk += s.cjk;
    const flag = s.cjk > 3 ? ' <== SYMBOL?' : '';
    console.log(
      `hal ${p + 1}: cjk=${s.cjk} words=${s.words} chars=${s.chars} accepted=${q.accepted} score=${q.score}${flag}`,
    );
  }
  console.log(`TOTAL CJK: ${totalCjk}`);

  const { runReconstruction } = require('C:/Users/ACER/jdi-document-converter/src/reconstruction');
  const doc = await runReconstruction(buf, blocks, {
    ocrEngine: config.ocr.engine || 'paddle',
  });
  const out = path.resolve('C:/Users/ACER/jdi-document-converter/output/e2e_v25.md');
  fs.writeFileSync(out, doc.markdown, 'utf8');
  console.log(`markdown -> ${out} (${doc.markdown.length} chars)`);
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
