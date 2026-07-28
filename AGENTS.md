# AGENTS.md — jdi-document-converter

## Arsitektur
- **CLI** (`app.js`) — batch dari `data/links.json`, **TIDAK** memanggil `rebuildDocumentStructure()` — berhenti setelah `cleanText()`
- **Web** (`server.js`) — **Express v5**, memanggil `rebuildDocumentStructure()` di `processBuffer()`
  - `POST /process-url` — single URL, body `{url, nama?}`
  - `POST /process-urls` — batch URL (max 20), body `{urls:[]}`
  - `POST /process-upload` — single file upload, field name `pdf`
  - `POST /process-uploads` — batch upload (max 20), field name `pdf`
  - `GET /download/:file` — download `.txt` dari `config.outputDir`
  - `GET /api/activities` — daftar aktivitas konversi
  - `GET /api/activities/stats` — statistik + data grafik harian
  - `GET /api/activities/:id` — detail per aktivitas
  - `PUT /api/activities/:id/upload` — simpan teks hasil ke DB
- **Frontend** (`public/index.html`) — 3 tab: URL PDF, Upload File, **Aktivitas** (grafik + tabel + tombol Upload per item)
- **Database** — MySQL via `mysql2`, auto-create table di startup. DB name: `jdi_document_converter`. Schema: `database/schema.sql`. Kolom `file_hash` (SHA256) untuk deteksi duplikasi.
- **Activity Logger** (`src/services/activityLogger.js`) — semua operasi MySQL (log activity, get stats, upload text, duplicate check)
- Pipeline: `downloadPdf` → `detectPdfType` → `extractText` (TEXT) / `convertPdfToImages`→`performOcr` (SCAN) → `cleanText` → (`rebuildDocumentStructure` hanya di Web) → output `.txt` → **log ke DB**

## CJS / ESM Hybrid
Project CJS (`require`), tiga import ESM-only dinamis. Jangan ubah ke `require()` — error.

| File | Dynamic import |
|---|---|
| `src/pdf/imageConverter.js:8` | `import('pdfjs-dist/legacy/build/pdf.mjs')` |
| `src/pdf/imageConverter.js:10` | `import('@napi-rs/canvas')` |
| `src/ocr/engine.js:11` | `import('ppu-paddle-ocr')` |

## Status Deteksi (File Rusak/Kosong)
`processBuffer()` di Web memberi status: `BERHASIL`, `GAGAL`, `RUSAK`, `KOSONG`.
- PDF 0 byte → **KOSONG**
- `detectPdfType` / `extractText` / `convertPdfToImages` throw → **RUSAK**
- Hasil `cleanText()` kosong → **KOSONG**
- `downloadPdf` gagal → **GAGAL**
- Status tampil di UI sebagai badge warna (hijau/merah/oranye/biru)

Activity otomatis tercatat di DB tiap konversi. Tombol "Upload ke DB" per file membaca `.txt` dari disk (`config.outputDir`) lalu menyimpan ke kolom `output_text` di MySQL.

## Deteksi Duplikasi
SHA256 hash file dicek saat submit URL/file. Jika URL (untuk URL source) atau hash (untuk upload) sudah ada dengan status BERHASIL, proses ditolak (hard reject, tidak ada entry DB). Saat "Upload ke DB", dicek apakah URL/hash yang sama sudah punya `output_text` dari aktivitas lain — jika ya, upload ditolak.

## Gotcha — Buffer/Uint8Array/Canvas
`pdfjs-dist` v4 dan `ppu-paddle-ocr` minta `Uint8Array`/`Canvas`, tolak `Buffer`.
- `imageConverter.js:18` — `new Uint8Array(buffer)` sebelum `pdfjs.getDocument()`
- `imageConverter.js:43` — push `Canvas` langsung, hindari `toBuffer()`
- `engine.js:29` — `recognize()` terima `Canvas` (punya `.toBuffer()`)
- `imageConverter.js:12-16` — worker path pdfjs-dist harus di-resolve dari `require.resolve('pdfjs-dist/package.json')` + `url.pathToFileURL()`

## Commands
| Perintah | Fungsi |
|---|---|
| `npm start` | Web server `localhost:3000` |
| `npm run cli` | CLI batch dari `data/links.json` |
| `npm test` | `node --experimental-vm-modules test.js` (file belum ada) |

