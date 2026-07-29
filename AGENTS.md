# AGENTS.md — jdi-document-converter

> Panduan agent untuk coding assistant. Changelog history ada di bagian bawah.

## Arsitektur

| Entry | File | DB logging | `rebuildDocumentStructure` |
|-------|------|------------|---------------------------|
| **CLI** | `app.js` | No | No — stops after `cleanText()` |
| **Web** | `server.js` | No — save on-demand via `POST /api/activities/save` | Yes |

Pipeline: `downloadPdf` → `detectPdfType` → `extractText` (TEXT) / `convertPdfToImages→performStructuredOcr→sidecar` (SCAN) → `cleanText` → (`rebuildDocumentStructure` only Web) → output `.txt` **→ user edits text → klik "Simpan ke Database"**

Untuk SCAN: jika `STRUCTURE_SERVICE_URL` diset → **PP-StructureV3 sidecar** (layout-aware OCR + table recognition). Jika tidak diset atau sidecar unreachable → fallback ke `ppu-paddle-ocr` standar.

## Routes (Web)

- `POST /process-url` — body `{url, nama?}`
- `POST /process-urls` — body `{urls:[]}` (max 20) **SSE streaming FIFO**
- `POST /process-upload` — multipart field `pdf`
- `POST /process-uploads` — multipart field `pdf` (max 20) **SSE streaming FIFO**
- `GET /download/:file` — download `.txt` dari `config.outputDir`
- `GET /api/activities[/stats|/:id]` — activity log queries
- `POST /api/activities/save` — simpan text + metadata ke DB (body JSON)

## Commands

| Perintah | Fungsi |
|---|---|
| `npm start` | Web server `localhost:3000` |
| `npm run cli` | CLI batch dari `data/links.json` |
| `npm test` | `node --experimental-vm-modules test.js` (file belum ada) |

## CJS / ESM Hybrid

Project CJS (`require`), tiga import ESM-only dinamis. Jangan ubah ke `require()` — error.

| File | Dynamic import |
|---|---|
| `src/pdf/imageConverter.js:8` | `import('pdfjs-dist/legacy/build/pdf.mjs')` |
| `src/pdf/imageConverter.js:9` | `import('@napi-rs/canvas')` |
| `src/ocr/engine.js:11` | `import('ppu-paddle-ocr')` |

## Gotcha — Buffer/Uint8Array/Canvas

`pdfjs-dist` v4 dan `ppu-paddle-ocr` minta `Uint8Array`/`Canvas`, tolak `Buffer`.
- `imageConverter.js:18` — `new Uint8Array(buffer)` sebelum `pdfjs.getDocument()`
- `imageConverter.js:43` — push `Canvas` langsung, hindari `toBuffer()`
- `engine.js:29` — `recognize()` terima `Canvas` (punya `.toBuffer()`)
- `imageConverter.js:12-16` — worker path pdfjs-dist harus di-resolve dari `require.resolve('pdfjs-dist/package.json')` + `url.pathToFileURL()`

## Status & Duplikasi

`processBuffer()` memberi status: `BERHASIL`, `GAGAL`, `RUSAK`, `KOSONG`.
- PDF 0 byte → **KOSONG**; pipeline throw → **RUSAK**; `cleanText()` kosong → **KOSONG**; download gagal → **GAGAL**
- SHA256 hash (`computeHash()`) dicek saat `POST /api/activities/save`: jika hash sudah ada DAN `output_text` sudah terisi → DUPLICATE, ditolak
- Status & Duplikasi hanya di cek saat user klik "Simpan ke Database", tidak ada auto-insert
- `getActivities()` / `getStats()` hanya mengembalikan data dengan `output_text IS NOT NULL` — record legacy tanpa teks tidak tampil di UI

## Konfigurasi

- `.env`: `OUTPUT_DIR`, `LOG_DIR`, `MAX_RETRIES`, `RETRY_DELAY_MS`, `DOWNLOAD_TIMEOUT`, `OCR_LANG`, `PDF_RENDER_SCALE`, `PORT`, `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT`
- `linksPath` hardcoded ke `./data/links.json` (`src/config/index.js:14`) — tidak dari `.env`
- Nama file URL: `extractFileNameFromUrl()` — last path segment, strip `.pdf`, sanitasi, max 200 chars, fallback `doc_`+timestamp. URL dengan spasi di-encode `%20` dulu lalu `decodeURIComponent()`.
- Nama file upload: `path.parse(file.originalname).name`
- Multer simpan upload di `uploads/`, dibersihkan setelah diproses
- `output/`, `logs/`, `uploads/`, `node_modules/`, `.env` di gitignore

