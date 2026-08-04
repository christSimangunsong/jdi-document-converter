const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const config = require('./src/config');
const logger = require('./src/services/logger');
const { downloadPdf } = require('./src/services/pdfDownloader');
const { detectPdfType } = require('./src/pdf/detector');
const { extractText } = require('./src/pdf/textExtractor');
const { convertPdfToImages } = require('./src/pdf/imageConverter');
const { performStructuredOcr } = require('./src/services/structureService');
const { cleanText } = require('./src/utils/textCleaner');
const { rebuildDocumentStructure } = require('./src/utils/DocumentStructureRebuilder');
const { runReconstruction } = require('./src/reconstruction');
const { performOcrBlocks } = require('./src/ocr/engine');
const { detectTableRegions } = require('./src/ocr/tableRegionOcr');
const { deskewImage } = require('./src/ocr/deskewRouter');
const { correctOrientation } = require('./src/ocr/orientationDetector');
const activityLogger = require('./src/services/activityLogger');
const { generateXlsxReport } = require('./src/services/reportExporter');

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 200 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// Auto-start sidecar Python (deskew 5002 + table-ocr 5003) saat npm start.
// Gagal/offline sidecar TIDAK menggagalkan server — pipeline punya fallback.
// ---------------------------------------------------------------------------
const _sidecarProcesses = [];

