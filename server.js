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
const { cleanText } = require('./src/utils/textCleaner');
const { rebuildDocumentStructure } = require('./src/utils/DocumentStructureRebuilder');
const activityLogger = require('./src/services/activityLogger');

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
    return decoded.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9 _-]/g, '_').substring(0, 200);
  } catch {
    return 'doc_' + Date.now();
  }
}

function computeHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function processBuffer(pdfBuffer, fileName, sourceInfo) {
  const sessionId = sourceInfo.sessionId;
  const result = {
    text: '',
    pageCount: 0,
    type: null,
    ocrStatus: 'TIDAK DIPROSES',
    outputFile: '',
    status: 'BERHASIL',
    errorMessage: null,
    activityId: null,
    durasi: '0.0 dtk',
    fileSizeBytes: pdfBuffer.length,
  };

  const startTime = Date.now();

  try {
    if (pdfBuffer.length === 0) {
      result.status = 'KOSONG';
      result.errorMessage = 'File PDF kosong (0 byte)';
      logger.warn(`  File kosong: ${fileName}`);
    } else {
      const detection = await detectPdfType(pdfBuffer);
      result.type = detection.type;
      result.pageCount = detection.pageCount;

      if (detection.type === 'TEXT') {
        const extracted = await extractText(pdfBuffer);
        result.pageCount = extracted.pageCount;
        result.ocrStatus = 'TIDAK DIPERLUKAN';
        result.text = extracted.text;
      } else {
        const { images, pageCount } = await convertPdfToImages(pdfBuffer);
        result.pageCount = pageCount;
        const ocrResults = await performOcr(images);
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
    }
  } catch (error) {
    result.status = 'RUSAK';
    result.errorMessage = error.message;
    logger.warn(`  File rusak: ${fileName} — ${error.message}`);
  }

  result.durasi = ((Date.now() - startTime) / 1000).toFixed(1) + ' dtk';

  result.activityId = await activityLogger.logActivity({
    session_id: sessionId,
    file_name: fileName,
    original_name: sourceInfo.originalName || null,
    source_type: sourceInfo.sourceType,
    source_url: sourceInfo.sourceUrl || null,
    file_hash: sourceInfo.fileHash || null,
    file_type: result.type,
    ocr_status: result.ocrStatus,
    page_count: result.pageCount,
    file_size_bytes: result.fileSizeBytes,
    duration_seconds: parseFloat(result.durasi),
    status: result.status,
    error_message: result.errorMessage,
  });

  return result;
}

app.post('/process-url', async (req, res) => {
  try {
    const { url, nama } = req.body;
    if (!url) return res.status(400).json({ error: 'URL PDF diperlukan' });

    const fileName = nama || extractFileNameFromUrl(url);
    const sessionId = uuidv4();

    const dupUrl = await activityLogger.checkDuplicateByUrl(url);
    if (dupUrl) {
      return res.json({ status: 'DUPLICATE', duplicate: true, existingId: dupUrl.id, existingFileName: dupUrl.file_name, error: 'URL ini sudah pernah diproses' });
    }

    logger.info(`[WEB] Memproses URL: ${url}`);
    const pdfBuffer = await downloadPdf(url);
    const fileHash = computeHash(pdfBuffer);

    const dupHash = await activityLogger.checkDuplicateByHash(fileHash);
    if (dupHash) {
      return res.json({ status: 'DUPLICATE', duplicate: true, existingId: dupHash.id, existingFileName: dupHash.file_name, error: 'File PDF ini sudah pernah diproses (hash sama)' });
    }

    const result = await processBuffer(pdfBuffer, fileName, {
      sessionId,
      sourceType: 'url',
      sourceUrl: url,
      originalName: fileName,
      fileHash,
    });

    logger.info(`[WEB] Selesai: ${url} (${result.durasi})`);
    res.json(result);
  } catch (error) {
    logger.error(`[WEB] Error URL: ${error.message}`);
    const sessionId = uuidv4();
    const fileName = req.body.nama || (req.body.url ? extractFileNameFromUrl(req.body.url) : 'doc_' + Date.now());
    const aid = await activityLogger.logActivity({
      session_id: sessionId,
      file_name: fileName,
      original_name: fileName,
      source_type: 'url',
      source_url: req.body.url || null,
      file_hash: null,
      file_type: null, ocr_status: null,
      page_count: 0, file_size_bytes: null, duration_seconds: null,
      status: 'GAGAL',
      error_message: error.message,
    });
    res.json({ status: 'GAGAL', error: error.message, durasi: '0.0 dtk', activityId: aid, fileName: fileName });
  }
});

app.post('/process-urls', async (req, res) => {
  try {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'Array URL diperlukan' });
    }

    const results = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i].trim();
      if (!url) continue;

      const fileName = extractFileNameFromUrl(url);
      const sessionId = uuidv4();

      const dupUrl = await activityLogger.checkDuplicateByUrl(url);
      if (dupUrl) {
        results.push({ index: i, url, status: 'DUPLICATE', duplicate: true, existingId: dupUrl.id, existingFileName: dupUrl.file_name, error: 'URL ini sudah pernah diproses' });
        continue;
      }

      try {
        logger.info(`[WEB Batch ${i + 1}/${urls.length}] Memproses URL: ${url}`);
        const pdfBuffer = await downloadPdf(url);
        const fileHash = computeHash(pdfBuffer);

        const dupHash = await activityLogger.checkDuplicateByHash(fileHash);
        if (dupHash) {
          results.push({ index: i, url, status: 'DUPLICATE', duplicate: true, existingId: dupHash.id, existingFileName: dupHash.file_name, error: 'File PDF ini sudah pernah diproses (hash sama)' });
          continue;
        }

        const result = await processBuffer(pdfBuffer, fileName, {
          sessionId,
          sourceType: 'url',
          sourceUrl: url,
          originalName: fileName,
          fileHash,
        });
        result.index = i;
        results.push(result);
        logger.info(`[WEB Batch ${i + 1}/${urls.length}] Selesai: ${url}`);
      } catch (error) {
        logger.error(`[WEB Batch ${i + 1}/${urls.length}] Error: ${url} - ${error.message}`);
        const aid = await activityLogger.logActivity({
          session_id: sessionId,
          file_name: fileName,
          original_name: fileName,
          source_type: 'url',
          source_url: url,
          file_hash: null,
          file_type: null, ocr_status: null,
          page_count: 0, file_size_bytes: null, duration_seconds: null,
          status: 'GAGAL',
          error_message: error.message,
        });
        results.push({
          index: i, url, status: 'GAGAL', error: error.message,
          durasi: '0.0 dtk', activityId: aid,
        });
      }
    }

    res.json({ results });
  } catch (error) {
    logger.error(`[WEB] Error batch URL: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/process-upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File PDF diperlukan' });

    const fileName = req.body.nama || path.parse(req.file.originalname).name;
    const sessionId = uuidv4();

    logger.info(`[WEB] Memproses file: ${req.file.originalname}`);
    const pdfBuffer = await fs.readFile(req.file.path);
    const fileHash = computeHash(pdfBuffer);

    const dupHash = await activityLogger.checkDuplicateByHash(fileHash);
    if (dupHash) {
      await fs.remove(req.file.path).catch(() => {});
      return res.json({ status: 'DUPLICATE', duplicate: true, existingId: dupHash.id, existingFileName: dupHash.file_name, error: 'File PDF ini sudah pernah diproses (hash sama)' });
    }

    const result = await processBuffer(pdfBuffer, fileName, {
      sessionId,
      sourceType: 'upload',
      originalName: req.file.originalname,
      fileHash,
    });

    await fs.remove(req.file.path);
    logger.info(`[WEB] Selesai: ${req.file.originalname} (${result.durasi})`);
    res.json(result);
  } catch (error) {
    logger.error(`[WEB] Error upload: ${error.message}`);
    const sessionId = uuidv4();
    const origName = req.file ? req.file.originalname : 'unknown';
    const fileName = req.file ? (req.body.nama || path.parse(req.file.originalname).name) : 'unknown';
    const aid = await activityLogger.logActivity({
      session_id: sessionId,
      file_name: fileName,
      original_name: origName,
      source_type: 'upload',
      source_url: null,
      file_hash: null,
      file_type: null, ocr_status: null,
      page_count: 0, file_size_bytes: null, duration_seconds: null,
      status: 'GAGAL',
      error_message: error.message,
    });
    if (req.file) await fs.remove(req.file.path).catch(() => {});
    res.json({ status: 'GAGAL', error: error.message, durasi: '0.0 dtk', activityId: aid, fileName: fileName });
  }
});

app.post('/process-uploads', upload.array('pdf', 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'File PDF diperlukan' });
    }

    const results = [];
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const fileName = path.parse(file.originalname).name;
      const sessionId = uuidv4();

      const pdfBuffer = await fs.readFile(file.path);
      const fileHash = computeHash(pdfBuffer);

      const dupHash = await activityLogger.checkDuplicateByHash(fileHash);
      if (dupHash) {
        await fs.remove(file.path).catch(() => {});
        results.push({ index: i, originalName: file.originalname, status: 'DUPLICATE', duplicate: true, existingId: dupHash.id, existingFileName: dupHash.file_name, error: 'File PDF ini sudah pernah diproses (hash sama)' });
        continue;
      }

      try {
        logger.info(`[WEB Batch ${i + 1}/${req.files.length}] Memproses file: ${file.originalname}`);
        const result = await processBuffer(pdfBuffer, fileName, {
          sessionId,
          sourceType: 'upload',
          originalName: file.originalname,
          fileHash,
        });
        result.index = i;
        result.originalName = file.originalname;
        results.push(result);
        logger.info(`[WEB Batch ${i + 1}/${req.files.length}] Selesai: ${file.originalname}`);
      } catch (error) {
        logger.error(`[WEB Batch ${i + 1}/${req.files.length}] Error: ${file.originalname} - ${error.message}`);
        const aid = await activityLogger.logActivity({
          session_id: sessionId,
          file_name: fileName,
          original_name: file.originalname,
          source_type: 'upload',
          source_url: null,
          file_hash: null,
          file_type: null, ocr_status: null,
          page_count: 0, file_size_bytes: null, duration_seconds: null,
          status: 'GAGAL',
          error_message: error.message,
        });
        results.push({
          index: i, originalName: file.originalname, status: 'GAGAL', error: error.message,
          durasi: '0.0 dtk', activityId: aid,
        });
      }

      await fs.remove(file.path);
    }

    res.json({ results });
  } catch (error) {
    logger.error(`[WEB] Error batch upload: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get('/download/:file', async (req, res) => {
  const filePath = path.join(config.outputDir, req.params.file);
  if (!await fs.pathExists(filePath)) {
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

app.put('/api/activities/:id/upload', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const activity = await activityLogger.getActivityById(id);
    if (!activity) return res.status(404).json({ error: 'Aktivitas tidak ditemukan' });

    if (activity.text_uploaded) {
      return res.json({ success: true, message: 'Teks sudah diupload sebelumnya' });
    }

    const dup = await activityLogger.checkDuplicateUpload(activity);
    if (dup) {
      return res.json({ duplicate: true, existingId: dup.id, existingFileName: dup.file_name, error: 'Teks untuk file ini sudah pernah diupload dari aktivitas lain' });
    }

    const filePath = path.join(config.outputDir, `${activity.file_name}.txt`);
    let text = '';
    if (await fs.pathExists(filePath)) {
      text = await fs.readFile(filePath, 'utf-8');
    } else {
      return res.status(404).json({ error: 'File teks tidak ditemukan di disk' });
    }

    const ok = await activityLogger.uploadTextToDb(id, text);
    if (!ok) return res.status(500).json({ error: 'Gagal menyimpan teks ke database' });

    res.json({ success: true, message: 'Teks berhasil diupload ke database' });
  } catch (error) {
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
