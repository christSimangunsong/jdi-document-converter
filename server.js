const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const config = require('./src/config');
const logger = require('./src/services/logger');
const { downloadPdf } = require('./src/services/pdfDownloader');
const { detectPdfType } = require('./src/pdf/detector');
const { extractText } = require('./src/pdf/textExtractor');
const { convertPdfToImages } = require('./src/pdf/imageConverter');
const { performOcr } = require('./src/ocr/engine');
const { performStructuredOcr } = require('./src/services/structureService');
const { cleanText } = require('./src/utils/textCleaner');
const { rebuildDocumentStructure } = require('./src/utils/DocumentStructureRebuilder');
const activityLogger = require('./src/services/activityLogger');
const { generateXlsxReport } = require('./src/services/reportExporter');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function extractFileNameFromUrl(url) {
  try {
    const safe = url.replace(/\s/g, '%20');
    const segments = new URL(safe).pathname.split('/').filter(Boolean);
    const last = segments.pop() || 'doc';
    const decoded = decodeURIComponent(last);
    return decoded
      .replace(/\.pdf$/i, '')
      .replace(/[^a-zA-Z0-9 _-]/g, '_')
      .substring(0, 200);
  } catch {
    return 'doc_' + Date.now();
  }
}

function computeHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function processBuffer(pdfBuffer, fileName, sourceInfo, onProgress) {
  const result = {
    text: '',
    pageCount: 0,
    type: null,
    ocrStatus: 'TIDAK DIPROSES',
    outputFile: '',
    status: 'BERHASIL',
    errorMessage: null,
    durasi: '0.0 dtk',
    fileSizeBytes: pdfBuffer.length,
    sourceType: sourceInfo.sourceType,
    sourceUrl: sourceInfo.sourceUrl || null,
    originalName: sourceInfo.originalName || null,
    fileHash: sourceInfo.fileHash || null,
  };

  const startTime = Date.now();

  try {
    if (pdfBuffer.length === 0) {
      result.status = 'KOSONG';
      result.errorMessage = 'File PDF kosong (0 byte)';
      logger.warn(`  File kosong: ${fileName}`);
      if (onProgress) onProgress(1);
    } else {
      const detection = await detectPdfType(pdfBuffer);
      result.type = detection.type;
      result.pageCount = detection.pageCount;
      if (onProgress) onProgress(0.05);

      if (detection.type === 'TEXT') {
        const extracted = await extractText(pdfBuffer);
        result.pageCount = extracted.pageCount;
        result.ocrStatus = 'TIDAK DIPERLUKAN';
        result.text = extracted.text;
        if (onProgress) onProgress(0.85);
      } else {
        const { images, pageCount } = await convertPdfToImages(pdfBuffer);
        result.pageCount = pageCount;
        if (onProgress) onProgress(0.15);

        const ocrFn = config.structureServiceUrl ? performStructuredOcr : performOcr;
        const ocrResults = await ocrFn(images, (page, total) => {
          if (onProgress) onProgress(0.15 + (page / total) * 0.7);
        });
        result.text = ocrResults.join('\n\n');
        result.ocrStatus = 'BERHASIL';
      }

      const cleanedText = cleanText(result.text);

      if (!cleanedText.trim()) {
        result.status = 'KOSONG';
        result.errorMessage = 'Hasil konversi kosong — file mungkin rusak atau tidak terbaca';
        result.text = '';
      } else {
        const structuredText = rebuildDocumentStructure(cleanedText);
        result.text = structuredText;

        const outputFileName = `${fileName}.txt`;
        const outputPath = path.join(config.outputDir, outputFileName);
        await fs.writeFile(outputPath, structuredText, 'utf-8');
        result.outputFile = outputFileName;
      }

      if (onProgress) onProgress(0.95);
    }
  } catch (error) {
    result.status = 'RUSAK';
    result.errorMessage = error.message;
    logger.warn(`  File rusak: ${fileName} — ${error.message}`);
  }

  result.durasi = ((Date.now() - startTime) / 1000).toFixed(1) + ' dtk';
  if (onProgress) onProgress(1);

  return result;
}

app.post('/process-url', async (req, res) => {
  try {
    const { url, nama } = req.body;
    if (!url) return res.status(400).json({ error: 'URL PDF diperlukan' });

    const fileName = nama || extractFileNameFromUrl(url);

    logger.info(`[WEB] Memproses URL: ${url}`);
    const pdfBuffer = await downloadPdf(url);
    const fileHash = computeHash(pdfBuffer);

    const result = await processBuffer(pdfBuffer, fileName, {
      sourceType: 'url',
      sourceUrl: url,
      originalName: fileName,
      fileHash,
    });

    logger.info(`[WEB] Selesai: ${url} (${result.durasi})`);
    res.json(result);
  } catch (error) {
    logger.error(`[WEB] Error URL: ${error.message}`);
    const fileName = req.body.nama || (req.body.url ? extractFileNameFromUrl(req.body.url) : 'doc_' + Date.now());
    res.json({ status: 'GAGAL', error: error.message, durasi: '0.0 dtk', fileName });
  }
});