async function _httpAlive(url, timeoutMs = 3000) {
  try {
    await axios.get(url, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

function _waitForHealth(url, timeoutMs = 120000, intervalMs = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(async () => {
      if (await _httpAlive(url, 2000)) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

async function startSidecar(name, script, port) {
  const url = `http://127.0.0.1:${port}/health`;
  if (await _httpAlive(url)) {
    logger.info(`  Sidecar ${name} (port ${port}) sudah berjalan, tidak di-spawn ulang`);
    return;
  }
  logger.info(`  Menjalankan sidecar ${name} (port ${port}): ${config.sidecar.pythonBin} ${script}`);
  const child = spawn(config.sidecar.pythonBin, [script], {
    cwd: __dirname,
    windowsHide: true,
    stdio: 'ignore',
  });
  _sidecarProcesses.push(child);
  child.on('error', (err) => logger.warn(`  Sidecar ${name} gagal dijalankan: ${err.message}`));
  child.on('exit', (code) => logger.warn(`  Sidecar ${name} berhenti (exit ${code})`));
  const ok = await _waitForHealth(url);
  logger.info(
    ok
      ? `  Sidecar ${name} siap di http://127.0.0.1:${port}`
      : `  Sidecar ${name} tidak siap dalam 120 detik — fallback tetap aktif`,
  );
}

async function startSidecars() {
  if (!config.sidecar || !config.sidecar.autostart) return;
  logger.info('Auto-start sidecar (deskew 5002, table-ocr 5003)...');
  const tasks = [];
  if (config.deskew && config.deskew.serviceUrl) {
    tasks.push(startSidecar('deskew', path.join('sidecar', 'run_deskew.py'), 5002));
  }
  if (config.tableAware && config.tableAware.enabled && config.tableAware.serviceUrl) {
    tasks.push(startSidecar('table-ocr', path.join('sidecar', 'table_ocr', 'run_server.py'), 5003));
  }
  await Promise.all(tasks);
}

function stopSidecars() {
  for (const child of _sidecarProcesses) {
    try {
      child.kill();
    } catch {
      /* abaikan */
    }
  }
  _sidecarProcesses.length = 0;
}

process.on('exit', stopSidecars);
process.on('SIGINT', () => {
  stopSidecars();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopSidecars();
  process.exit(0);
});

app.use(express.static('public'));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

async function renderPdfImagesWithTableBoost(pdfBuffer) {
  const { images: lowImages } = await convertPdfToImages(pdfBuffer, { scale: 1.0 });
  const tablePages = new Set();

  if (config.table && config.table.detect !== false) {
    for (let i = 0; i < lowImages.length; i++) {
      let img = lowImages[i];
      try {
        img = await correctOrientation(img);
        img = await deskewImage(img, { skipOsd: true });
      } catch (err) {
        logger.warn(`  Rectify halaman ${i + 1} gagal: ${err.message}, deteksi tanpa koreksi`);
      }
      if (detectTableRegions(img).length > 0) tablePages.add(i + 1);
    }
  }

  const scale = config.pdfRenderScale || 2.0;
  const tableScale = config.table ? config.table.renderScale || 3.0 : 3.0;
  const { images, pageCount } = await convertPdfToImages(pdfBuffer, { scale, tablePages, tableScale });

  if (tablePages.size > 0) {
    logger.info(`  ${tablePages.size} halaman tabel di-render di scale ${tableScale}x (base ${scale}x)`);
  }

  return { images, pageCount, tablePages };
}

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

  // Progress dengan fase (nama fase + halaman) — dikonsumsi batch SSE route.
  const progress = (pct, phase, extra) => {
    if (onProgress) onProgress({ pct, phase, ...extra });
  };

  try {
    if (pdfBuffer.length === 0) {
      result.status = 'KOSONG';
      result.errorMessage = 'File PDF kosong (0 byte)';
      logger.warn(`  File kosong: ${fileName}`);
      if (onProgress) progress(1, 'Selesai');
    } else {
      const detection = await detectPdfType(pdfBuffer);
      result.type = detection.type;
      result.pageCount = detection.pageCount;
      if (onProgress) progress(0.05, 'Analisis PDF');

      if (config.reconstruction && config.reconstruction.enabled) {
        let ocrBlocks = [];
        if (detection.type !== 'TEXT') {
          const { images, pageCount: imgPageCount } = await renderPdfImagesWithTableBoost(pdfBuffer);
          result.pageCount = imgPageCount;
          if (onProgress) progress(0.1, 'Render halaman PDF');
          ocrBlocks = await performOcrBlocks(images, (page, total) => {
            if (onProgress) {
              progress(0.1 + (page / total) * 0.4, `OCR halaman ${page}/${total}`, { page, totalPages: total });
            }
          });
          result.ocrStatus = 'BERHASIL';
        }
        if (onProgress) progress(0.55, 'Membangun struktur dokumen');

        const doc = await runReconstruction(pdfBuffer, ocrBlocks, {
          onProgress: (pct, msg) => {
            if (onProgress) progress(0.55 + pct * 0.4, msg || 'Reconstruction');
          },
          ocrEngine: config.ocr ? config.ocr.engine : 'paddle',
        });
        const reviewData = doc.review
          ? {
            score: doc.review.score,
            issueCount: doc.review.issueCount,
            issues: doc.review.issues.slice(0, 10),
          }
          : null;
        result.text = doc.markdown;
        result.reconstruction = {
          chunks: doc.chunks ? doc.chunks.length : 0,
          sections: doc.sections ? doc.sections.length : 0,
          html: doc.html,
          json: doc.semanticJson,
          duration: doc.metadata ? doc.metadata.duration : null,
          review: reviewData,
        };

        // Tulis cache file .txt (DB = sumber utama v29.5; file dihapus saat save)
        if (!result.text.trim()) {
          result.status = 'KOSONG';
          result.errorMessage = 'Hasil konversi kosong — file mungkin rusak atau tidak terbaca';
        } else {
          const outputFileName = `${fileName}.txt`;
          const outputPath = path.join(config.outputDir, outputFileName);
          await fs.writeFile(outputPath, result.text, 'utf-8');
          result.outputFile = outputFileName;
        }

        if (onProgress) progress(0.95, 'Menyiapkan output');
      } else {
        if (detection.type === 'TEXT') {
          const extracted = await extractText(pdfBuffer);
          result.pageCount = extracted.pageCount;
          result.ocrStatus = 'TIDAK DIPERLUKAN';
          result.text = extracted.text;
          if (onProgress) progress(0.85, 'Ekstrak teks digital');
        } else {
          const { images, pageCount } = await renderPdfImagesWithTableBoost(pdfBuffer);
          result.pageCount = pageCount;
          if (onProgress) progress(0.15, 'Render halaman PDF');

          const ocrResults = await performStructuredOcr(images, (page, total) => {
            if (onProgress) {
              progress(0.15 + (page / total) * 0.7, `OCR halaman ${page}/${total}`, { page, totalPages: total });
            }
          });
          result.text = ocrResults.join('\n\n');
          result.ocrStatus = 'BERHASIL';
          if (ocrResults.pageQuality) {
            const lowPages = ocrResults.pageQuality.filter((p) => p.lowQuality).map((p) => p.page);
            if (lowPages.length > 0) {
              logger.warn(`  ${lowPages.length} halaman kualitas rendah (LOW QUALITY): ${lowPages.join(', ')}`);
              result.text += `\n\n[CATATAN: ${lowPages.length} halaman (${lowPages.join(', ')}) berkualitas rendah — LOW QUALITY, periksa hasil OCR]`;
            }
          }
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

        if (onProgress) progress(0.95, 'Menyiapkan output');
      }
    }
  } catch (error) {
    result.status = 'RUSAK';
    result.errorMessage = error.message;
    logger.warn(`  File rusak: ${fileName} — ${error.message}`);
  }

  result.durasi = ((Date.now() - startTime) / 1000).toFixed(1) + ' dtk';
  if (onProgress) progress(1, 'Selesai');

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

      const fileName = extractFileNameFromUrl(url);
      const sendProgress = (pct, phase, extra) => {
        send('progress', {
          pct,
          fileIndex: i + 1,
          totalFiles: n,
          fileName,
          phase,
          ...extra,
        });
      };

      sendProgress(Math.round(basePct), 'Menunggu antrian');

      try {
        logger.info(`[WEB Batch ${i + 1}/${n}] Memproses URL: ${url}`);
        const pdfBuffer = await downloadPdf(url);
        sendProgress(Math.round(basePct + filePct * 0.1), 'Mengunduh PDF');

        const fileHash = computeHash(pdfBuffer);
        sendProgress(Math.round(basePct + filePct * 0.15), 'Memeriksa file');

        const result = await processBuffer(
          pdfBuffer,
          fileName,
          {
            sourceType: 'url',
            sourceUrl: url,
            originalName: fileName,
            fileHash,
          },
          (inner) => {
            const num = typeof inner === 'number' ? inner : inner.pct;
            const pct = basePct + filePct * (0.15 + num * 0.85);
            sendProgress(
              Math.min(Math.round(pct), Math.round(basePct + filePct)),
              typeof inner === 'object' && inner.phase ? inner.phase : undefined,
              typeof inner === 'object'
                ? { page: inner.page, totalPages: inner.totalPages }
                : {},
            );
          },
        );
        result.index = i;
        sendProgress(Math.round(basePct + filePct), 'Menyimpan hasil');
        send('result', result);
        logger.info(`[WEB Batch ${i + 1}/${n}] Selesai: ${url}`);
      } catch (error) {
        logger.error(`[WEB Batch ${i + 1}/${n}] Error: ${url} - ${error.message}`);
        sendProgress(Math.round(basePct + filePct), 'Gagal');
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

      const sendProgress = (pct, phase, extra) => {
        send('progress', {
          pct,
          fileIndex: i + 1,
          totalFiles: n,
          fileName,
          phase,
          ...extra,
        });
      };

      sendProgress(Math.round(basePct), 'Menunggu antrian');

      try {
        const pdfBuffer = await fs.readFile(file.path);
        sendProgress(Math.round(basePct + filePct * 0.1), 'Membaca file upload');

        const fileHash = computeHash(pdfBuffer);
        sendProgress(Math.round(basePct + filePct * 0.15), 'Memeriksa file');

        logger.info(`[WEB Batch ${i + 1}/${n}] Memproses file: ${file.originalname}`);
        const result = await processBuffer(
          pdfBuffer,
          fileName,
          {
            sourceType: 'upload',
            originalName: file.originalname,
            fileHash,
          },
          (inner) => {
            const num = typeof inner === 'number' ? inner : inner.pct;
            const pct = basePct + filePct * (0.15 + num * 0.85);
            sendProgress(
              Math.min(Math.round(pct), Math.round(basePct + filePct)),
              typeof inner === 'object' && inner.phase ? inner.phase : undefined,
              typeof inner === 'object'
                ? { page: inner.page, totalPages: inner.totalPages }
                : {},
            );
          },
        );
        result.index = i;
        result.originalName = file.originalname;
        sendProgress(Math.round(basePct + filePct), 'Menyimpan hasil');
        send('result', result);
        logger.info(`[WEB Batch ${i + 1}/${n}] Selesai: ${file.originalname}`);
      } catch (error) {
        logger.error(`[WEB Batch ${i + 1}/${n}] Error: ${file.originalname} - ${error.message}`);
        sendProgress(Math.round(basePct + filePct), 'Gagal');
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

// ---------------------------------------------------------------------------
// Pembersihan cache output/ — DB adalah sumber utama (v29.5), file hanya
// cache kerja: hapus file yang sudah tersimpan di DB + file stale tua.
// ---------------------------------------------------------------------------
async function cleanupOutputDir() {
  try {
    await fs.ensureDir(config.outputDir);
    const files = await fs.readdir(config.outputDir);
    const maxAgeMs = config.outputCleanup.maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let removed = 0;

    for (const name of files) {
      if (!/\.(txt|md)$/i.test(name)) continue;
      const filePath = path.join(config.outputDir, name);
      try {
        const stat = await fs.stat(filePath);
        // File yang baru ditulis (<10 mnt) dilewati — hindari race saat konversi aktif
        if (now - stat.mtimeMs < 10 * 60 * 1000) continue;

        const base = name.replace(/\.(txt|md)$/i, '');
        const inDb = await activityLogger.getByFileName(base);
        const tooOld = now - stat.mtimeMs > maxAgeMs;

        if (inDb || tooOld) {
          await fs.remove(filePath);
          removed++;
          logger.info(
            `[Cleanup] Hapus ${name} (${inDb ? 'sudah tersimpan di DB' : `stale > ${config.outputCleanup.maxAgeDays} hari`})`,
          );
        }
      } catch (err) {
        logger.warn(`[Cleanup] Gagal proses ${name}: ${err.message}`);
      }
    }

    if (removed > 0) logger.info(`[Cleanup] ${removed} file dibersihkan dari ${config.outputDir}`);
  } catch (error) {
    logger.error(`[Cleanup] Gagal cleanup output: ${error.message}`);
  }
}

app.get('/download/:file', async (req, res) => {
  const filePath = path.join(config.outputDir, req.params.file);
  if (await fs.pathExists(filePath)) {
    return res.download(filePath);
  }
  // File cache sudah dihapus (tersimpan di DB) — layani dari database
  const base = req.params.file.replace(/\.(txt|md)$/i, '');
  const activity = await activityLogger.getByFileName(base);
  if (activity && activity.output_text) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(req.params.file)}`);
    return res.send(activity.output_text);
  }
  res.status(404).json({ error: 'File tidak ditemukan' });
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

    // File cache dihapus — data kini aman di DB (DB = sumber utama, v29.5)
    if (file_name) {
      const cachePath = path.join(config.outputDir, `${file_name}.txt`);
      if (await fs.pathExists(cachePath)) {
        await fs.remove(cachePath).catch(() => {});
        logger.info(`[Save] File cache dihapus: ${file_name}.txt`);
      }
    }

    res.json({ success: true, activityId, message: 'Data berhasil disimpan ke database' });
  } catch (error) {
    const msg = error?.message || error || 'Unknown error';
    logger.error(`[WEB] Error simpan aktivitas: ${msg}`);
    res.status(500).json({ error: msg });
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

app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request terlalu besar', detail: err.message });
  }
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await activityLogger.initDatabase();
    // Pembersihan cache output/ saat startup + berkala (DB = sumber utama)
    await cleanupOutputDir();
    setInterval(() => cleanupOutputDir().catch(() => {}), config.outputCleanup.intervalMs);
    // Sidecar di-start async (tidak memblokir server); fallback tetap aktif
    // jika gagal/offline.
    startSidecars().catch((err) => logger.warn(`Auto-start sidecar gagal: ${err.message}`));
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
