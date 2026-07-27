const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');

const config = require('./src/config');
const logger = require('./src/services/logger');
const { downloadPdf } = require('./src/services/pdfDownloader');
const { detectPdfType } = require('./src/pdf/detector');
const { extractText } = require('./src/pdf/textExtractor');
const { convertPdfToImages } = require('./src/pdf/imageConverter');
const { performOcr } = require('./src/ocr/engine');
const { cleanText } = require('./src/utils/textCleaner');
const { rebuildDocumentStructure } = require('./src/utils/DocumentStructureRebuilder');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function processBuffer(pdfBuffer, fileName) {
  const detection = await detectPdfType(pdfBuffer);
  let fullText = '';
  let ocrStatus = 'TIDAK DIPROSES';
  let pageCount = detection.pageCount;

  if (detection.type === 'TEXT') {
    const extracted = await extractText(pdfBuffer);
    fullText = extracted.text;
    pageCount = extracted.pageCount;
    ocrStatus = 'TIDAK DIPERLUKAN';
  } else {
    const { images, pageCount: pc } = await convertPdfToImages(pdfBuffer);
    pageCount = pc;
    const ocrResults = await performOcr(images);
    fullText = ocrResults.join('\n\n');
    ocrStatus = 'BERHASIL';
  }

  const cleanedText = cleanText(fullText);
  const structuredText = rebuildDocumentStructure(cleanedText);

  const outputFileName = `${fileName}.txt`;
  const outputPath = path.join(config.outputDir, outputFileName);
  await fs.writeFile(outputPath, structuredText, 'utf-8');

  return { text: structuredText, pageCount, type: detection.type, ocrStatus, outputFile: outputFileName };
}

app.post('/process-url', async (req, res) => {
  try {
    const { url, nama } = req.body;
    if (!url) return res.status(400).json({ error: 'URL PDF diperlukan' });

    const fileName = nama || `doc_${Date.now()}`;
    const startTime = Date.now();

    logger.info(`[WEB] Memproses URL: ${url}`);
    const pdfBuffer = await downloadPdf(url);
    const result = await processBuffer(pdfBuffer, fileName);
    result.durasi = ((Date.now() - startTime) / 1000).toFixed(1) + ' dtk';

    logger.info(`[WEB] Selesai: ${url} (${result.durasi})`);
    res.json(result);
  } catch (error) {
    logger.error(`[WEB] Error URL: ${error.message}`);
    res.status(500).json({ error: error.message });
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

      const fileName = `doc_${Date.now()}_${i}`;
      const startTime = Date.now();
      const entry = { index: i, url, status: 'GAGAL', error: '' };

      try {
        logger.info(`[WEB Batch ${i + 1}/${urls.length}] Memproses URL: ${url}`);
        const pdfBuffer = await downloadPdf(url);
        const result = await processBuffer(pdfBuffer, fileName);
        result.durasi = ((Date.now() - startTime) / 1000).toFixed(1) + ' dtk';
        result.index = i;
        result.status = 'BERHASIL';
        results.push(result);
        logger.info(`[WEB Batch ${i + 1}/${urls.length}] Selesai: ${url}`);
      } catch (error) {
        logger.error(`[WEB Batch ${i + 1}/${urls.length}] Error: ${url} - ${error.message}`);
        results.push({ index: i, url, status: 'GAGAL', error: error.message, durasi: ((Date.now() - startTime) / 1000).toFixed(1) + ' dtk' });
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
    const startTime = Date.now();

    logger.info(`[WEB] Memproses file: ${req.file.originalname}`);
    const pdfBuffer = await fs.readFile(req.file.path);
    const result = await processBuffer(pdfBuffer, fileName);
    result.durasi = ((Date.now() - startTime) / 1000).toFixed(1) + ' dtk';

    await fs.remove(req.file.path);
    logger.info(`[WEB] Selesai: ${req.file.originalname} (${result.durasi})`);
    res.json(result);
  } catch (error) {
    logger.error(`[WEB] Error upload: ${error.message}`);
    res.status(500).json({ error: error.message });
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
      const startTime = Date.now();
      const entry = { index: i, originalName: file.originalname, status: 'GAGAL', error: '' };

      try {
        logger.info(`[WEB Batch ${i + 1}/${req.files.length}] Memproses file: ${file.originalname}`);
        const pdfBuffer = await fs.readFile(file.path);
        const result = await processBuffer(pdfBuffer, fileName);
        result.durasi = ((Date.now() - startTime) / 1000).toFixed(1) + ' dtk';
        result.index = i;
        result.originalName = file.originalname;
        result.status = 'BERHASIL';
        results.push(result);
        logger.info(`[WEB Batch ${i + 1}/${req.files.length}] Selesai: ${file.originalname}`);
      } catch (error) {
        logger.error(`[WEB Batch ${i + 1}/${req.files.length}] Error: ${file.originalname} - ${error.message}`);
        results.push({ index: i, originalName: file.originalname, status: 'GAGAL', error: error.message, durasi: ((Date.now() - startTime) / 1000).toFixed(1) + ' dtk' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PDF Converter siap di http://localhost:${PORT}`);
});
