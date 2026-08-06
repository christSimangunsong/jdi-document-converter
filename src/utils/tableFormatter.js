// Membersihkan teks sel HTML dari artefak umum hasil table-aware OCR:
// - placeholder literal "None" (img2table meletakkan None saat OCR sel gagal,
//   df.to_html hanya mengganti NaN, bukan Python None)
// - artefak border "=" / "-" yang terbaca OCR
// - newline ganda dari gabungan sel multi-baris
function cleanCellText(text) {
  let t = text || '';
  // img2table menyisipkan literal "\n" atau entitas "&#10;" sebagai pemisah
  // baris dalam sel; ubah ke newline asli agar "None" (baris berikutnya)
  // punya word boundary.
  t = t.replace(/\\n/g, '\n');
  t = t.replace(/&#10;/gi, '\n');
  t = t.replace(/&#13;/gi, '\n');
  t = t.replace(/\bNone\b/g, '');
  t = t.replace(/^[=-]+[=-\s]*$/gm, '');
  t = t.replace(/^[=-]+(?=\S)/gm, '');
  t = t.replace(/\n{2,}/g, '\n');
  return t.trim();
}

// Baris header indeks kolom (mis. "0 | 1 | 2") dihasilkan img2table/PaddleX
// saat deteksi header gagal — semua sel berupa angka pendek atau kosong.
// Hanya diterapkan pada baris pertama tabel untuk menghindari memotong
// baris data yang memang berisi angka.
function isIndexRow(cells) {
  if (!cells || cells.length === 0) return false;
  const nonEmpty = cells.filter((c) => c.trim().length > 0);
  if (nonEmpty.length === 0) return false;
  return nonEmpty.every((c) => /^\d{1,3}$/.test(c.trim()) || /^col\d+$/i.test(c.trim()));
}

// (v30.1) Gate kualitas grid ASCII: bila struktur tabel korup (artefak
// OCR ganda), fallback ke plain text per baris agar tidak ada info yang
// hilang. Sinyal korupsi (conservative — fallback TIDAK menghapus data):
//   1. maxCols > 20 — tabel absurd (gabungan kolom OCR rusak).
//   2. Sel berisi artefak grid ("|--|", "++", "----") >= 10% sel non-kosong.
//   3. Variasi jumlah sel non-kosong antar baris >= 3 nilai — colspan/
//      struktur hilang saat parsing HTML regex.
//   4. Ada baris 1-sel di samping baris >= 4 sel — gabungan sel kacau.
// rawCounts = jumlah sel per baris SEBELUM padding (struktur asli).
function _tableGridUsable(tableData, rawCounts) {
  if (!tableData || tableData.length === 0) return false;
  const maxCols = Math.max(...tableData.map((r) => r.cells.length), 1);
  if (maxCols > 20) return false;

  let nonEmpty = 0;
  let gridArtifact = 0;
  for (const row of tableData) {
    for (const c of row.cells) {
      if (!c.trim()) continue;
      nonEmpty++;
      if (/[|]{2,}|[+]{2,}|[=-]{4,}/.test(c)) gridArtifact++;
    }
  }
  if (nonEmpty === 0) return false;
  if (gridArtifact / nonEmpty >= 0.1) return false;

  const distinct = new Set(rawCounts);
  if (distinct.size >= 3) return false;
  const hasSparse = rawCounts.some((n) => n === 1);
  const hasWide = rawCounts.some((n) => n >= 4);
  if (hasSparse && hasWide) return false;

  return true;
}

// (v30.1) Fallback tabel korup: satu baris per baris tabel, sel digabung
// " | " tanpa grid ASCII. Info tabel tetap utuh, format aman.
function formatTablePlainText(tableData) {
  const lines = [];
  for (const row of tableData) {
    if (row.cells.every((c) => c.trim().length === 0)) continue;
    lines.push(row.cells.map((c) => c.trim()).join(' | '));
  }
  return lines.join('\n');
}

// (v30.4) Parsing HTML tabel -> tableData [{cells, isHeader}] + pembersihan
// baris header indeks / baris kosong. Dipisahkan agar mode transkripsi bisa
// memakai data sel yang sama tanpa grid ASCII.
function parseTableHtml(html) {
  if (!html) return [];

  const rows = html.match(/<tr[^>]*>.*?<\/tr>/gis);
  if (!rows) return [];

  const tableData = [];

  for (const row of rows) {
    const isHeader = /<th[^>]*>/i.test(row);
    const cells = row.match(/<t[dh][^>]*>.*?<\/t[dh]>/gis);
    if (!cells) continue;

    const rowData = cells.map((cell) => cleanCellText(cell.replace(/<[^>]+>/g, '')));
    tableData.push({ cells: rowData, isHeader });
  }

  if (tableData.length === 0) return [];

  // Buang baris header indeks kolom (baris pertama saja) dan baris yang
  // semua selnya kosong setelah pembersihan.
  while (tableData.length > 0 && tableData[0].isHeader && isIndexRow(tableData[0].cells)) {
    tableData.shift();
  }
  for (let i = tableData.length - 1; i >= 0; i--) {
    if (tableData[i].cells.every((c) => c.length === 0)) {
      tableData.splice(i, 1);
    }
  }

  return tableData;
}

function formatTableHtmlToText(html) {
  if (!html) return '';

  const tableData = parseTableHtml(html);
  if (tableData.length === 0) return cleanCellText(html.replace(/<[^>]+>/g, ''));

  const rawCounts = tableData.map((r) => r.cells.length);
  const colCounts = tableData.map((r) => r.cells.length);
  const maxCols = Math.max(...colCounts, 1);

  for (const row of tableData) {
    while (row.cells.length < maxCols) {
      row.cells.push('');
    }
  }

  // (v30.1) Grid korup -> plain text per baris (sel " | " sel).
  if (!_tableGridUsable(tableData, rawCounts)) {
    return formatTablePlainText(tableData);
  }

  const colWidths = [];
  for (let c = 0; c < maxCols; c++) {
    let maxW = 3;
    for (const row of tableData) {
      if (c < row.cells.length) {
        maxW = Math.max(maxW, row.cells[c].length + 2);
      }
    }
    colWidths.push(Math.min(maxW, 60));
  }

  const separator = '+' + colWidths.map((w) => '-'.repeat(w)).join('+') + '+';

  const lines = [];
  lines.push(separator);

  for (const row of tableData) {
    const cells = row.cells;
    const maxLines = Math.max(
      1,
      ...cells.map((c, i) => {
        const w = colWidths[i] - 2;
        return w > 0 ? Math.ceil(c.length / w) : 1;
      }),
    );

    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
      const lineCells = cells.map((cell, ci) => {
        const w = colWidths[ci] - 2;
        if (w <= 0) return ' '.repeat(colWidths[ci]);
        const start = lineIdx * w;
        const chunk = cell.substring(start, start + w);
        return ' ' + chunk.padEnd(w) + ' ';
      });
      lines.push('|' + lineCells.join('|') + '|');
    }

    lines.push(separator);
  }

  return lines.join('\n');
}

module.exports = {
  formatTableHtmlToText,
  formatTablePlainText,
  parseTableHtml,
  _tableGridUsable,
  cleanCellText,
  isIndexRow,
};