## Catatan

- Semua log/komentar dalam Bahasa Indonesia
- `data/links.json` = array `{id, url, nama}` — wajib untuk CLI
- Retry exponential backoff: `delayMs * attempt` (`src/utils/retry.js:19`)
- `pdf-parse` (CJS) untuk deteksi & ekstrak teks PDF
- `@napi-rs/canvas` (bukan `node-canvas`) untuk render PDF ke Canvas
- Tidak ada linter, formatter, typecheck, atau CI — verifikasi manual wajib

---

## Changelog — 2026-07-27

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

## Changelog — 2026-07-27 (v2)

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

## Changelog — 2026-07-27 (v3)

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

## Changelog — 2026-07-27 (v4)

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

---

## Changelog — 2026-07-29 (v7)

### ringkasan
Restrukturasi alur penyimpanan ke database: hapus auto-insert `logActivity()` dari `processBuffer()` dan semua error catch route. Hasil konversi ditampilkan di `<textarea>` editable, pengguna bisa mengedit teks sebelum klik "Simpan ke Database" yang memanggil `POST /api/activities/save`.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `server.js` | `logActivity()` di `processBuffer()` + semua route catches, duplicate check di submit, return `activityId` | `logActivity()` dihapus dari `processBuffer()` dan semua catch, duplicate check hanya di save route, return metadata (`sourceType`, `sourceUrl`, `fileHash`) bukan `activityId`; +route `POST /api/activities/save` |
| `public/index.html` | `addResultItem()` show `<div class="text-output">` + Upload ke DB button, `uploadResultItem`/`uploadAllResults`/`updateUploadAllBtn`, DUPLICATE status | `addResultItem()` show `<textarea>` editable + "Simpan ke Database" button, fungsi `saveResultItem()` POST ke `/api/activities/save`, DUPLICATE status dihapus, `uploadAllBtn`/`uploadCounter` dihapus |
| `AGENTS.md` | — | +Changelog v7 |

### perubahan detail

**`server.js`**
- `processBuffer()`: hapus `activityLogger.logActivity()` — tidak lagi auto-insert ke DB
- `processBuffer()` return objek: tambah `sourceType`, `sourceUrl`, `originalName`, `fileHash`; hapus `activityId`
- Semua route catch block (`process-url`, `process-urls`, `process-upload`, `process-uploads`): hapus `activityLogger.logActivity()` dan return `activityId`
- Semua duplicate check (`checkDuplicateByUrl`, `checkDuplicateByHash`) dihapus dari submission routes
- `sessionId`/`uuidv4()` dihapus dari submission routes
- Route baru `POST /api/activities/save`:
  - terima `{text, file_name, source_type, source_url, ...}`
  - cek duplikasi via `checkDuplicateByHash`
  - create activity + `uploadTextToDb` dalam satu request
  - return `{success, activityId}`

**`public/index.html`**
- `statusIcon()`: hapus case `DUPLICATE`
- `statusBadge()`: hapus case `DUPLICATE`
- `addResultItem()`:
  - hapus `isDuplicate`, `aid`/`activityId`
  - simpan metadata di `resultsStore` sebagai objek `meta`
  - BERHASIL: `<textarea class="result-textarea">` editable + tombol "Simpan ke Database" (`.btn-save`)
  - hapus `.upload-db-btn`, `updateUploadAllBtn()`, event listener upload
- Fungsi baru:
  - `getTextareaValue(index)` — ambil value textarea
  - `saveResultItem(btn, index)` — POST ke `/api/activities/save`, handle success/duplicate/error
- CSS baru: `.btn-save` (gradient ungu), `.result-textarea` (monospace, border, fokus styling)
- Hapus: `#uploadAllBtn`, `.upload-counter`, `#uploadCounter`, fungsi `uploadResultItem()`, `uploadAllResults()`, `updateUploadAllBtn()`
- `clearResults()`: sederhanakan — hapus referensi `uploadAllBtn`/`uploadCounter`

---

## Changelog — 2026-07-29 (v8)

