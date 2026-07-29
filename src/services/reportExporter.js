const ExcelJS = require('exceljs');
const logger = require('./logger');

const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

function getDayName(dateStr) {
  return DAY_NAMES[new Date(dateStr).getDay()];
}

function getStatusDesc(status, errorMsg) {
  switch (status) {
    case 'BERHASIL':
      return 'File berhasil dikonversi menjadi teks';
    case 'GAGAL':
      return errorMsg ? `Gagal: ${errorMsg}` : 'Terjadi kesalahan saat pemrosesan';
    case 'RUSAK':
      return errorMsg ? `File rusak: ${errorMsg}` : 'File PDF corrupt atau tidak bisa dibaca';
    case 'KOSONG':
      return 'File 0 byte atau hasil konversi tidak menghasilkan teks';
    default:
      return '-';
  }
}

async function drawPieChart(summary) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const width = 520;
  const height = 360;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#333333';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Distribusi Status Konversi', width / 2, 30);

  const items = [
    { label: 'BERHASIL', value: summary.berhasil, color: '#27ae60' },
    { label: 'GAGAL', value: summary.gagal, color: '#e74c3c' },
    { label: 'RUSAK', value: summary.rusak, color: '#f39c12' },
    { label: 'KOSONG', value: summary.kosong, color: '#3498db' },
  ];

  const total = items.reduce((s, i) => s + i.value, 0);
  if (total === 0) {
    ctx.fillStyle = '#999';
    ctx.font = '14px sans-serif';
    ctx.fillText('Belum ada data', width / 2, height / 2);
    return canvas.toBuffer('image/png');
  }

  const cx = 200;
  const cy = 200;
  const r = 120;
  let start = -Math.PI / 2;

  for (const item of items) {
    if (item.value === 0) continue;
    const angle = (item.value / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = item.color;
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.stroke();
    start += angle;
  }

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.4, 0, 2 * Math.PI);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();

  let ly = 80;
  ctx.textAlign = 'left';
  for (const item of items) {
    ctx.fillStyle = item.color;
    ctx.fillRect(330, ly, 20, 20);
    ctx.fillStyle = '#333';
    ctx.font = '13px sans-serif';
    const pct = total > 0 ? ((item.value / total) * 100).toFixed(1) : 0;
    ctx.fillText(`${item.label}: ${item.value} (${pct}%)`, 360, ly + 16);
    ly += 35;
  }

  return canvas.toBuffer('image/png');
}

async function drawBarChart(daily) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const width = 700;
  const height = 380;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#333';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Konversi per Hari', width / 2, 30);

  if (!daily || daily.length === 0) {
    ctx.fillStyle = '#999';
    ctx.font = '14px sans-serif';
    ctx.fillText('Belum ada data', width / 2, height / 2);
    return canvas.toBuffer('image/png');
  }

  const n = Math.min(daily.length, 14);
  const maxVal = Math.max(...daily.slice(0, n).map((d) => Math.max(d.jumlah, d.uploaded)), 1);

  const padLeft = 60;
  const padRight = 20;
  const padTop = 50;
  const padBottom = 50;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;
  const gap = chartW / n;
  const barW = Math.min(30, gap * 0.3);

  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padLeft, padTop);
  ctx.lineTo(padLeft, padTop + chartH);
  ctx.lineTo(padLeft + chartW, padTop + chartH);
  ctx.stroke();

  ctx.fillStyle = '#666';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const val = Math.round((maxVal / 4) * i);
    const y = padTop + chartH - (chartH / 4) * i;
    ctx.fillText(val, padLeft - 8, y + 4);
    ctx.strokeStyle = '#f0f0f0';
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + chartW, y);
    ctx.stroke();
  }

  const colors = ['#3498db', '#2ecc71'];
  const labels = ['Jumlah', 'Upload'];

  for (let i = 0; i < n; i++) {
    const d = daily[i];
    const x = padLeft + i * gap + (gap - barW * 2) / 2;

    const h1 = (d.jumlah / maxVal) * chartH;
    ctx.fillStyle = colors[0];
    ctx.fillRect(x, padTop + chartH - h1, barW, h1);

    const h2 = (d.uploaded / maxVal) * chartH;
    ctx.fillStyle = colors[1];
    ctx.fillRect(x + barW, padTop + chartH - h2, barW, h2);

    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const label = d.tgl ? String(d.tgl).slice(5) : '';
    ctx.fillText(label, x + barW, padTop + chartH + 16);
  }

  ctx.textAlign = 'left';
  ctx.font = '12px sans-serif';
  const lx = width - 170;
  ctx.fillStyle = colors[0];
  ctx.fillRect(lx, 10, 14, 14);
  ctx.fillStyle = '#333';
  ctx.fillText(labels[0], lx + 20, 23);

  ctx.fillStyle = colors[1];
  ctx.fillRect(lx + 80, 10, 14, 14);
  ctx.fillStyle = '#333';
  ctx.fillText(labels[1], lx + 100, 23);

  return canvas.toBuffer('image/png');
}