## Konfigurasi
- `.env`: `OUTPUT_DIR`, `LOG_DIR`, `MAX_RETRIES`, `RETRY_DELAY_MS`, `DOWNLOAD_TIMEOUT`, `OCR_LANG`, `PDF_RENDER_SCALE`, `PORT`, `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT`
- `linksPath` dikode keras ke `./data/links.json` (`src/config/index.js:14`) — tidak dari `.env`
- Nama file untuk URL: `extractFileNameFromUrl()` ambil segmen terakhir path URL + hapus `.pdf` + sanitasi karakter. Fallback: `doc_timestamp`
- Nama file untuk upload: `path.parse(file.originalname).name` (tanpa ekstensi)
- File gagal (GAGAL) tetap tercatat di DB via `activityLogger.logActivity()` di error catch

## Catatan
- Semua log/komentar dalam Bahasa Indonesia
- `data/links.json` = array `{id, url, nama}` — wajib untuk CLI
- Retry exponential backoff: `delayMs * attempt` (`src/utils/retry.js:19`)
- `pdf-parse` (CJS) untuk deteksi & ekstrak teks PDF
- `@napi-rs/canvas` (bukan `node-canvas`) untuk render PDF ke Canvas
- Tidak ada linter, formatter, typecheck, atau CI — verifikasi manual wajib

---

## Changelog — 2026-07-28

### ringkasan
Menambahkan sistem database MySQL untuk mencatat aktivitas konversi, dashboard aktivitas dengan grafik di frontend, deteksi status file rusak/kosong, dan tombol "Upload ke DB" per file.

### file baru

| File | keterangan |
|---|---|
| `database/schema.sql` | Skema MySQL — import via phpMyAdmin |
| `src/services/activityLogger.js` | Service MySQL: pool, auto-create table, logActivity, getActivities, getStats, getActivityById, uploadTextToDb |

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `package.json` | — | tambah `mysql2` |
| `.env` | 7 var | tambah `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT` |
| `src/config/index.js` | 6 properti | tambah `config.db` block |
| `server.js` | 181 baris, 4 route | +uuid, +activityLogger, `processBuffer()` pakai try/catch + status RUSAK/KOSONG + log ke DB, 4 route `/api/activities/*`, startup async `initDatabase()` |
| `public/index.html` | 300 baris, 2 tab | +Chart.js CDN, +CSS dashboard, tab ke-3 "Aktivitas" (stat card, grafik bar + doughnut, tabel riwayat, tombol Upload ke DB per baris), `addResultItem()` support status badge, fungsi JS dashboard |
| `AGENTS.md` | 47 baris, 6 section | +Status Deteksi section, +Database/ActivityLogger di Arsitektur, +DB env var di Konfigurasi, +Changelog section |

### perubahan detail per file

