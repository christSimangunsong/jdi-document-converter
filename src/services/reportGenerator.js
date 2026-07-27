const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');
const config = require('../config');

function generateReport(results) {
  const reportPath = path.join(config.logDir, 'report.json');

  const summary = {
    total: results.length,
    berhasil: results.filter((r) => r.status === 'BERHASIL').length,
    gagal: results.filter((r) => r.status === 'GAGAL').length,
    files: results,
    generatedAt: new Date().toISOString(),
  };

  fs.writeJsonSync(reportPath, summary, { spaces: 2 });

  logger.info('====================================================');
  logger.info('            LAPORAN AKHIR DOCUMENT CONVERTER');
  logger.info('====================================================');
  logger.info(`Total file diproses : ${summary.total}`);
  logger.info(`Berhasil            : ${summary.berhasil}`);
  logger.info(`Gagal               : ${summary.gagal}`);
  logger.info('====================================================');

  console.log('\n');
  results.forEach((r) => {
    console.log('----------------------------------------------------');
    console.log(`  File        : ${r.nama}`);
    console.log(`  Halaman     : ${r.halaman}`);
    console.log(`  Jenis       : ${r.jenis}`);
    console.log(`  OCR         : ${r.ocrStatus}`);
    console.log(`  Durasi      : ${r.durasi}`);
    console.log(`  Output      : ${r.output || '-'}`);
    if (r.error) {
      console.log(`  Error       : ${r.error}`);
    }
    console.log('----------------------------------------------------');
  });

  console.log(`\nLaporan lengkap tersimpan di: ${reportPath}`);
}

module.exports = { generateReport };