### ringkasan
Hapus legacy `PUT /api/activities/:id/upload` route dan tombol "Upload ke DB" di tabel Aktivitas. Hanya `POST /api/activities/save` sebagai satu-satunya jalur penyimpanan ke database.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `server.js` | 12 route termasuk `PUT /api/activities/:id/upload` | 11 route — PUT route dihapus |
| `src/services/activityLogger.js` | 11 exported functions termasuk `checkDuplicateUpload` | 10 exported functions — `checkDuplicateUpload` dihapus |
| `public/index.html` | tabel Aktivitas: tombol "Upload ke DB" + function `uploadToDb()` + CSS `.btn-upload`/`.btn-upload-db` | tabel Aktivitas: badge "Belum disimpan" abu-abu untuk item tanpa `output_text`, function + CSS dihapus |
| `AGENTS.md` | — | +Changelog v8, update Routes & Status section |

### perubahan detail

**`server.js`**
- Hapus seluruh route `PUT /api/activities/:id/upload` (37 baris)
- `POST /api/activities/save` tetap sebagai satu-satunya jalur masuk data ke DB

**`src/services/activityLogger.js`**
- Hapus fungsi `checkDuplicateUpload(activity)` — dead code, hanya dipakai oleh PUT route
- Hapus dari `module.exports`

**`public/index.html`**
- `renderTable()`: BERHASIL + `text_uploaded===0` → badge `<span>Belum disimpan</span>` abu-abu (bukan tombol)
- Hapus fungsi `uploadToDb()` — dead code
- Hapus CSS `.btn-upload` (4 baris) dan `.btn-upload-db` (4 baris) — tidak dipakai lagi

---

## Changelog — 2026-07-29 (v9)

### ringkasan
Filter Aktivitas & Duplikasi — hanya menampilkan data yang benar-benar sudah disimpan ke database. Duplikasi hanya dicek terhadap record yang sudah punya `output_text`, sehingga legacy record tanpa teks tidak memblokir dan tidak muncul di UI.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/services/activityLogger.js` | `checkDuplicateByHash()` cek semua status BERHASIL; `getActivities()`/`getStats()` tanpa filter | `checkDuplicateByHash()` tambah `AND output_text IS NOT NULL`; `getActivities()`/`getStats()` filter `WHERE output_text IS NOT NULL` |
| `public/index.html` | `renderTable()` tampilkan badge "Belum disimpan" untuk item tanpa `output_text` | "Belum disimpan" dihapus — tidak diperlukan karena data tanpa teks tidak muncul |
| `AGENTS.md` | — | +Changelog v9, update Status section |

### perubahan detail

**`src/services/activityLogger.js`**
- `checkDuplicateByHash()`: query berubah — hanya menganggap duplikat jika hash sama DAN `output_text` sudah terisi
  ```sql
  -- sebelum
  WHERE file_hash = ? AND status = 'BERHASIL'
  -- sesudah
  WHERE file_hash = ? AND status = 'BERHASIL' AND output_text IS NOT NULL
  ```
- `getActivities()`: tambah `WHERE output_text IS NOT NULL` — hanya kembalikan record yang sudah disimpan
- `getStats()`: tambah `WHERE output_text IS NOT NULL` di query summary dan daily — statistik hanya dari data tersimpan

**`public/index.html`**
- `renderTable()`: hapus badge "Belum disimpan" — semua record yang tampil sudah punya `output_text`

---

## Changelog — 2026-07-29 (v10)

### ringkasan
Migrasi batch processing dari response JSON array ke **SSE streaming FIFO**. Setiap file dikirim ke frontend segera setelah selesai dikonversi, tanpa menunggu seluruh batch. Perbaikan bug `req.on('close')` yang menyebabkan loop berhenti setelah file pertama.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `server.js` | 2 route batch kirim `res.json({results})` setelah semua selesai | 2 route SSE streaming: tiap file selesai → `res.write(event + data)` langsung, `res.on('close')` untuk deteksi disconnect |
| `public/index.html` | `processUrls()/processFiles()` baca `res.json()` lalu `forEach` | `processUrls()/processFiles()` baca `ReadableStream` via `readSSEStream()` — parse event per-event real-time |
| `AGENTS.md` | — | +Changelog v10, update Routes section |

### perubahan detail

**`server.js`**
- Route `/process-urls` (batch): ganti dari kumpul array → SSE streaming FIFO:
  - `res.writeHead(200, {'Content-Type':'text/event-stream', ...})` + `res.socket.setNoDelay(true)`
  - Loop FIFO: `progress` → `processBuffer()` → `result`/`error` → `done`
  - deteksi disconnect: `res.on('close')` bukan `req.on('close')`
- Route `/process-uploads` (batch): perubahan identik
- Single routes `/process-url`, `/process-upload` tetap tidak berubah

**`public/index.html`**
- fungsi baru `readSSEStream(response, callbacks)`:
  - baca `response.body.getReader()` via `ReadableStream`
  - akumulasi buffer, split `\n\n`, parse `event:`/`data:`, dispatch ke callback
- `processUrls()`: pakai `readSSEStream` dengan callback `progress`/`result`/`error`/`done`
- `processFiles()`: sama

### Data flow

```
Sebelum (batch):
  Server: for each file → results[] → res.json({results})
  Client: res.json() → forEach → addResultItem