app.post('/process-urls', async (req, res) => {
  try {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'Array URL diperlukan' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true);
    }

    const send = (event, data) => {
      try {
        if (!res.destroyed) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      } catch (e) {
        logger.error(`[SSE] Gagal kirim event ${event}: ${e.message}`);
      }
    };

    let closed = false;
    res.on('close', () => {
      closed = true;
    });

    for (let i = 0; i < urls.length; i++) {
      if (closed) break;
      const url = urls[i].trim();
      if (!url) continue;

      const n = urls.length;
      const basePct = (i / n) * 100;
      const filePct = 100 / n;

      send('progress', { pct: Math.round(basePct) });
      const fileName = extractFileNameFromUrl(url);

      try {
        logger.info(`[WEB Batch ${i + 1}/${n}] Memproses URL: ${url}`);
        const pdfBuffer = await downloadPdf(url);
        send('progress', { pct: Math.round(basePct + filePct * 0.1) });

        const fileHash = computeHash(pdfBuffer);
        send('progress', { pct: Math.round(basePct + filePct * 0.15) });

        const result = await processBuffer(pdfBuffer, fileName, {
          sourceType: 'url',
          sourceUrl: url,
          originalName: fileName,
          fileHash,
        }, (inner) => {
          const pct = basePct + filePct * (0.15 + inner * 0.85);
          send('progress', { pct: Math.min(Math.round(pct), Math.round(basePct + filePct)) });
        });
        result.index = i;
        send('progress', { pct: Math.round(basePct + filePct) });
        send('result', result);
        logger.info(`[WEB Batch ${i + 1}/${n}] Selesai: ${url}`);
      } catch (error) {
        logger.error(`[WEB Batch ${i + 1}/${n}] Error: ${url} - ${error.message}`);
        send('progress', { pct: Math.round(basePct + filePct) });
        send('error', { index: i, url, status: 'GAGAL', error: error.message, durasi: '0.0 dtk' });
      }
    }

    if (!closed) {
      send('done', { total: urls.length });
      res.end();
    }
  } catch (error) {
    logger.error(`[WEB] Error batch URL: ${error.message}`);
    if (!res.headersSent) res.status(500).json({ error: error.message });
    else res.end();
  }
});

app.post('/process-upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File PDF diperlukan' });

    const fileName = req.body.nama || path.parse(req.file.originalname).name;

    logger.info(`[WEB] Memproses file: ${req.file.originalname}`);
    const pdfBuffer = await fs.readFile(req.file.path);
    const fileHash = computeHash(pdfBuffer);

    const result = await processBuffer(pdfBuffer, fileName, {
      sourceType: 'upload',
      originalName: req.file.originalname,
      fileHash,
    });

    await fs.remove(req.file.path);
    logger.info(`[WEB] Selesai: ${req.file.originalname} (${result.durasi})`);
    res.json(result);
  } catch (error) {
    logger.error(`[WEB] Error upload: ${error.message}`);
    const origName = req.file ? req.file.originalname : 'unknown';
    const fileName = req.file ? req.body.nama || path.parse(req.file.originalname).name : 'unknown';
    if (req.file) await fs.remove(req.file.path).catch(() => {});
    res.json({ status: 'GAGAL', error: error.message, durasi: '0.0 dtk', fileName });
  }
});

