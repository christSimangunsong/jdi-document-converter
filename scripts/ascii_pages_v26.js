// Visualisasi ASCII layout halaman (downsample ~120x200) + band profil.
const path = require('path');
const fs = require('fs-extra');
const { openDocument, renderPage } = require('../src/pdf/imageConverter');

async function main() {
  const pdfPath = path.join(__dirname, '..', 'Perbub No 2 Tahun 2020 ttg Kebijakan Pengelolaan Sampah-min.pdf');
  const buffer = fs.readFileSync(pdfPath);
  const doc = await openDocument(buffer);
  for (const pageNum of [30, 34]) {
    const canvas = await renderPage(doc, pageNum, 1.0);
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const CW = 100;
    const CH = Math.round((canvas.height / canvas.width) * CW * 1.4);
    const chars = ' .:-=+*#%@';
    const out = [];
    for (let y = 0; y < CH; y++) {
      let line = '';
      for (let x = 0; x < CW; x++) {
        const sx = Math.floor((x / CW) * canvas.width);
        const sy = Math.floor((y / CH) * canvas.height);
        const i = (sy * canvas.width + sx) * 4;
        const g = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
        const idx = g < 40 ? 9 : g < 90 ? 8 : g < 140 ? 7 : g < 180 ? 5 : g < 210 ? 3 : 1;
        line += chars[idx];
      }
      out.push(line);
    }
    console.log(`\n=========== halaman ${pageNum} (${canvas.width}x${canvas.height}) ===========`);
    console.log(out.join('\n'));
  }
  await doc.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
