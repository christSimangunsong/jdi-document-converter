function formatTableHtmlToText(html) {
  if (!html) return '';

  const rows = html.match(/<tr[^>]*>.*?<\/tr>/gis);
  if (!rows) return html.replace(/<[^>]+>/g, '').trim();

  const tableData = [];

  for (const row of rows) {
    const isHeader = /<th[^>]*>/i.test(row);
    const cells = row.match(/<t[dh][^>]*>.*?<\/t[dh]>/gis);
    if (!cells) continue;

    const rowData = cells.map((cell) => {
      const text = cell.replace(/<[^>]+>/g, '').trim();
      return text;
    });
    tableData.push({ cells: rowData, isHeader });
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

module.exports = { formatTableHtmlToText };
