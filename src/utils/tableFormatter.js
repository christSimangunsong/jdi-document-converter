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

function formatTableHtmlToText(html) {
  if (!html) return '';

  const rows = html.match(/<tr[^>]*>.*?<\/tr>/gis);
  if (!rows) return cleanCellText(html.replace(/<[^>]+>/g, ''));

  const tableData = [];

  for (const row of rows) {
    const isHeader = /<th[^>]*>/i.test(row);
    const cells = row.match(/<t[dh][^>]*>.*?<\/t[dh]>/gis);
    if (!cells) continue;

    const rowData = cells.map((cell) => cleanCellText(cell.replace(/<[^>]+>/g, '')));
    tableData.push({ cells: rowData, isHeader });
  }

  if (tableData.length === 0) return '';

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

  if (tableData.length === 0) return '';

  const colCounts = tableData.map((r) => r.cells.length);
  const maxCols = Math.max(...colCounts, 1);

  for (const row of tableData) {
    while (row.cells.length < maxCols) {
      row.cells.push('');
    }
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

module.exports = { formatTableHtmlToText, cleanCellText, isIndexRow };
