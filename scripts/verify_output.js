// ============================================================
// Verifikasi output (v29.1) — "pintar": tidak perlu OCR ulang.
// ============================================================
// Mode 1 (offline, instan): node scripts/verify_output.js <file.md>...
//   Analisis file output markdown yang sudah ada: hitung CJK, simbol
//   non-Latin, angka menempel (TAHUN2020), dot internal, run mirror,
//   tampilkan kepala file + ringkasan skor. Exit 1 bila ada anomali.
//
// Mode 2 (upload): node scripts/verify_output.js --upload <pdf> <out.md>
//   Upload ke server /process-upload, simpan output, lalu analisis
//   dengan aturan yang sama (sekali jalan, tidak dua langkah).
//
// Dipakai agar sesi berikutnya tidak perlu menjalankan OCR panjang
// untuk memastikan output bersih — cukup verifikasi file tersimpan.
// ============================================================

const fs = require('fs');
const path = require('path');

const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/g;
const SYMBOL_RE = /[\u0370-\u03FF\u2200-\u22FF\u2300-\u23FF\u2500-\u257F\u2070-\u209F\u00B2\u00B3\u00B9]/g;
const GLUED_RE = /\b[A-Za-z]{3,}\d{2,4}\b/g;
const INTERNAL_DOT_RE = /\b[A-Za-z]{2,}\.[A-Za-z]{2,}\b/g;
// Run mirror: >= 2 token bare berurutan (>=1 huruf tunggal),
// mis. "T E", "L R 3 1 E 5. E" — pola yang dulu lolos gate.
const MIRROR_RUN_RE = /\b[A-Za-z]\b(?: [A-Za-z0-9]{1,2}\b){1,}/g;

function analyze(text) {
  const counts = {
    chars: text.length,
    cjk: (text.match(CJK_RE) || []).length,
    symbols: (text.match(SYMBOL_RE) || []).length,
    glued: (text.match(GLUED_RE) || []).length,
    internalDots: (text.match(INTERNAL_DOT_RE) || []).length,
    mirrorRuns: (text.match(MIRROR_RUN_RE) || []).length,
  };
  counts.anomalies = counts.cjk + counts.symbols + counts.mirrorRuns;
  return counts;
}

function report(file, counts, head) {
  console.log(`\n=== ${path.basename(file)} ===`);
  console.log(`  chars: ${counts.chars} | CJK: ${counts.cjk} | simbol: ${counts.symbols} | mirror-run: ${counts.mirrorRuns} | TAHUN menempel: ${counts.glued} | dot internal: ${counts.internalDots}`);
  console.log(`  kepala: ${head.slice(0, 120)}`);
  console.log(`  status: ${counts.anomalies === 0 ? 'BERSIH' : 'ANOMALI'}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Pemakaian: node scripts/verify_output.js <out.md>... | --upload <pdf> <out.md>');
    process.exit(1);
  }

  const files = [];
  if (args[0] === '--upload') {
    const [, pdfPath, outFile] = args;
    const buf = fs.readFileSync(pdfPath);
    const form = new FormData();
    form.append('pdf', new Blob([new Uint8Array(buf)], { type: 'application/pdf' }), path.basename(pdfPath));
    const start = Date.now();
    const res = await fetch('http://localhost:3000/process-upload', { method: 'POST', body: form });
    const data = await res.json();
    console.log(`Upload: status ${data.status}, ${((Date.now() - start) / 1000).toFixed(1)}s, ${data.text ? data.text.length : 0} char`);
    if (data.text) fs.writeFileSync(outFile, data.text, 'utf8');
    if (data.error) console.log(`  error: ${data.error}`);
    files.push(outFile);
  } else {
    files.push(...args);
  }

  let anyAnomaly = false;
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`  tidak ada: ${f}`);
      anyAnomaly = true;
      continue;
    }
    const text = fs.readFileSync(f, 'utf8');
    const counts = analyze(text);
    report(f, counts, text.trim());
    if (counts.anomalies > 0) anyAnomaly = true;
  }
  console.log(`\n${anyAnomaly ? 'ADA ANOMALI' : 'SEMUA BERSIH'}`);
  process.exit(anyAnomaly ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