**`database/schema.sql`** — baru
```sql
CREATE DATABASE jdi_document_converter;
CREATE TABLE conversion_activities (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(36) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  original_name VARCHAR(255),
  source_type ENUM('url','upload') NOT NULL,
  source_url TEXT,
  file_type ENUM('TEXT','SCAN'),
  ocr_status VARCHAR(50),
  page_count INT DEFAULT 0,
  file_size_bytes BIGINT,
  duration_seconds DECIMAL(10,1),
  status ENUM('BERHASIL','GAGAL','RUSAK','KOSONG') NOT NULL,
  error_message TEXT,
  output_text LONGTEXT,
  text_uploaded TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

**`src/services/activityLogger.js`** — baru
- `initDatabase()` — create DB + table via `CREATE TABLE IF NOT EXISTS`
- `logActivity(data)` — insert baris
- `uploadTextToDb(id, text)` — update `output_text` + set `text_uploaded=1`
- `getActivities()` — SELECT 200 baris terbaru
- `getActivityById(id)` — SELECT satu baris
- `getStats()` — summary + daily grouping 7 hari

**`src/config/index.js`** — tambah block `db`
```js
db: {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  name: process.env.DB_NAME || 'jdi_document_converter',
  port: parseInt(process.env.DB_PORT, 10) || 3306,
}
```

**`server.js`** — perubahan utama
- `processBuffer()` sekarang menerima `sourceInfo` (sessionId, sourceType, sourceUrl, originalName)
- setelah deteksi + konversi: jika `pdfBuffer.length === 0` → status KOSONG
- jika `cleanText()` hasil kosong → status KOSONG
- jika pipeline throw → status RUSAK (`errorMessage` diisi)
- `processBuffer()` memanggil `activityLogger.logActivity()` di akhir
- route baru:
  - `GET /api/activities` → `activityLogger.getActivities()`
  - `GET /api/activities/stats` → `activityLogger.getStats()`
  - `GET /api/activities/:id` → `activityLogger.getActivityById()`
  - `PUT /api/activities/:id/upload` → baca `.txt` dari `config.outputDir`, simpan ke `output_text`
- `app.listen()` diganti jadi `start()` async yang panggil `initDatabase()` dulu

**`public/index.html`** — perubahan utama
- Chart.js dari CDN (`chart.js@4.4.7`)
- CSS baru: `.badge-rusak`, `.badge-kosong`, `.badge-uploaded`, `.stats-row`, `.stat-card.*`, `.charts-row`, `.chart-box`, `.table-wrap`, `.btn-upload`, `.btn-detail`
- tab ke-3: "Aktivitas" — memuat stat card (6 jenis), grafik bar (konversi/hari) + doughnut (status ratio), tabel riwayat, tombol Upload per baris
- `addResultItem()`: pakai `statusBadge()` + `statusIcon()` untuk 4 status, tampilkan `errorMessage` di body
- fungsi baru: `loadActivities()`, `renderStats()`, `renderCharts()` (Chart.js), `renderTable()`, `uploadToDb()` (PUT), `showDetail()` (alert)

---

## Changelog — 2026-07-28 (v2)

### ringkasan
Menambahkan tombol "Upload ke DB" per item hasil konversi, tombol "Upload Semua" batch, redesign CSS menyeluruh dengan gradien, shadows, dan smooth hover.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `public/index.html` | CSS flat + tombol per item belum ada | CSS gradient modern, tombol Upload per item (`.btn-upload-db`), tombol Upload Semua (`.btn-success`), counter upload, spinner per-item |
| `AGENTS.md` | — | +Changelog v2 entry |

### perubahan detail

**`public/index.html`**
- CSS **redesign total**:
  - body gradient `#667eea → #764ba2`, header gradient dark `#1a1a2e → #16213e → #0f3460`
  - card: `border-radius: 14px`, shadow hover, border subtle
  - btn: gradient primary (`#667eea → #764ba2`), gradient success (`#11998e → #38ef7d`), outline style
  - badge: gradient backgrounds, `border-radius: 20px`
  - stat-card: gradient background, hover `translateY(-2px)`
  - table-wrap: border + border-radius, th uppercase + letter-spacing
  - responsive: breakpoint 640px, mobile-friendly stats grid
- tombol **Upload ke DB** per item (`addResultItem`):
  - muncul hanya jika `data.activityId` ada dan status BERHASIL
  - style: `.btn-upload-db` gradient `#f093fb → #f5576c`
  - state: loading (spinner), success (`.done` + hijau), error (retry setelah 2 detik)
- tombol **Upload Semua** di header hasil konversi:
  - muncul hanya jika ≥ 2 item pending
  - text `"Upload Semua (N)"` + counter `"N file belum diupload"`
  - eksekusi sequential — tiap item di-update satu per satu
  - auto-hide setelah semua selesai
- fungsi baru:
  - `uploadResultItem(btn, activityId)` — upload per item
  - `uploadAllResults()` — batch sequential
  - `updateUploadAllBtn()` — toggle visibility + counter
- `resultsStore` — array global tracker (activityId, status, name, fileName)
- `clearResults()` — reset `resultsStore` + upload UI state

---

## Changelog — 2026-07-28 (v3)

### ringkasan
Perbaikan nama file hasil konversi (URL → ekstrak nama dari URL, bukan `doc_timestamp`) dan logging error ke database untuk file yang gagal di-download.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `server.js` | nama file URL: `doc_timestamp`, error catch tidak log ke DB | tambah `extractFileNameFromUrl()`, semua error catch log `status: 'GAGAL'` ke DB, nama file dari URL |
| `AGENTS.md` | — | +Changelog v3 |

### perubahan detail

**`server.js`**
- fungsi baru `extractFileNameFromUrl(url)`:
  - parse URL → ambil segmen terakhir path → hapus `.pdf` → ganti karakter invalid dengan `_` → max 200 chars
  - fallback: `doc_timestamp` kalau URL parsing gagal
- **`process-url`** (single):
  - `fileName` default: `extractFileNameFromUrl(url)` bukan `doc_timestamp`
  - error catch: log `status: 'GAGAL'` ke DB dengan `activityLogger.logActivity()`, return `activityId`