Sesudah (SSE streaming):
  Server: for each file → res.write(event:result) langsung
  Client: reader.read() → parse SSE → addResultItem per event
```

---

## Changelog — 2026-07-29 (v11)

### ringkasan
Menambahkan 4 infrastruktur pengembangan: test file unit (47 tests), linter (ESLint) + formatter (Prettier), CI/CD (GitHub Actions), dan Docker (Dockerfile + docker-compose).

### file baru/diubah

| File | keterangan |
|---|---|
| `test.js` (baru) | 47 unit test: config, cleanText, DocumentStructureRebuilder, withRetry, computeHash, extractFileNameFromUrl, integrasi |
| `.eslintrc.json` (baru) | ESLint config — env node/commonjs/es2022, extends recommended |
| `.prettierrc` (baru) | Prettier config — singleQuote, trailingComma all, printWidth 120 |
| `.github/workflows/ci.yml` (baru) | GitHub Actions — matrix Node 18/20, lint + test |
| `Dockerfile` (baru) | Node 20-slim, tini entrypoint, port 3000 |
| `.dockerignore` (baru) | node_modules, output, logs, uploads, .env, .git |
| `docker-compose.yml` (baru) | App + MySQL 8, healthcheck, volume persistensi |
| `package.json` | + devDependencies (eslint 8, prettier 3), + scripts (`lint`, `lint:fix`, `format`, `format:check`) |
| `src/utils/textCleaner.js` | fix order: replacement rules sebelum character filter; split smart quotes regex `[""]` dan `['']` |
| `src/utils/DocumentStructureRebuilder.js` | fix regex: hapus unnecessary escape `\.` dan `\)` |
| `server.js` | fix: `fmtDate()` pindah ke const arrow function, hoist sebelum if block |
| `src/services/activityLogger.js` | fix: tambah komentar di empty catch block |

### perubahan detail

**`test.js`** — baru
- Helper `test()` sinkron + `testAsync()` async dengan counter passed/failed
- **Config** (8 tests): outputDir, logDir, maxRetries, retryDelayMs, db config
- **cleanText** (14 tests): empty/null/undefined, collapse spaces/newlines, bullet `•`, smart quotes `""`/`''`, en/em dash, heading BAB/Pasal, Latin/Cyrillic, control chars
- **DocumentStructureRebuilder** (10 tests): empty, BAB, Pasal, Ayat numbering, Bagian, Paragraf, indent hierarchy, newline collapse
- **withRetry** (4 tests): first-try success, retry success, all retries fail, custom options
- **computeHash** (4 tests): empty buffer, known string, 64-char hex, uniqueness
- **extractFileNameFromUrl** (10 tests): .pdf strip, multi-segment, spaces, special chars, truncation 200 chars, invalid URL, domain-only fallback
- **Integrasi** (1 test): full pipeline cleanText → rebuildDocumentStructure untuk teks hukum Indonesia
- Exit code: `0` jika semua passed, `1` jika ada failed

**`textCleaner.js`** — fix order + split regex
- Pindahkan replacement rules (bullet, smart quotes, dash) SEBELUM character filter — bullet/quote/dash characters sekarang diganti dulu baru difilter
- Split regex smart quotes: `[“”]` → `"`, `[‘’]` → `'` (sebelumnya semua diganti `"`)

**`Dockerfile`**
- Base: `node:20-slim` — Debian-based, kompatibel dengan native modules (`@napi-rs/canvas`, `onnxruntime-node`)
- `tini` sebagai init process (SIGTERM handling)
- `npm ci --only=production` — install hanya production dependencies
- `mkdir -p output logs uploads` — direktori runtime
- `EXPOSE 3000`

**`docker-compose.yml`**
- Service `app`: build dari Dockerfile, port 3000, environment variables dari `.env`, volume `app_output` + `app_logs`, restart unless-stopped
- Service `db`: MySQL 8, healthcheck (mysqladmin ping), volume `mysql_data`, port 3307:3306
- `depends_on` dengan `condition: service_healthy` — app menunggu MySQL siap
- charset utf8mb4 + collation utf8mb4_unicode_ci

**`.github/workflows/ci.yml`**
- Trigger: push / pull_request ke `main`
- Matrix: Node.js 18 dan 20
- Steps: checkout → setup-node (dengan cache) → npm ci → npm run lint → npm test
- `NODE_OPTIONS: --experimental-vm-modules` diset di env test

---

## Changelog — 2026-07-29 (v13)

### ringkasan
Menambahkan **Python sidecar** berbasis PP-StructureV3 untuk layout-aware OCR dan table recognition. Sidecar mendeteksi struktur halaman, mengenali tabel, dan mengembalikan HTML tabel yang diformat. Jika sidecar tidak tersedia, pipeline fallback ke `ppu-paddle-ocr` standar.

### file baru

| File | keterangan |
|---|---|
| `sidecar/main.py` | FastAPI app — endpoint `POST /analyze`: terima base64 images, return text + table HTML per halaman. Inisialisasi `PPStructure` dari PaddleOCR |
| `sidecar/requirements.txt` | Python dependencies: fastapi, uvicorn, paddlepaddle, paddleocr, Pillow, numpy |
| `sidecar/Dockerfile` | Python 3.10-slim, install system deps (libgl, libgomp), pip install requirements, port 5000 |
| `src/services/structureService.js` | HTTP client ke sidecar: `performStructuredOcr(images, onProgress)` → convert Canvas ke base64 → kirim POST → parse response → format tabel. Fallback ke `performOcr()` jika sidecar unreachable |
| `src/utils/tableFormatter.js` | `formatTableHtmlToText(html)` — parse HTML tabel (`<tr>`, `<td>`, `<th>`) → render sebagai tabel ASCII dengan kolom rata dan border `+---+---+` |

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `server.js` | import `performOcr` | + import `performStructuredOcr`; SCAN branch: jika `config.structureServiceUrl` ada → pakai `performStructuredOcr`, fallback ke `performOcr` |
| `src/config/index.js` | 6 properti + `db` | + `structureServiceUrl`, `sidecarTimeout` |
| `.env` | 30 baris | + `STRUCTURE_SERVICE_URL`, `SIDECAR_TIMEOUT` |
| `docker-compose.yml` | 2 services (app + db), 3 volumes | + service `sidecar:5000`, env `STRUCTURE_SERVICE_URL=http://sidecar:5000`, volume `sidecar_cache` |
| `.gitignore` | 5 baris | + `sidecar/__pycache__/`, `*.pyc`, `.paddleocr/` |
| `AGENTS.md` | — | +Changelog v13 |

