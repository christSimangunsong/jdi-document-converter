const fs = require('fs-extra');
const path = require('path');
const cliProgress = require('cli-progress');

const config = require('./src/config');
const logger = require('./src/services/logger');
const { downloadPdf } = require('./src/services/pdfDownloader');
const { generateReport } = require('./src/services/reportGenerator');
const { detectPdfType } = require('./src/pdf/detector');
const { extractText } = require('./src/pdf/textExtractor');
const { convertPdfToImages } = require('./src/pdf/imageConverter');
const { performOcr } = require('./src/ocr/engine');
const { cleanText } = require('./src/utils/textCleaner');

fs.ensureDirSync(config.outputDir);
fs.ensureDirSync(config.logDir);

async function processSingleFile(entry) {
  const startTime = Date.now();
  const result = {
    id: entry.id,
    nama: entry.nama,
    halaman: 0,
    jenis: '-',
    ocrStatus: 'TIDAK DIPROSES',
    durasi: '-',
    output: '',
    status: 'GAGAL',
    error: '',
  };

  try {
    logger.info(`>>> Memproses: ${entry.nama}`);
    logger.info(`    URL: ${entry.url}`);

    logger.info('  [1/4] Mendownload PDF...');
    const pdfBuffer = await downloadPdf(entry.url);
    logger.info(`  Download selesai (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);

    logger.info('  [2/4] Mendeteksi jenis PDF...');
    const detection = await detectPdfType(pdfBuffer);

    result.jenis = detection.type;
    result.halaman = detection.pageCount;

    let fullText = '';

    if (detection.type === 'TEXT') {
      logger.info('  [3/4] Mengekstrak teks dari PDF...');
      const extracted = await extractText(pdfBuffer);
      fullText = extracted.text;
      result.halaman = extracted.pageCount;
      result.ocrStatus = 'TIDAK DIPERLUKAN';
    } else {
      logger.info('  [3/4] Mengkonversi PDF ke gambar...');
      const { images, pageCount } = await convertPdfToImages(pdfBuffer);
      result.halaman = pageCount;

      logger.info('  [4/4] Menjalankan OCR...');
      const ocrResults = await performOcr(images);
      fullText = ocrResults.join('\n\n');
      result.ocrStatus = 'BERHASIL';
    }

    logger.info('  Membersihkan teks...');
    const cleanedText = cleanText(fullText);

    const outputFileName = `${entry.nama}.txt`;
    const outputPath = path.join(config.outputDir, outputFileName);
    fs.writeFileSync(outputPath, cleanedText, 'utf-8');

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    result.durasi = `${duration} detik`;
    result.output = outputPath;
    result.status = 'BERHASIL';

    logger.info(`  Teks disimpan ke: ${outputPath}`);
    logger.info(`>>> Selesai: ${entry.nama} (${duration} detik)`);
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    result.durasi = `${duration} detik`;
    result.error = error.message;
    result.status = 'GAGAL';

    logger.error(`!!! GAGAL: ${entry.nama} - ${error.message}`);
  }

  return result;
}

async function main() {
  console.log('');
  console.log('====================================================');
  console.log('    JDIH DOCUMENT CONVERTER');
  console.log('    PDF to Text Converter untuk Sistem AI JDIH');
  console.log('====================================================');
  console.log('');

  logger.info('Aplikasi dimulai');

  const linksPath = config.linksPath;
  if (!fs.existsSync(linksPath)) {
    logger.error(`File links.json tidak ditemukan di ${linksPath}`);
    logger.info('Buat file data/links.json dengan daftar URL PDF');
    process.exit(1);
  }

  const links = fs.readJsonSync(linksPath);

  if (!links || links.length === 0) {
    logger.warn('Tidak ada link PDF yang ditemukan di links.json');
    process.exit(0);
  }

  logger.info(`Ditemukan ${links.length} file PDF untuk diproses`);

  const progressBar = new cliProgress.SingleBar({
    format: 'Progress |{bar}| {percentage}% | {value}/{total} file',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
  });

  progressBar.start(links.length, 0);

  const results = [];

  for (let i = 0; i < links.length; i++) {
    const entry = links[i];
    const result = await processSingleFile(entry);
    results.push(result);
    progressBar.update(i + 1);
  }

  progressBar.stop();

  generateReport(results);

  logger.info('Aplikasi selesai');
  console.log('');
}

main().catch((error) => {
  logger.error(`FATAL: ${error.message}`);
  console.error(error);
  process.exit(1);
});