- **`process-urls`** (batch):
  - `fileName` default: `extractFileNameFromUrl(url)` bukan `doc_timestamp`
  - error catch: log `status: 'GAGAL'` ke DB, `activityId` dikembalikan ke frontend
- **`process-uploads`** (batch):
  - error catch: log `status: 'GAGAL'` ke DB, `activityId` dikembalikan ke frontend

File yang gagal tetap tercatat di tabel Aktivitas dengan status **GAGAL** dan `error_message` berisi detail error. Tombol "Upload ke DB" tidak muncul untuk file GAGAL (hanya untuk BERHASIL).

---

## Changelog — 2026-07-28 (v4)

### ringkasan
Perbaikan URL dengan spasi (404 error), ekstraksi nama file dari URL yang mengandung spasi, dan logging GAGAL ke DB untuk rute `process-upload` (single).

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/services/pdfDownloader.js` | `downloadPdf(url)` kirim URL mentah | tambah `encodeUrl()` — spasi di-encode `%20` sebelum axios |
| `server.js` | `extractFileNameFromUrl()` gagal `new URL()` untuk URL berspasi, `process-upload` catch tidak log ke DB | encode spasi dulu, pakai `decodeURIComponent()`, catch log GAGAL ke DB |
| `AGENTS.md` | — | +Changelog v4, v5 |

### perubahan detail

**`src/services/pdfDownloader.js`**
- fungsi baru `encodeUrl(raw)`:
  - coba `new URL(raw)` — sukses → return `.href`
  - gagal → `raw.replace(/\s/g, '%20')` (ganti spasi literal dengan %20)
- `downloadPdf()` panggil `encodeUrl(url)` sebelum axios.get()

**`server.js`**
- `extractFileNameFromUrl()`:
  - sebelum `new URL()`, encode spasi: `url.replace(/\s/g, '%20')`
  - setelah `pathname` split + pop, decode: `decodeURIComponent(last)` — agar `%20` kembali jadi spasi
  - hasil: `"perbub no 6 tahun 2020 tentang penghasilan tetap kepala desa"` (bukan `perbub_20no_206...`)
- **`process-upload`** (single):
  - catch block sekarang log `status: 'GAGAL'` ke DB via `activityLogger.logActivity()`
  - bersihkan file upload via `fs.remove(req.file.path).catch(() => {})`
  - return `{ status: 'GAGAL', activityId, fileName }` ke frontend

---

## Changelog — 2026-07-28 (v5)

### ringkasan
Menambahkan tombol "Detail" untuk item BERHASIL+uploaded di tabel Aktivitas yang membuka modal berisi metadata dan hasil teks (`output_text`) dari database.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `public/index.html` | BERHASIL+uploaded: disabled hijau "Sudah diupload", tidak ada detail | BERHASIL+uploaded: tombol "Detail" hijau buka modal; modal dengan meta + `output_text` scrollable |
| `AGENTS.md` | — | +Changelog v5 |

### perubahan detail

**`public/index.html`**
- CSS baru:
  - `.modal-overlay` — fixed fullscreen, backdrop blur, z-index 1000
  - `.modal-box` — white card, max-width 700px, max-height 85vh, slide-up animation
  - `.modal-header` / `.modal-close` — judul file + tombol `×`
  - `.modal-body` / `.modal-meta` — grid metadata (Status, Tipe, Halaman, Durasi, Sumber, Diupload ke DB)
  - `.modal-text` — `<pre>` block max-height 380px, scrollable, monospace
  - `.btn-detail-green` — gradient hijau (`#11998e → #38ef7d`)
- HTML baru: modal structure (`#detailModal`) di akhir `<body>`
- `renderTable()` — BERHASIL+uploaded: ganti `<button disabled>Sudah diupload</button>` → `<button class="btn-detail-green" onclick="openDetailModal(id)">Detail</button>`
- Fungsi baru:
  - `openDetailModal(id)` — fetch `/api/activities/:id`, isi modal, tampilkan
  - `closeDetailModal()` — sembunyikan modal, restore body scroll
  - `closeDetailModalOutside(event)` — tutup saat klik overlay
  - Escape key listener — tutup modal

---

## Changelog — 2026-07-28 (v6)

