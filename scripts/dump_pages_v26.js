// Diagnostik visual: simpan halaman 30 & 34 sebagai PNG untuk inspeksi.
const path = require('path');
const fs = require('fs-extra');
const { openDocument, convertPdfToImages } = require('../src/pdf/imageConverter');

async function main() {
  const pdfPath = path.join(__dirname, '..', 'Perbub No 2 Tahun 2020 ttg Kebijakan Pengelolaan Sampah-min.pdf');
  const buffer = fs.readFileSync(pdfPath);
  const doc = await openDocument(buffer);
  for (const pageNum of [30, 34]) {
    const { renderPage } = require('../src/pdf/imageConverter');
    const canvas = await renderPage(doc, pageNum, 1.5);
    const buf = canvas.toBuffer('image/png');
    const out = path.join(__dirname, '..', 'output', `page${pageNum}_raw.png`);
    fs.writeFileSync(out, buf);
    console.log('SAVED', out, canvas.width, 'x', canvas.height);
  }
  await doc.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
