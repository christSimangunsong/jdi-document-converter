// Peluncur manual sidecar (deskew 5002 + table-ocr 5003).
// Jalankan: npm run sidecars  (atau: node scripts/sidecars.js)
// Catatan: untuk auto-start, cukup `npm start` (SIDECAR_AUTOSTART=true).
const { spawn } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const ROOT = path.resolve(__dirname, '..');

const jobs = [
  { name: 'table-ocr', script: path.join('sidecar', 'table_ocr', 'run_server.py'), port: 5003 },
  { name: 'deskew', script: path.join('sidecar', 'run_deskew.py'), port: 5002 },
];

for (const job of jobs) {
  const child = spawn(PYTHON_BIN, [job.script], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', (err) => console.error(`[sidecars] ${job.name} gagal: ${err.message}`));
  console.log(`[sidecars] ${job.name} -> http://127.0.0.1:${job.port} (log di bawah; Ctrl+C untuk berhenti)`);
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