### ringkasan
Menambahkan sistem deteksi duplikasi menggunakan SHA256 hash file. Cek duplikasi saat submit URL/file (berdasarkan URL dan hash) dan saat "Upload ke DB" (berdasarkan URL/hash yang sudah punya `output_text`). Hard reject — proses dibatalkan jika duplikat terdeteksi.

### file baru/diubah

| File | sebelum | sesudah |
|---|---|---|
| `database/schema.sql` | 7 kolom data + 3 index | + kolom `file_hash VARCHAR(64)` + `idx_file_hash` |
| `src/services/activityLogger.js` | 7 fungsi, insert 12 kolom | +3 fungsi (`checkDuplicateByUrl`, `checkDuplicateByHash`, `checkDuplicateUpload`), insert + `file_hash`, SELECT + `file_hash`, ALTER TABLE migrasi |
| `server.js` | 381 baris | +`crypto`, `computeHash()`, duplicate check di 4 route + upload route, `processBuffer()` pass `fileHash` ke logActivity |
| `public/index.html` | 732 baris | +DUPLICATE status di `statusIcon`/`statusBadge`/`addResultItem`, duplicate response handling di `uploadToDb`/`uploadResultItem`/`uploadAllResults` |
| `AGENTS.md` | — | +Changelog v6 |

### perubahan detail

**`database/schema.sql`**
- kolom baru `file_hash VARCHAR(64) DEFAULT NULL` setelah `source_url`
- index baru `INDEX idx_file_hash (file_hash)`

**`src/services/activityLogger.js`**
- `initDatabase()` — CREATE TABLE tambah kolom `file_hash` + index; ALTER TABLE untuk migrasi tabel lama
- `logActivity(data)` — insert sekarang termasuk `file_hash`
- `getActivities()` / `getActivityById()` — SELECT sekarang include `file_hash`
- fungsi baru `checkDuplicateByUrl(url)`:
  - `SELECT id, file_name FROM conversion_activities WHERE source_url = ? AND status = 'BERHASIL' LIMIT 1`
  - return `{id, file_name}` atau `null`
- fungsi baru `checkDuplicateByHash(hash)`:
  - `SELECT id, file_name FROM conversion_activities WHERE file_hash = ? AND status = 'BERHASIL' LIMIT 1`
  - return `{id, file_name}` atau `null`
- fungsi baru `checkDuplicateUpload(activity)`:
  - untuk URL: cari aktivitas lain (`id != ?`) dengan `source_url` sama DAN `output_text IS NOT NULL`
  - untuk upload: cari aktivitas lain dengan `file_hash` sama DAN `output_text IS NOT NULL`
  - return `{id, file_name}` atau `null`

**`server.js`**
- `const crypto = require('crypto')`
- fungsi `computeHash(buffer)` — SHA256 hex dari buffer file
- `processBuffer()` — terima `sourceInfo.fileHash`, teruskan ke `logActivity()`
- **`process-url`**: sebelum download → `checkDuplicateByUrl(url)` → jika duplikat return `{status:'DUPLICATE', ...}`; setelah download + hash → `checkDuplicateByHash(hash)` → jika duplikat return DUPLICATE
- **`process-urls`**: sama per URL dalam loop, dengan `continue` untuk duplikat
- **`process-upload`**: baca file → hash → `checkDuplicateByHash(hash)` → jika duplikat return DUPLICATE + cleanup file
- **`process-uploads`**: sama per file dalam loop, hash dihitung SEBELUM try-catch agar bisa `continue`
- **`PUT /api/activities/:id/upload`**: sebelum simpan teks → `checkDuplicateUpload(activity)` → jika ada duplikat return `{duplicate: true, existingId, error}`

**`public/index.html`**
- `statusIcon()` — tambah case `'DUPLICATE'` → icon warning (`&#9888;`)
- `statusBadge()` — tambah case `'DUPLICATE'` → badge kuning "Duplikat"
- `addResultItem()`:
  - var `isDuplicate` dari `st === 'DUPLICATE' || data.duplicate`
  - DUPLICATE tidak di-`push` ke `resultsStore` (tidak perlu upload)
  - body DUPLICATE: tampilkan error kuning dengan `data.error` + ID existing
- `uploadToDb()` (table): handle `data.duplicate` → button show "Duplikat", alert error
- `uploadResultItem()` (result card): handle `data.duplicate` → button jadi outline "Duplikat", alert error
- `uploadAllResults()`: handle `data.duplicate` → button jadi outline "Duplikat"
