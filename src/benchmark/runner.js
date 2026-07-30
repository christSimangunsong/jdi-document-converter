const fs = require('fs-extra');
const path = require('path');
const { ocrRouter } = require('../ocr/router');
const { computeAllMetrics } = require('./metrics');
const { generateReport } = require('./reporter');
const logger = require('../services/logger');
const { convertPdfToImages } = require('../pdf/imageConverter');

async function runBenchmark(options = {}) {
  const testDir = options.testDir || './benchmark/test-set';
  const engineNames = options.engines || ['paddle', 'tesseract', 'surya'];
  const outputDir = options.outputDir || './benchmark/results';
  const lang = options.lang || 'id';

  fs.ensureDirSync(outputDir);

  logger.info('========================================');
  logger.info('  BENCHMARK OCR ENGINE');
  logger.info(`  Test set: ${testDir}`);
  logger.info(`  Engines: ${engineNames.join(', ')}`);
  logger.info('========================================');

  const testFiles = await loadTestSet(testDir);
  if (testFiles.length === 0) {
    logger.error(`Tidak ada file test ditemukan di ${testDir}`);
    logger.info('Format: setiap dokumen membutuhkan pasangan .pdf dan .gt.txt (ground truth)');
    return;
  }

  logger.info(`Ditemukan ${testFiles.length} dokumen test\n`);

  const engines = [];
  for (const name of engineNames) {
    try {
      const eng = await ocrRouter.loadEngines([name], {
        lang,
        engine: name,
        serviceUrl: options.suryaUrl,
        timeout: options.timeout || 120000,
      });
      if (eng.length > 0) {
        engines.push(eng[0]);
        logger.info(`  Engine "${name}" siap\n`);
      }
    } catch (err) {
      logger.warn(`  Engine "${name}" gagal dimuat: ${err.message}\n`);
    }
  }

  if (engines.length === 0) {
    logger.error('Tidak ada engine yang bisa diuji');
    return;
  }

  const allResults = [];

  for (const doc of testFiles) {
    logger.info(`\n--- Dokumen: ${doc.name} ---`);

    let images;
    try {
      const pdfBuffer = await fs.readFile(doc.pdfPath);
      const result = await convertPdfToImages(pdfBuffer);
      images = result.images;
    } catch (err) {
      logger.error(`  Gagal render PDF: ${err.message}`);
      continue;
    }

    const groundTruth = await fs.readFile(doc.gtPath, 'utf-8').catch(() => '');

    const docResults = { name: doc.name, engines: [] };

    for (const engine of engines) {
      const meta = engine.getMetadata();
      logger.info(`  [${meta.name}] Memproses ${images.length} halaman...`);

      const startTime = Date.now();

      try {
        const texts = await ocrRouter.performOcrWithEngine(engine, images);
        const fullText = texts.join('\n\n');
        const durationMs = Date.now() - startTime;

        const blocks = [];
        for (let i = 0; i < texts.length; i++) {
          blocks.push({ text: texts[i], confidence: 0, bbox: null, page: i + 1 });
        }

        const engineResult = { text: fullText, blocks };
        const metrics = computeAllMetrics(engineResult, groundTruth, durationMs, images.length);

        docResults.engines.push({
          name: meta.name,
          type: meta.type,
          text: fullText,
          metrics,
        });

        logger.info(`    CER: ${(metrics.cer * 100).toFixed(1)}% | WER: ${(metrics.wer * 100).toFixed(1)}% | ${metrics.durationMs}ms`);
      } catch (err) {
        logger.error(`  [${meta.name}] Gagal: ${err.message}`);
        docResults.engines.push({
          name: meta.name,
          type: meta.type,
          text: '',
          metrics: null,
          error: err.message,
        });
      }
    }

    allResults.push(docResults);
  }

  logger.info('\n========================================');
  logger.info('  BENCHMARK SELESAI');
  logger.info('========================================\n');

  const reportPath = path.join(outputDir, 'benchmark-report.html');
  const jsonPath = path.join(outputDir, 'benchmark-report.json');

  await generateReport(allResults, outputDir);

  logger.info(`Laporan HTML: ${reportPath}`);
  logger.info(`Data JSON: ${jsonPath}`);

  printSummary(allResults);

  return allResults;
}

async function loadTestSet(testDir) {
  const files = await fs.readdir(testDir).catch(() => []);
  const pdfs = files.filter((f) => f.endsWith('.pdf'));
  const testFiles = [];

  for (const pdf of pdfs) {
    const baseName = path.basename(pdf, '.pdf');
    const gtPath = path.join(testDir, `${baseName}.gt.txt`);
    const gtExists = await fs.pathExists(gtPath);

    if (gtExists) {
      testFiles.push({
        name: baseName,
        pdfPath: path.join(testDir, pdf),
        gtPath,
      });
    } else {
      logger.warn(`  ${baseName}: ground truth (.gt.txt) tidak ditemukan, dilewati`);
    }
  }

  return testFiles;
}

function printSummary(allResults) {
  console.log('\n--- RINGKASAN BENCHMARK ---\n');

  const engineNames = [...new Set(allResults.flatMap((d) => d.engines.map((e) => e.name)))];

  const header = `Dokumen\t\t${engineNames.map((n) => `${n}\t\t`).join('')}`;
  console.log(header);

  for (const doc of allResults) {
    const parts = [doc.name.padEnd(16)];
    for (const ename of engineNames) {
      const eres = doc.engines.find((e) => e.name === ename);
      if (eres && eres.metrics) {
        const cer = (eres.metrics.cer * 100).toFixed(1);
        parts.push(`CER ${cer}%\t`);
      } else {
        parts.push(`FAIL\t\t`);
      }
    }
    console.log(parts.join(''));
  }

  console.log('\n--- RATA-RATA ---');
  for (const ename of engineNames) {
    const metrics = allResults.flatMap((d) => {
      const e = d.engines.find((x) => x.name === ename);
      return e && e.metrics ? [e.metrics] : [];
    });

    if (metrics.length === 0) {
      console.log(`  ${ename}: no data`);
      continue;
    }

    const avgCer = metrics.reduce((s, m) => s + m.cer, 0) / metrics.length;
    const avgWer = metrics.reduce((s, m) => s + m.wer, 0) / metrics.length;
    const avgSpeed = metrics.reduce((s, m) => s + m.speed, 0) / metrics.length;
    const avgLayout = metrics.reduce((s, m) => s + m.layoutQuality, 0) / metrics.length;
    const avgTable = metrics.reduce((s, m) => s + m.tableQuality, 0) / metrics.length;
    const avgStruct = metrics.reduce((s, m) => s + m.structureQuality, 0) / metrics.length;

    console.log(`  ${ename}:`);
    console.log(`    CER: ${(avgCer * 100).toFixed(1)}%`);
    console.log(`    WER: ${(avgWer * 100).toFixed(1)}%`);
    console.log(`    Speed: ${avgSpeed.toFixed(1)} pg/s`);
    console.log(`    Layout: ${(avgLayout * 100).toFixed(1)}%`);
    console.log(`    Table: ${(avgTable * 100).toFixed(1)}%`);
    console.log(`    Structure: ${(avgStruct * 100).toFixed(1)}%`);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dir':
        options.testDir = args[++i];
        break;
      case '--engines':
        options.engines = args[++i].split(',');
        break;
      case '--output':
        options.outputDir = args[++i];
        break;
      case '--lang':
        options.lang = args[++i];
        break;
      case '--surya-url':
        options.suryaUrl = args[++i];
        break;
    }
  }

  runBenchmark(options).catch((err) => {
    logger.error(`Benchmark gagal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runBenchmark };
