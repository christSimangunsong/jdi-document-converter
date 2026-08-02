// Analisis struktural hal 30 & 34: profil proyeksi, orientasi kontur, deteksi grid.
const path = require('path');
const fs = require('fs-extra');
const { openDocument, renderPage } = require('../src/pdf/imageConverter');
const { detectTextOrientation } = require('../src/ocr/orientationDetector');
const { detectWiredGridRegions, detectTableRegions } = require('../src/ocr/tableRegionOcr');

function grayProfile(canvas) {
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rows = new Array(canvas.height).fill(0);
  const cols = new Array(canvas.width).fill(0);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      const g = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
      if (g < 128) {
        rows[y]++;
        cols[x]++;
      }
    }
  }
  return { rows, cols };
}

function bands(arr, min, gap) {
  const out = [];
  let start = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > min) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= 4) out.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0 && arr.length - start >= 4) out.push([start, arr.length - 1]);
  return out;
}

async function main() {
  const pdfPath = path.join(__dirname, '..', 'Perbub No 2 Tahun 2020 ttg Kebijakan Pengelolaan Sampah-min.pdf');
  const buffer = fs.readFileSync(pdfPath);
  const doc = await openDocument(buffer);
  for (const pageNum of [30, 34]) {
    const canvas = await renderPage(doc, pageNum, 1.5);
    const { rows, cols } = grayProfile(canvas);
    const rowBands = bands(rows, Math.round(canvas.width * 0.005), 8);
    const colBands = bands(cols, Math.round(canvas.height * 0.005), 8);
    console.log(`\n=== halaman ${pageNum} (${canvas.width}x${canvas.height}) ===`);
    console.log('band baris:', rowBands.length, JSON.stringify(rowBands.slice(0, 40)));
    console.log('band kolom:', colBands.length, JSON.stringify(colBands.slice(0, 20)));
    const grid = detectWiredGridRegions(canvas);
    console.log('grid wired:', grid.length, JSON.stringify(grid.slice(0, 3)));
    const tableRegions = detectTableRegions(canvas);
    console.log('table regions:', tableRegions.length);
    const orient = await detectTextOrientation(canvas);
    console.log('orientasi kontur:', JSON.stringify(orient));
  }
  await doc.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