app.post('/process-uploads', upload.array('pdf', 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'File PDF diperlukan' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true);
    }

    const send = (event, data) => {
      try {
        if (!res.destroyed) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      } catch (e) {
        logger.error(`[SSE] Gagal kirim event ${event}: ${e.message}`);
      }
    };

    let closed = false;
    res.on('close', () => {
      closed = true;
    });

    for (let i = 0; i < req.files.length; i++) {
      if (closed) break;
      const file = req.files[i];
      const fileName = path.parse(file.originalname).name;

      const n = req.files.length;
      const basePct = (i / n) * 100;
      const filePct = 100 / n;

      send('progress', { pct: Math.round(basePct) });

      try {
        const pdfBuffer = await fs.readFile(file.path);
        send('progress', { pct: Math.round(basePct + filePct * 0.1) });

        const fileHash = computeHash(pdfBuffer);
        send('progress', { pct: Math.round(basePct + filePct * 0.15) });

        logger.info(`[WEB Batch ${i + 1}/${n}] Memproses file: ${file.originalname}`);
        const result = await processBuffer(pdfBuffer, fileName, {
          sourceType: 'upload',
          originalName: file.originalname,
          fileHash,
        }, (inner) => {
          const pct = basePct + filePct * (0.15 + inner * 0.85);
          send('progress', { pct: Math.min(Math.round(pct), Math.round(basePct + filePct)) });
        });
        result.index = i;
        result.originalName = file.originalname;
        send('progress', { pct: Math.round(basePct + filePct) });
        send('result', result);
        logger.info(`[WEB Batch ${i + 1}/${n}] Selesai: ${file.originalname}`);
      } catch (error) {
        logger.error(`[WEB Batch ${i + 1}/${n}] Error: ${file.originalname} - ${error.message}`);
        send('progress', { pct: Math.round(basePct + filePct) });
        send('error', {
          index: i,
          originalName: file.originalname,
          status: 'GAGAL',
          error: error.message,
          durasi: '0.0 dtk',
        });
      }

      await fs.remove(file.path);
    }

    if (!closed) {
      send('done', { total: req.files.length });
      res.end();
    }
  } catch (error) {
    logger.error(`[WEB] Error batch upload: ${error.message}`);
    if (!res.headersSent) res.status(500).json({ error: error.message });
    else res.end();
  }
});

app.get('/download/:file', async (req, res) => {
  const filePath = path.join(config.outputDir, req.params.file);
  if (!(await fs.pathExists(filePath))) {
    return res.status(404).json({ error: 'File tidak ditemukan' });
  }
  res.download(filePath);
});