### arsitektur

```
server.js (Node.js)
  │
  ├─ /process-urls → downloadPdf → detectPdfType → processBuffer
  │     ├─ TEXT → pdf-parse (existing)
  │     └─ SCAN → convertPdfToImages
  │                ├─ [config.structureServiceUrl] → performStructuredOcr
  │                │     └─ POST /analyze → sidecar (port 5000)
  │                │           ├─ PP-StructureV3 (layout + table)
  │                │           └─ return {text, tables: [{html}]}
  │                └─ [fallback] → performOcr (ppu-paddle-ocr existing)
  │
  └─ Python sidecar (sidecar/main.py)
       FastAPI → POST /analyze ← base64 images
       ├─ PPStructure engine (PaddleOCR)
       ├─ layout detection → text blocks
       ├─ table recognition → HTML tables
       └─ return JSON [{page, text, tables}]
```

### detail

**`sidecar/main.py`**
- `POST /analyze` menerima `{images: [base64], lang: "id"}`
- Setiap image di-decode → numpy array → `engine(img_array)` dari PPStructure
- Hasil per item: jika `type == "table"` → simpan `res.html`, jika `type == "text"` → simpan `res.text`
- `GET /health` — health check
- Environment: `OCR_LANG`, `USE_GPU` (default CPU)

**`src/services/structureService.js`**
- `performStructuredOcr(images, onProgress)`: wrapper dengan auto-fallback
- Jika `config.structureServiceUrl` kosong → langsung `performOcr()`
- Jika sidecar timeout/error → catch → log warning → `performOcr()`
- Canvas dikonversi ke base64 PNG via `canvas.toBuffer('image/png')`
- Timeout: `config.sidecarTimeout` (default 120 detik)