async function generateXlsxReport(data, from, to) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'JDIH Document Converter';
  wb.created = new Date();

  const hdrFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  const hdrFont = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  const bdr = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  const statusColors = {
    BERHASIL: { argb: 'FF27AE60' },
    GAGAL: { argb: 'FFE74C3C' },
    RUSAK: { argb: 'FFF39C12' },
    KOSONG: { argb: 'FF3498DB' },
  };

  // ========== SHEET 1: RINGKASAN ==========
  const ws1 = wb.addWorksheet('Ringkasan');

  ws1.mergeCells('A1:E1');
  const t = ws1.getCell('A1');
  t.value = 'LAPORAN KONVERSI DOKUMEN';
  t.font = { name: 'Calibri', size: 16, bold: true };

  ws1.mergeCells('A2:E2');
  ws1.getCell('A2').value = `Periode: ${from || 'Semua'} s.d ${to || 'Semua'}`;
  ws1.getCell('A2').font = { italic: true, color: { argb: 'FF666666' } };

  ws1.mergeCells('A3:E3');
  ws1.getCell('A3').value = `Dibuat: ${new Date().toLocaleString('id-ID')} WIB`;
  ws1.getCell('A3').font = { italic: true, color: { argb: 'FF666666' } };

  const sumHeaders = ['No', 'Item', 'Jumlah', 'Satuan', 'Keterangan'];
  const sr = 5;
  sumHeaders.forEach((h, i) => {
    const c = ws1.getCell(sr, i + 1);
    c.value = h;
    c.font = hdrFont;
    c.fill = hdrFill;
    c.border = bdr;
    c.alignment = { horizontal: 'center' };
  });

  const sumData = [
    [1, 'Total Dokumen Diproses', data.summary.total, 'dokumen', 'Seluruh dokumen yang masuk pipeline konversi'],
    [2, 'Berhasil', data.summary.berhasil, 'dokumen', 'Dokumen berhasil dikonversi menjadi teks'],
    [3, 'Gagal', data.summary.gagal, 'dokumen', 'Dokumen gagal diproses (error download atau sistem)'],
    [4, 'Rusak', data.summary.rusak, 'dokumen', 'File PDF corrupt atau tidak bisa dibaca'],
    [5, 'Kosong', data.summary.kosong, 'dokumen', 'File 0 byte atau hasil konversi tidak menghasilkan teks'],
    [6, 'Upload ke Database', data.summary.uploaded, 'dokumen', 'Dokumen yang sudah diupload ke database'],
    [7, 'Belum Upload', data.summary.belum_uploaded, 'dokumen', 'Dokumen berhasil tapi belum diupload ke database'],
    [8, 'Rata-rata Waktu', data.summary.rata_durasi || '-', 'detik', 'Rata-rata waktu yang dibutuhkan per konversi'],
  ];

  sumData.forEach((row, ri) => {
    row.forEach((val, ci) => {
      const c = ws1.getCell(sr + 1 + ri, ci + 1);
      c.value = val;
      c.border = bdr;
      if (ci === 0) c.alignment = { horizontal: 'center' };
    });
  });

  ws1.getColumn(1).width = 6;
  ws1.getColumn(2).width = 26;
  ws1.getColumn(3).width = 12;
  ws1.getColumn(4).width = 14;
  ws1.getColumn(5).width = 55;

  try {
    const pieBuf = await drawPieChart(data.summary);
    const pieId = wb.addImage({ buffer: pieBuf, extension: 'png' });
    ws1.addImage(pieId, { tl: { col: 0, row: sr + sumData.length + 1 }, ext: { width: 520, height: 360 } });
  } catch (e) {
    logger.warn(`Gagal render pie chart: ${e.message}`);
  }

  // ========== SHEET 2: HARIAN ==========
  const ws2 = wb.addWorksheet('Harian');

  ws2.mergeCells('A1:F1');
  ws2.getCell('A1').value = 'KONVERSI PER HARI';
  ws2.getCell('A1').font = { name: 'Calibri', size: 16, bold: true };

  const dailyHeaders = ['No', 'Tanggal', 'Jumlah Konversi', 'Upload ke DB', 'Hari', 'Keterangan'];
  dailyHeaders.forEach((h, i) => {
    const c = ws2.getCell(3, i + 1);
    c.value = h;
    c.font = hdrFont;
    c.fill = hdrFill;
    c.border = bdr;
    c.alignment = { horizontal: 'center' };
  });

  data.daily.forEach((d, i) => {
    const tgl = d.tgl ? new Date(d.tgl).toISOString().slice(0, 10) : '-';
    const dayName = tgl !== '-' ? getDayName(tgl) : '-';
    const desc = `${dayName} — ${d.jumlah} konversi, ${d.uploaded} diupload`; // eslint-disable-line
    [i + 1, tgl, d.jumlah, d.uploaded, dayName, desc].forEach((val, ci) => {
      const c = ws2.getCell(4 + i, ci + 1);
      c.value = val;
      c.border = bdr;
      if (ci === 0) c.alignment = { horizontal: 'center' };
    });
  });

  ws2.getColumn(1).width = 6;
  ws2.getColumn(2).width = 14;
  ws2.getColumn(3).width = 20;
  ws2.getColumn(4).width = 16;
  ws2.getColumn(5).width = 12;
  ws2.getColumn(6).width = 45;

  try {
    const barBuf = await drawBarChart(data.daily);
    const barId = wb.addImage({ buffer: barBuf, extension: 'png' });
    const chartRow = 4 + data.daily.length + 1;
    ws2.addImage(barId, { tl: { col: 0, row: chartRow }, ext: { width: 700, height: 380 } });
  } catch (e) {
    logger.warn(`Gagal render bar chart: ${e.message}`);
  }

  // ========== SHEET 3: DETAIL ==========
  const ws3 = wb.addWorksheet('Detail');

  ws3.mergeCells('A1:J1');
  ws3.getCell('A1').value = 'DETAIL FILE';
  ws3.getCell('A1').font = { name: 'Calibri', size: 16, bold: true };

  const detailHeaders = [
    'No',
    'Nama File',
    'Status',
    'Upload ke DB',
    'Tipe File',
    'Halaman',
    'Durasi (dtk)',
    'Sumber',
    'Tanggal',
    'Keterangan',
  ];
  detailHeaders.forEach((h, i) => {
    const c = ws3.getCell(3, i + 1);
    c.value = h;
    c.font = hdrFont;
    c.fill = hdrFill;
    c.border = bdr;
    c.alignment = { horizontal: 'center' };
  });

  data.details.forEach((d, i) => {
    const uploaded = d.text_uploaded ? 'Ya' : 'Tidak';
    const durasi = d.duration_seconds != null ? d.duration_seconds : '-';
    const src = d.source_type === 'url' ? 'URL' : 'Upload';
    const tgl = d.created_at ? new Date(d.created_at).toISOString().slice(0, 10) : '-';
    const desc = getStatusDesc(d.status, d.error_message);

    [i + 1, d.file_name, d.status, uploaded, d.file_type || '-', d.page_count || 0, durasi, src, tgl, desc].forEach(
      (val, ci) => {
        const c = ws3.getCell(4 + i, ci + 1);
        c.value = val;
        c.border = bdr;
        if ([0, 5, 6].includes(ci)) c.alignment = { horizontal: 'center' };
      },
    );

    const sc = statusColors[d.status];
    if (sc) {
      ws3.getCell(4 + i, 3).font = { color: sc, bold: true };
    }
  });

  ws3.getColumn(1).width = 6;
  ws3.getColumn(2).width = 38;
  ws3.getColumn(3).width = 14;
  ws3.getColumn(4).width = 14;
  ws3.getColumn(5).width = 12;
  ws3.getColumn(6).width = 10;
  ws3.getColumn(7).width = 14;
  ws3.getColumn(8).width = 10;
  ws3.getColumn(9).width = 14;
  ws3.getColumn(10).width = 58;

  return wb;
}

module.exports = { generateXlsxReport };