app.get('/api/activities', async (req, res) => {
  try {
    const activities = await activityLogger.getActivities();
    res.json(activities);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/activities/stats', async (req, res) => {
  try {
    const stats = await activityLogger.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/activities/:id', async (req, res) => {
  try {
    const activity = await activityLogger.getActivityById(parseInt(req.params.id, 10));
    if (!activity) return res.status(404).json({ error: 'Aktivitas tidak ditemukan' });
    res.json(activity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/activities/save', async (req, res) => {
  try {
    const {
      text,
      file_name,
      source_type,
      source_url,
      original_name,
      file_type,
      ocr_status,
      page_count,
      file_size_bytes,
      duration_seconds,
      file_hash,
    } = req.body;

    if (!file_name) return res.status(400).json({ error: 'Nama file diperlukan' });

    if (file_hash) {
      const dup = await activityLogger.checkDuplicateByHash(file_hash);
      if (dup) {
        return res.json({
          duplicate: true,
          existingId: dup.id,
          existingFileName: dup.file_name,
          error: 'File ini sudah pernah disimpan sebelumnya',
        });
      }
    }

    const sessionId = uuidv4();
    const activityId = await activityLogger.logActivity({
      session_id: sessionId,
      file_name,
      original_name: original_name || null,
      source_type: source_type || 'upload',
      source_url: source_url || null,
      file_hash: file_hash || null,
      file_type: file_type || null,
      ocr_status: ocr_status || null,
      page_count: page_count || 0,
      file_size_bytes: file_size_bytes || null,
      duration_seconds: duration_seconds || null,
      status: 'BERHASIL',
      error_message: null,
    });

    if (!activityId) return res.status(500).json({ error: 'Gagal menyimpan ke database' });

    const ok = await activityLogger.uploadTextToDb(activityId, text || '');
    if (!ok) return res.status(500).json({ error: 'Gagal menyimpan teks' });

    res.json({ success: true, activityId, message: 'Data berhasil disimpan ke database' });
  } catch (error) {
    logger.error(`[WEB] Error simpan aktivitas: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/activities/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const activity = await activityLogger.getActivityById(id);
    if (!activity) return res.status(404).json({ error: 'Aktivitas tidak ditemukan' });

    if (activity.file_name) {
      const filePath = path.join(config.outputDir, `${activity.file_name}.txt`);
      await fs.remove(filePath).catch(() => {});
    }

    const ok = await activityLogger.deleteActivity(id);
    if (!ok) return res.status(500).json({ error: 'Gagal menghapus aktivitas' });

    res.json({ success: true, message: 'Aktivitas berhasil dihapus' });
  } catch (error) {
    logger.error(`[WEB] Error hapus aktivitas: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/report/download', async (req, res) => {
  try {
    const { from, to, format } = req.query;
    const data = await activityLogger.getReportData(from || null, to || null);

    if (format === 'xlsx') {
      const wb = await generateXlsxReport(data, from, to);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=laporan.xlsx');
      await wb.xlsx.write(res);
      res.end();
      return;
    }

    const s = data.summary;
    const now = new Date();
    const nowStr = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()} ${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`;

    const DAY = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

    const fmtDate = (d) => {
      if (!d) return '-';
      const dt = new Date(d);
      return `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`;
    };
    const BOM = '\uFEFF';
    const S = ';';

    let csv = BOM;
    csv += '--- LAPORAN KONVERSI DOKUMEN ---\n';
    csv += `Periode${S}${from || 'Semua'} s.d ${to || 'Semua'}\n`;
    csv += `Dibuat${S}${nowStr} WIB\n\n`;

    csv += '--- RINGKASAN ---\n';
    csv += `No${S}Item${S}Jumlah${S}Satuan${S}Keterangan\n`;
    const ringkasan = [
      [1, 'Total Dokumen Diproses', s.total, 'dokumen', 'Seluruh dokumen yang masuk pipeline konversi'],
      [2, 'Berhasil', s.berhasil, 'dokumen', 'Dokumen berhasil dikonversi menjadi teks'],
      [3, 'Gagal', s.gagal, 'dokumen', 'Dokumen gagal diproses (error download atau sistem)'],
      [4, 'Rusak', s.rusak, 'dokumen', 'File PDF corrupt atau tidak bisa dibaca'],
      [5, 'Kosong', s.kosong, 'dokumen', 'File 0 byte atau hasil konversi tidak menghasilkan teks'],
      [6, 'Upload ke Database', s.uploaded, 'dokumen', 'Dokumen yang sudah diupload ke database'],
      [7, 'Belum Upload', s.belum_uploaded, 'dokumen', 'Dokumen berhasil tapi belum diupload ke database'],
      [8, 'Rata-rata Waktu', s.rata_durasi || '-', 'detik', 'Rata-rata waktu yang dibutuhkan per konversi'],
    ];
    for (const r of ringkasan) csv += r.join(S) + '\n';
    csv += '\n';

    csv += '--- KONVERSI PER HARI ---\n';
    csv += `No${S}Tanggal${S}Jumlah${S}Upload ke DB${S}Hari${S}Keterangan\n`;
    data.daily.forEach((d, i) => {
      const tgl = fmtDate(d.tgl);
      const day = DAY[new Date(d.tgl).getDay()];
      csv += `${i + 1}${S}${tgl}${S}${d.jumlah}${S}${d.uploaded}${S}${day}${S}${day} — ${d.jumlah} konversi, ${d.uploaded} diupload\n`;
    });
    csv += '\n';

    csv += '--- DETAIL FILE ---\n';
    csv += `No${S}Nama File${S}Status${S}Upload ke DB${S}Tipe${S}Halaman${S}Durasi (dtk)${S}Sumber${S}Tanggal${S}Keterangan\n`;
    data.details.forEach((d, i) => {
      const uploaded = d.text_uploaded ? 'Ya' : 'Tidak';
      const durasi = d.duration_seconds != null ? String(d.duration_seconds).replace('.', ',') : '-';
      const src = d.source_type === 'url' ? 'URL' : 'Upload';
      const tgl = fmtDate(d.created_at);
      let desc;
      switch (d.status) {
        case 'BERHASIL':
          desc = 'File berhasil dikonversi menjadi teks';
          break;
        case 'GAGAL':
          desc = d.error_message ? `Gagal: ${d.error_message}` : 'Terjadi kesalahan saat pemrosesan';
          break;
        case 'RUSAK':
          desc = d.error_message ? `File rusak: ${d.error_message}` : 'File PDF corrupt atau tidak bisa dibaca';
          break;
        case 'KOSONG':
          desc = 'File 0 byte atau hasil konversi tidak menghasilkan teks';
          break;
        default:
          desc = '-';
      }
      const row = [
        i + 1,
        d.file_name,
        d.status,
        uploaded,
        d.file_type || '-',
        d.page_count || 0,
        durasi,
        src,
        tgl,
        desc,
      ];
      csv += row.join(S) + '\n';
    });

    const csvStr = csv;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=laporan_${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}${now.getFullYear()}.csv`,
    );
    res.send(csvStr);
  } catch (error) {
    logger.error(`[WEB] Error download laporan: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await activityLogger.initDatabase();
    app.listen(PORT, () => {
      console.log(`PDF Converter siap di http://localhost:${PORT}`);
    });
  } catch (error) {
    logger.error(`Gagal start server: ${error.message}`);
    console.error('Gagal start server:', error.message);
    process.exit(1);
  }
}

start();