**`src/utils/tableFormatter.js`**
- `formatTableHtmlToText(html)`: parse `<tr>`, `<td>`, `<th>` → ekstrak teks → hitung lebar kolom → render tabel ASCII
- Multi-line cell support (text wrapping per kolom)
- Output tabel dengan border `+---+---+` dan pemisah baris

### fallback behavior
- Sidecar tidak di-set (`STRUCTURE_SERVICE_URL` kosong) → OCR standar `ppu-paddle-ocr`
- Sidecar tidak reachable (connection refused) → log warning → OCR standar
- Sidecar timeout → log warning → OCR standar
- Sidecar error per halaman → halaman tersebut return text kosong, halaman lain tetap diproses

---

## Changelog — 2026-07-29 (v14)

### ringkasan
Menambahkan garbage filter untuk membersihkan output tabel OCR yang berantakan (isolated chars + digits), error handling per halaman di imageConverter dan engine, serta 9 unit test baru.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/utils/textCleaner.js` | `cleanText()` tanpa filter tabel | + `isTableGarbage(line)` + `filterTableGarbage(text)` — deteksi dan hapus blok sampah tabel dari akhir teks |
| `src/pdf/imageConverter.js` | page.render() error → throw, abort seluruh dokumen | try/catch per page → render gagal → push Canvas 1×1 kosong (skip) |
| `src/ocr/engine.js` | recognize() error → throw, abort | try/catch per page → OCR gagal → push string kosong `''` |
| `test.js` | 50 tests | +9 tests: `isTableGarbage`, `filterTableGarbage`, real document scenario = 59 tests |

### perubahan detail

**`src/utils/textCleaner.js`**
- Fungsi baru `isTableGarbage(line)`:
  - Skip line pendek (≤ 3 kata): return `false`
  - Hitung digit count + word count
  - Jika digitPct > 0.25 DAN wordLength < 4 untuk > 60% kata → **garbage**
  - Cek khusus: jika ada kata panjang (≥ 6 chars) → **not garbage** (false positive protection)
- Fungsi baru `filterTableGarbage(text)`:
  - Scan dari akhir teks, cari blok kontigu baris garbage di bagian bawah
  - Potong semua baris dari `garbageStart` sampai akhir
  - Filter sisa baris garbage yang terisolasi di bagian atas
- `cleanText()`: panggil `filterTableGarbage()` setelah replacement rules, sebelum heading detection

**`src/pdf/imageConverter.js`**
- Per-page try/catch di loop `convertPdfToImages()`:
  ```js
  try {
    const page = await pdfDoc.getPage(i + 1);
    // ... render
  } catch (err) {
    console.warn(`Halaman ${i + 1} gagal dirender: ${err.message}. Skipping.`);
    const blank = new Canvas(1, 1);
    pages.push(blank);
  }
  ```

**`src/ocr/engine.js`**
- Per-page try/catch di loop `performOcr()`:
  ```js
  try {
    const result = await ocrEngine.recognize(canvas, lang);
    // ...
  } catch (err) {
    console.warn(`OCR halaman ${i + 1} gagal: ${err.message}. Skipping.`);
    results.push('');
  }
  ```

**`test.js`**
- 9 test baru di section `=== 9. tableGarbageFilter ===`:
  - `clean legal text not garbage` — "Bupati adalah Bupati Dairi" → false
  - `short line not garbage` — "Bupati" (1 word) → false
  - `isolated char soup is garbage` — "N M M 1 I I I I 1 I I F 8" → true
  - `digit line with spaces is garbage` — "7 0 0 0 0 1 9 0 1" → true
  - `legal text with numbers not garbage` — "1. Undang-Undang..." → false
  - `number with description not garbage` — "30% (tiga puluh persen)" → false
  - `filter removes trailing garbage block` — clean text + garbage → hanya clean
  - `filter keeps clean text unchanged` — teks bersih tidak berubah
  - `real document ending with lampiran garbage` — dokumen legal + sampah tabel → dokumen utuh

### Garbage filter logic

```
Input line → split by spaces → count words/digits
  ↓
if word count ≤ 3 → NOT garbage (short line, e.g. "Pasal 1")
if digit percentage > 0.25 AND most words are short (< 4 chars) → GARBAGE
if any word ≥ 6 chars → NOT GARBAGE (has meaningful text)
```

### Per-page error handling
Sebelumnya: satu halaman gagal render/OCR → seluruh dokumen gagal.
Sesudahnya: halaman gagal di-skip (blank canvas / string kosong), halaman lain diproses normal.