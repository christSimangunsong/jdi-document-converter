# CHANGELOG - jdi-document-converter

> Log progres proyek ini. Setiap update menambahkan entri baru di bagian paling atas (## Changelog - TANGGAL (vN)).
> Riwayat v1-v17 di bawah ini adalah salinan utuh dari AGENTS.md - tidak ada yang dihapus.

---

## Changelog — 2026-07-31 (v21)

### ringkasan
Perbaikan **deteksi tabel miring**: rectification dilakukan SEBELUM deteksi grid tabel (bukan setelah), kaskade deskew diubah menjadi **OSD (0/90/180/270°) dulu → hough-lite → sidecar OpenCV → projection** agar halaman terrotasi 90° tidak tertahan oleh sudut palsu hough-lite, sidecar deskew (OpenCV ±30° + perspective) diaktifkan via `DESKEW_SERVICE_URL`, dan repair tabel kini memakai gambar yang sudah ter-rectify.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/ocr/deskewRouter.js` | kaskade: hough-lite → sidecar → OSD → projection (OSD terakhir, bisa terlewat) | kaskade **OSD dulu** (0/90/180/270°) → hough-lite (±15°) → sidecar (±30°) → projection; + opsi `skipOsd` (deteksi grid tidak butuh OSD); `_toOsdCanvas()` downscale ≤1MP; OSD timeout `config.osd.timeout` via `Promise.race` |
| `server.js` | `renderPdfImagesWithTableBoost`: `detectTableRegions()` di gambar **mentah** → grid miring tidak terdeteksi | tiap halaman di-rectify dulu (`correctOrientation` + `deskewImage({skipOsd:true})`) **sebelum** `detectTableRegions()` → halaman tabel miring masuk `tablePages` → render 3.0× + jalur repair aktif |
| `src/ocr/router.js` | `repairTableBlocks(imageBuffers[i])` — canvas **mentah** | repair pakai gambar ter-rectify dari `_preprocessedCache[i][bestRetry]` (fallback raw); `_stepsForRetry` retry 2 = +`upscale`+`denoise`+**`perspective`** |
| `src/ocr/tableRegionOcr.js` | `repairTableBlocks` detect region di canvas asli; crop deskew full-cascade (OSD per sel — lambat) | + deskew defensif (`skipOsd`) di awal `repairTableBlocks`; crop deskew pakai `skipOsd` (sel tidak mungkin rotasi 90° sendiri) |
| `.env` | `OCR_PREPROCESS_STEPS=grayscale,threshold,rotate,deskew-adaptive,perspective`; `DESKEW_SERVICE_URL=` (kosong) | steps: `rotate,deskew-adaptive,perspective,grayscale,threshold` — rectify dulu di gambar berwarna, binarize terakhir; `DESKEW_SERVICE_URL=http://localhost:5002` (sidecar hidup) |
| `test.js` | 126 tes | + 3 tes = **129 passed**: `detectTableRegions` grid miring → 0 region (dokumentasi bug), kontras grid 0° vs miring 4°, `detectSkewHoughLite` deteksi sudut grid |

### detail

**Kaskade deskew baru** (`deskewImage`):
```
OSD (0/90/180/270°) → hough-lite (±15°) → sidecar OpenCV (±30°) → projection (±5°)
```
- OSD dulu karena hough-lite pada halaman yang terrotasi 90° bisa menemukan sudut kecil palsu (baris teks vertikal), lalu rotate ±3° dan return lebih awal — OSD tidak pernah dieksekusi, halaman tetap miring 90°.
- Jika OSD menemukan orientasi ≠ 0 dengan confidence ≥ ambang → rotasi langsung, hough di-skip.
- `skipOsd: true` untuk jalur yang hanya butuh fine-deskew (deteksi grid pass 1, crop sel repair) — menghindari biaya Tesseract worker per halaman/sel.

**Rectify sebelum deteksi grid** (`renderPdfImagesWithTableBoost`):
- Pass 1 (scale 1.0): `correctOrientation` (landscape → -90°) + `deskewImage({skipOsd:true})` per halaman → baru `detectTableRegions()`.
- Sebelumnya `_detectHorizLines`/`_detectVertLines` menscan baris/kolom penuh (densitas ≥ 60%): grid miring hanya menutupi diagonal → 0 region → halaman tidak diklasifikasi tabel → tidak di-render 3.0× dan repair tidak jalan.

**Sidecar deskew aktif**: `DESKEW_SERVICE_URL=http://localhost:5002` — Hough OpenCV ±30° (melampaui hough-lite ±15°) dan `correct-perspective` tidak lagi no-op. Jalankan: `python sidecar/deskew.py` atau `docker-compose up deskew-sidecar`. Fallback aman jika mati.

---

## Changelog — 2026-07-31 (v20)

### ringkasan
Perbaikan OCR untuk **dokumen scan dengan tabel miring**: Hough-lite pure-JS untuk deskew sudut ±15° (tanpa sidecar), perspective correction diaktifkan, OCR per-region tabel (bukan whole page), render scale lebih tinggi untuk halaman scan & halaman tabel, retry yang benar-benar bervariasi (preprocessing → DPI → engine), dan deteksi garbage CJK agar halaman dengan sampah simbol (楼/绿 dll) memicu retry.

### file baru

| File | keterangan |
|---|---|
| `src/ocr/tableRegionOcr.js` | Deteksi region tabel berbasis piksel (grid line detection) + `ocrTableRegions()` (crop → upscale 2× → deskew → OCR) + `repairTableBlocks()` (ganti blok garbage dalam region) |

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/ocr/deskewRouter.js` | deskew hanya via sidecar/OSD/projection ±5° | + `detectSkewHoughLite()` + `tryHoughLite()` — Hough transform pure-JS (downsample ≤1MP → Otsu → gradient edge → accumulator θ=90°±limit, step 0.5° → median weighted + confidence). Cascade: **hough-lite → sidecar → OSD → projection**. Rotasi koreksi `rotateCanvas(-angle)` (konvensi OpenCV) |
| `src/ocr/router.js` | retry pakai **gambar preprocess yang sama** (cache statis per halaman), hanya ganti engine; `selectRetryStrategy` dead code | `_stepsForRetry()`: retry 0 = steps default, retry 1 = +upscale, retry 2 = +upscale+denoise; `_engineForRetry()`: engine alternatif (`auto`) di retry akhir; cache per `{halaman, retry}`; setelah loop → **region repair**: `repairTableBlocks()` pada canvas original → blok baru menggantikan blok dalam region tabel, score dihitung ulang |
| `src/ocr/preprocessor.js` | steps: grayscale, threshold, denoise, deskew, deskew-adaptive, perspective, rotate | + step `upscale` (faktor dari `options.upscaleFactor`, dipakai retry); fix Otsu `>` → `>=` (threshold 0 untuk gambar 2-level murni) |
| `src/ocr/qualityMetrics.js` | garbage hanya digit pendek (`!hasAlpha && digitRatio > 0.5`) — sampah CJK lolos | + `isGarbageWord()`: CJK murni pendek, campuran Latin+CJK ≤ 4 char, digit+CJK ≤ 6 char → garbage; `computePageScore` + `cjkWords`; `isGarbageWord` di-export |
| `src/pdf/imageConverter.js` | `tablePages` → scale ×1.5 (dari base) | + opsi `tableScale` eksplisit (default `scale*1.5`); dukungan kombinasi `{scale, tablePages, tableScale}` non-adaptive |
| `src/config/index.js` | `table.detect/preserveGrid/splitCells` | + `table.renderScale` (`TABLE_RENDER_SCALE`, default 3.0) |
| `server.js` | SCAN: `convertPdfToImages({adaptive:true})` — `tablePages` kosong | + `renderPdfImagesWithTableBoost()`: pass 1 render scale 1.0 → `detectTableRegions()` per halaman → `tablePages` → re-render base `PDF_RENDER_SCALE` (2.0), halaman tabel di `TABLE_RENDER_SCALE` (3.0). Dipakai di pipeline & legacy path |
| `.env` | `OCR_PREPROCESS_STEPS=grayscale,threshold,rotate`, `PDF_RENDER_SCALE=1.5`, `DESKEW_PERSPECTIVE=false`, `PERSPECTIVE_ENABLED=false` | `grayscale,threshold,rotate,deskew-adaptive,perspective`; `PDF_RENDER_SCALE=2.0`; `DESKEW_PERSPECTIVE=true`; `PERSPECTIVE_ENABLED=true`; + `TABLE_RENDER_SCALE=3.0` |
| `src/ocr/engines/paddleEngine.js`, `tesseractEngine.js` | empty catch `{}` (error lint) | + komentar di catch block |
| `src/ocr/engine.js` | unused `config`, `logger` | dihapus |
| `src/ocr/tableDetector.js` | trailing comma hilang (warning lint) | diperbaiki |
| `test.js` | 113 tes | + 13 tes section `=== 12. Deskew Hough-lite & Region OCR ===` = **126 passed, 0 failed** |

### detail

**Hough-lite pure-JS** (`detectSkewHoughLite`):
- Downsample ≤ 1MP → grayscale → Otsu → edge pixel (gradient magnitude ≥ 60) → accumulator Hough 2D `(theta, rho)` dengan theta = `90° ± maxAngle`, step 0.5° (baris teks ≈ horizontal → normal di ±90°)
- Peak per theta (bukan total vote — total vote tersebar merata ke semua theta) → median weighted dari theta di atas 60% peak → `{angle, confidence}`
- Koreksi: `rotateCanvas(canvas, -angle)` — konvensi OpenCV (rotasi canvas berlawanan dengan matrix OpenCV)
- Test: garis sintetik +3°/-8° terdeteksi ±1.5°, blank/horizontal → null

**Region OCR tabel** (`tableRegionOcr.js`):
- `detectTableRegions(canvas)`: run-length horizontal/vertikal (densitas ≥ 60% lebar/tinggi) → garis grid → interval antar garis horizontal + garis vertikal → bbox region → merge region berdampingan (gap < 10px)
- `ocrTableRegions()`: crop + padding 12px → upscale 2× → `deskewImage()` → grayscale+threshold → `recognizeBlocks()` → bbox dikembalikan ke koordinat halaman
- `repairTableBlocks()`: dipanggil di `_recognizePageCascade` setelah semua retry — blok dalam region tabel diganti blok OCR region (hanya jika score membaik)

**Retry adaptif** (`router.js`):
- retry 0: steps default; retry 1: + `upscale` (1.5×); retry 2: + `upscale` (3.0×) + `denoise`
- Engine: retry terakhir pakai `auto` (surya→tesseract→paddle) — **preprocessing/DPI didahulukan, engine baru diganti saat kualitas masih rendah** (italic/tipis)
- Cache `_preprocessedCache[i][retry]` — tiap retry gambar berbeda (sebelumnya sama persis)

**Render scale** (`server.js`):
- Pass 1 render scale 1.0 (deteksi grid cepat) → halaman bertabel di-render ulang scale 3.0×, halaman lain 2.0× (naik dari 1.5)
- Fallback aman: `TABLE_DETECT=false` → semua halaman 2.0×

### catatan
- Perspective correction butuh sidecar `sidecar/deskew.py` port 5002 (`DESKEW_SERVICE_URL=http://localhost:5002`) — tanpa sidecar → no-op aman
- Trade-off: deskew hough-lite ±1 dtk/halaman; re-render halaman tabel 3.0× menambah memori (±80 MB RGBA per halaman A4)

---

## Changelog — 2026-07-31 (v19)

### ringkasan
Tahap 2 — Perbaikan struktur pohon dokumen di `documentTreeBuilder`: hierarki heading (BAB→BAGIAN→PARAGRAF→PASAL→AYAT) yang sebelumnya rata di root, pemisahan paragraf per halaman & per marker ayat/huruf, interleave tabel di posisi aslinya, deteksi judul dokumen, dan perbaikan render BAB.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/reconstruction/builder/documentTreeBuilder.js` | semua heading jadi child root (branch `node.type === 'heading'` tak pernah true), pasal tidak pernah di-pop dari stack, paragraf gabung lintas halaman, tabel di-push ke akhir, BAGIAN level `stack.length >= 2 ? 3 : 2`, `_groupIntoParagraphs` menghilangkan baris heading | heading di-push ke stack (`while (stack.length - 1 >= level) pop`), pasal di-pop sebelum pasal baru (sibling, bukan child), paragraf di-flush saat ganti halaman/baris kosong/marker `(n)` & `a.`, `_groupIntoParagraphs(lines, skipIdx)` simpan `_startIdx`, group punya `pos` + sort → tabel interleave di posisi asli, BAGIAN level 2 konstan, deteksi judul (`PERATURAN/KEPUTUSAN/...` + panjang/NOMOR/TAHUN/TENTANG → node `title`), `_createNode` strip marker `(1)`/`a.` dari baris pertama ayat/huruf/angka |
| `src/reconstruction/output/markdownGenerator.js` | BAB render `## I BAB I ...` (dobel nomor) | BAB pakai title langsung jika sudah diawali `BAB`; + render `title` → bold |
| `src/reconstruction/output/htmlGenerator.js` | — | + CSS `.title` (bold, center) |
| `src/reconstruction/analyzer/documentAnalyzer.js` | dupe key `%PDF` di MAGIC_NUMS (error lint), MAGIC_NUMS/PAGE_SIZE_THRESHOLD unused | dihapus |
| `test.js` | 106 tes | + 7 tes struktur (nested heading, split per halaman, interleave tabel, judul, title bold, split ayat/huruf, BAB heading) = **113 passed, 0 failed** |
| `AGENTS.md` / `AGENTS_QUICK.md` | — | + catatan Tahap 2 |

### detail

**Hierarki heading** (sebelumnya rusak — `node.type === 'heading'` tidak pernah diproduksi oleh `_classifyParagraph`, sehingga semua heading menjadi child root; pasal berurutan menjadi child pasal sebelumnya):
```
root
├── title (baru — deteksi judul dokumen)
├── bab I
│   └── bagian
│       └── paragraf
│           ├── pasal 1
│           │   ├── ayat (1)
│           │   ├── huruf a.
│           │   └── ayat (2)
│           └── pasal 2
└── bab II (sibling bab I — `>= level` di pop condition)
```

**Interleave tabel**: `detectTableFromLines` mengembalikan `startIdx` di array baris asli; tiap group (paragraph/table ASCII/table grid) diberi `pos` lalu di-sort — tabel tidak lagi dipindah ke akhir dokumen.

**Paragraf per halaman**: `_groupIntoParagraphs` men-flush saat `line.page` berubah, sehingga paragraf tidak menggabung baris dari halaman berbeda.

**Marker ayat/huruf**: baris `(1) ...`, `a. ...`, `1. ...` memulai node baru (bukan menjadi bagian paragraph sebelumnya); `_createNode` menghapus marker dari `text` agar render tidak dobel (`(1) (1) ...`).

### bug yang ditemukan saat verifikasi
- `_groupIntoParagraphs` v18 menghilangkan SEMUA baris heading (lupa `current = [line]` sebelum flush) → `tree = title,ayat,ayat,ayat` — diperbaiki di v19.
- Pasal berurutan menjadi child pasal sebelumnya (stack tidak di-pop) → Pasal 2 nested di dalam Pasal 1 — diperbaiki.
- BAB II menjadi child BAB I (`>` bukan `>=` di pop condition) — diperbaiki.

---

## Changelog — 2026-07-31 (v18)

### ringkasan
Tahap 1 — Validasi kualitas OCR per halaman, fallback engine, dan review otomatis struktur dokumen hukum. Halaman kualitas rendah **ditandai LOW QUALITY (tetap dipakai)**, review **laporan saja** (tidak auto-fix). Berlaku di alur pipeline & legacy.

### file baru

| File | keterangan |
|---|---|
| `src/reconstruction/review/documentReviewer.js` | Review otomatis: skor 0–1 + daftar issue terurut severity. Cek urutan BAB/Pasal/Ayat (tidak turun, tidak duplikat, ayat mulai dari (1)), penempatan heading (Pasal/Bagian/Paragraf tanpa BAB, orphan ayat/huruf), tabel (kosong, posisi akhir), judul + Menimbang, urutan halaman monoton, blok LOW QUALITY |

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/ocr/qualityMetrics.js` | hanya confidence score | + `computeQualityScore(blocks)` — komposit `0.5*conf + 0.35*(1-garbageRatio) + 0.15*min(wordCount/20,1)`; + `shouldAcceptPage()` (minWordCount 5, minConfidence 0.3, maxGarbageRatio 0.4, minQualityScore 0.3); `selectRetryStrategy()` sekarang juga set engine (`auto` di tiap retry), DPI naik 1.5→2.0→2.5 |
| `src/ocr/router.js` | kaskade retry per halaman, tanpa fallback engine | ditulis ulang: `getEngineCandidates()` (auto → surya→tesseract→paddle; preferred+sisanya), cache engine, kaskade **engine × retry** per halaman, pilih hasil terbaik (skor komposit), `results.pageQuality[]` per halaman (`{page, accepted, lowQuality, score, ...}`), blok diberi `quality:'low'`, `resetEngine()`. API `engine.js` tidak berubah |
| `src/reconstruction/pipeline.js` | tanpa review | + stage review (progres 0.7) setelah legalParser → `ctx.review`; gate `config.review.enabled`; `doc.review` |
| `src/reconstruction/index.js` | — | + pass `config.review` ke Pipeline |
| `src/reconstruction/models/documentModel.js` | `Document` tanpa review | + properti `review` + `toJSON().review` |
| `server.js` | `result.reconstruction` tanpa review | + `review` (score, issueCount, top 10 issues) di response; legacy path: append catatan `[CATATAN: N halaman LOW QUALITY]` + log warning jika ada halaman kualitas rendah |
| `.env` | 91 baris | + `OCR_ENGINE_FALLBACK` (true), `OCR_QUALITY_GATE` (true), `OCR_MIN_WORD_COUNT` (5), `OCR_MAX_GARBAGE_RATIO` (0.4), `REVIEW_ENABLED` (true), `REVIEW_MAX_ISSUES` (50) |
| `src/config/index.js` | 7 section | + `ocr.engineFallback/qualityGate/minWordCount/maxGarbageRatio` + section `review` |
| `test.js` | 92 tes (88 jalan) | + 18 tes section `=== 11. Review & Kualitas ===` = **106 passed, 0 failed** |
| `AGENTS.md` / `AGENTS_QUICK.md` | — | + konfigurasi & fitur baru |

### detail

**Skor halaman** (`computeQualityScore`): gabungan confidence, garbage ratio, dan word count; `shouldAcceptPage()` membandingkan dengan ambang — jika lolos, halaman diterima tanpa retry; jika tidak, retry berikutnya.

**Kaskade engine** (`_recognizePageCascade` di `router.js`): tiap retry mencoba semua engine kandidat (preferred dulu), skor komposit dihitung per hasil, hasil terbaik disimpan. Setelah `OCR_MAX_CONFIDENCE_RETRIES` habis, hasil terbaik dipakai dengan `accepted:false` → ditandai LOW QUALITY (teks tetap dipakai).

**Review** (`documentReviewer.js`): severity error (0.25) / warning (0.10) / info (0.03); skor = `max(0, 1 - total bobot)`; issue diurutkan severity lalu dipangkas `REVIEW_MAX_ISSUES`. Tipe issue: `bab-order`, `bab-duplicate`, `pasal-order`, `pasal-duplicate`, `ayat-order`, `ayat-start`, `heading-parent`, `orphan-ayat`, `orphan-item`, `table-empty`, `table-position`, `title-missing`, `preamble-missing`, `page-order`, `low-quality`.

**Catatan quirk test**: test.js mendefinisikan 92 tes tapi hanya 88 yang jalan (4 `testAsync` tidak di-await). Setelah +18 tes sync → 106 lulus. Jumlah terdefinisi sekarang 110.

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

---

## Changelog — 2026-07-30 (v15)

### ringkasan
Implementasi **Document Reconstruction Pipeline** — pipeline modular 16 file untuk mengonversi PDF dokumen hukum Indonesia menjadi representasi terstruktur (Markdown, HTML, Semantic JSON, Chunks). Pipeline terintegrasi ke `server.js` via switch `RECONSTRUCTION_ENABLED=true/false` (default `false` untuk backward compat).

### file baru

| File | keterangan |
|---|---|
| `src/reconstruction/models/documentModel.js` | Class definitions: BBox, Block, Line, Paragraph, Heading, Table, ListItem, Node, DocumentNode, Document, LEGAL_TYPES |
| `src/reconstruction/pipeline.js` | Pipeline orchestrator — 13 stage runner dengan progress callback |
| `src/reconstruction/index.js` | Entry point `runReconstruction()` |
| `src/reconstruction/analyzer/documentAnalyzer.js` | Deteksi tipe PDF (digital/scan), grouping per halaman |
| `src/reconstruction/analyzer/textExtractor.js` | Ekstrak teks dari PDF digital (wrapper pdf-parse) |
| `src/reconstruction/builder/readingOrderResolver.js` | Urutkan blok OCR berdasarkan posisi (Y→X) |
| `src/reconstruction/builder/lineMerger.js` | Gabung blok sebaris (threshold Y) |
| `src/reconstruction/builder/documentTreeBuilder.js` | Bangun pohon dokumen: deteksi BAB/Bagian/Paragraf/Pasal/Ayat/Huruf |
| `src/reconstruction/builder/legalParser.js` | Tag komponen hukum: Menimbang/Mengingat/Memutuskan/Menetapkan |
| `src/reconstruction/output/markdownGenerator.js` | Output Markdown dengan heading/pasal bold/indent |
| `src/reconstruction/output/htmlGenerator.js` | Output HTML + CSS inline |
| `src/reconstruction/output/semanticJsonGenerator.js` | Output JSON semantik `{type, number, title, children}` |
| `src/reconstruction/output/chunkBuilder.js` | Chunking untuk RAG: size + overlap, metadata per chunk |
| `src/reconstruction/output/embeddingFormatter.js` | Format chunk untuk embedding input + RAG format |
| `src/reconstruction/debug/visualDebugger.js` | Debug tree HTML interaktif + JSON dump |

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/ocr/interface.js` | 3 methods (init, recognize, recognizePage) | + `recognizeBlocks(image)` — return blocks dengan bbox+confidence |
| `src/ocr/router.js` | export `performOcr`, `performOcrWithEngine` | + `performOcrBlocks(imageBuffers, onProgress)` — return structured blocks |
| `src/ocr/engine.js` | export `performOcr`, `formatOcrResult` | + `performOcrBlocks` re-export |
| `src/config/index.js` | 5 section (outputDir–db) | + `reconstruction` section (enabled, debug, debugDir, chunkSize, chunkOverlap, outputFormat) |
| `.env` | 49 baris | + 6 var reconstruction |
| `server.js` | `processBuffer()` hanya legacy path | + pipeline path saat `RECONSTRUCTION_ENABLED=true`: `performOcrBlocks` → `runReconstruction` → output markdown/html/json/chunks |
| `test.js` | 59 tests | + 29 tests reconstruction pipeline = **88 total** |
| `AGENTS_QUICK.md` | 143 baris | + Reconstruction Pipeline section, update arsitektur, update test count |

### perubahan detail

**`server.js`** — perubahan di `processBuffer()`:
- Import baru: `runReconstruction`, `performOcrBlocks`
- Branch baru (baris 48-85): jika `config.reconstruction.enabled`:
  - SCAN: `convertPdfToImages` → `performOcrBlocks` (return blocks dengan bbox, confidence, page)
  - TEXT: langsung ke pipeline tanpa OCR
  - `runReconstruction(pdfBuffer, ocrBlocks)` → return Document object
  - `result.text` = `doc.markdown`, ditambah `result.reconstruction` (chunks count, html, json)
- Legacy branch tetap utuh untuk `RECONSTRUCTION_ENABLED=false` (default)

### Data model classes (`documentModel.js`)
- **BBox** — bounding box dengan `centerX()`, `centerY()`, `overlaps(other, threshold)`
- **Block** — unit terkecil dari OCR (text, confidence, bbox, page, order, source)
- **Line** — gabungan blocks sebaris
- **Paragraph** — kumpulan lines, parent container
- **Heading** — node heading dengan level, number, originalType
- **Table** — headers + rows, method `toMarkdown()`
- **ListItem** — list dengan level, number, marker
- **Node** — generic tree node generic
- **DocumentNode** — tree node dengan type/originalType/number/title/text, method `toJSON()`, `flatten()`
- **Document** — result container: title, pages, sections, root, markdown, html, json, chunks

### Pipeline flow
```
Pipeline.run(pdfBuffer, ocrBlocks)
  │
  ├─ 0%  documentAnalyzer.analyze() — deteksi type, group pages
  ├─ 5%  [TEXT] textExtractor.extract() — pdf-parse
  │      [SCAN] ocrBlocks langsung dari performOcrBlocks
  ├─ 30% readingOrderResolver.resolve() — sort by Y→X
  ├─ 40% lineMerger.merge() — gabung blocks sebaris jadi Line
  ├─ 50% documentTreeBuilder.build() — bangun pohon (BAB→Pasal→Ayat)
  ├─ 65% legalParser.parse() — tag Menimbang/Mengingat/dll
  ├─ 75% markdownGenerator.generate()
  ├─ 80% htmlGenerator.generate()
  ├─ 85% semanticJsonGenerator.generate()
  ├─ 90% chunkBuilder.build() — chunk size 1000, overlap 200
  ├─ 95% embeddingFormatter.format()
  └─ 100% Document object
```

### 29 test baru di section `=== 10. Reconstruction Pipeline ===`:
Model: BBox centerX/Y, overlap, DocumentNode constructor/toJSON/flatten, Table toMarkdown, Document constructor/toJSON.
Resolver: posisi, empty, fallback order.
Merger: merge adjacent, separate by Y.
TreeBuilder: BAB detection, pasal, ayat (dengan parent pasal), empty.
LegalParser: document type, menimbang.
Generators: markdown bab/pasal, html, semanticJson.
Chunker: chunk creation, empty input.

---

## Changelog — 2026-07-30 (v16)

### ringkasan
Implementasi 5 fitur untuk menangani dokumen scan sulit: deskew adaptif multi-engine, confidence-based retry, adaptive DPI rendering, table detection multi-engine, cell-level OCR, dan perspective correction.

### file baru

| File | keterangan |
|------|------------|
| `sidecar/deskew.py` | FastAPI sidecar port 5002: Hough Transform skew + perspective correction. 4 endpoint: `/detect-skew`, `/deskew`, `/correct-perspective`, `/deskew-full` |
| `src/ocr/deskewRouter.js` | Orchestrator deskew: Tesseract OSD (0/90/180/270°) → Hough sidecar (±30°, 0.1°) → Projection profile (±5° fallback) |
| `src/ocr/qualityMetrics.js` | Page scoring (confidence, garbageRatio, wordCount), `shouldRetry()`, `selectRetryStrategy()` — backbone confidence retry |
| `src/ocr/adaptiveRenderer.js` | Per-page adaptive DPI: `renderPageAdaptive()` — scale 1.5×–2.5× untuk halaman tabel/retry |
| `src/ocr/tableDetector.js` | `detectTableStructure()` — PP-StructureV3 → Surya → heuristic (digit line + column alignment) |
| `src/ocr/cellOcr.js` | `ocrTableCell()` (crop + 2× OCR), `reconstructTableFromBlocks()`, `formatAsciiTable()` (border + wrapping) |

### file diubah

| File | sebelum | sesudah |
|------|---------|---------|
| `src/pdf/detector.js` | threshold 50 chars, tanpa heuristic | threshold 200 chars + `estimateImageContent()` (XObject/image count vs text ops) |
| `src/pdf/imageConverter.js` | `convertPdfToImages()` fixed scale | + `renderPage(doc, pageNum, scale)`, + `openDocument()`, + `{adaptive, tablePages}` options |
| `src/ocr/preprocessor.js` | hanya projection deskew ±5° | + import `deskewImage`, + `case 'deskew-adaptive'` step (multi-engine cascade) |
| `src/ocr/router.js` | OCR tanpa retry | + confidence-based retry loop per-page, preprocessing alternatif tiap retry, engine fallback |
| `src/services/structureService.js` | sidecar hanya jika STRUCTURE_SERVICE_URL | selalu coba PP-StructureV3 → Surya → standard OCR cascading |
| `src/utils/textCleaner.js` | `isTableGarbage()` tanpa proteksi false positive | + `hasLongWord >= 6` guard, + extended Unicode letter regex |
| `server.js` | SCAN path: `performOcr` atau `performStructuredOcr` | SCAN path: `performStructuredOcr` default, `convertPdfToImages` pakai `{adaptive: true}` |
| `src/config/index.js` | 6 section | + `deskew` section (engine, serviceUrl, minConfidence, perspectiveCorrection, maxAngle) |
| `.env` | 57 baris, 7 section | + 8 var baru (deskew, retry, preprocess config) |
| `docker-compose.yml` | 5 services | + `deskew-sidecar` (port 5002), app env vars untuk deskew + retry |
| `AGENTS.md` | 900 baris | + 6 fitur baru di Notes, + Deskew/Adaptive/Sidecar di Konfigurasi, + Changelog v16 |

## Changelog — 2026-07-30 (v17)

### ringkasan
Perbaikan deteksi orientasi landscape (height < width → rotate -90°), heuristic table detection dari blok OCR, preservasi simbol Unicode, dan reorganisasi preprocessing config.

### perubahan

| File | sebelum | sesudah |
|------|---------|---------|
| `.env` | `PREPROCESS_STEPS=grayscale,threshold,rotate,deskew-adaptive` | `grayscale,threshold,rotate` — deskew-adaptive tidak default; +15 var baru: projection, osd, perspective, table |
| `src/config/index.js` | 6 section (outputDir–deskew) | +4 section: `projection`, `osd`, `perspective`, `table`; deskew maxAngle default → 15 |
| `src/ocr/orientationDetector.js` | 85 baris: projection peaks + density + threshold kompleks | **Simplifikasi**: 9 baris efektif. Landscape (h<w) → rotate -90° langsung. Portrait skip. **CJK hilang** |
| `src/ocr/deskewRouter.js` | export `{deskewImage, correctPerspective}` | + export `tryTesseractOsd`; maxAngle dinamis dari config |
| `src/ocr/preprocessor.js` | import `{deskewImage}` | + import `correctPerspective`; + `case 'perspective'` step |
| `src/ocr/tableDetector.js` | `detectTableStructure(canvas)` — sidecar + heuristic | + `detectTableFromLines(lines)` — grid detection Y→X dari blok OCR tanpa sidecar |
| `src/ocr/cellOcr.js` | `clusterBlocksToGrid` ROW_THRESHOLD=15 hardcoded | threshold adaptif `max(8, avgH*0.8)`; + `SYMBOL_MAP`; + `fixTableCellSymbol()` |
| `src/utils/textCleaner.js` | `cleanText` strip semua non-Latin | + range Unicode: arrows, misc symbols, dingbats (✓, ☐, → preserved) |
| `src/reconstruction/builder/documentTreeBuilder.js` | `_detectTables` hanya ASCII (`\|`, `+`) | + `detectTableFromLines()` integration; lines tabel dipisah, sisanya proses normal; `Table` node di-inject tree |
| `src/reconstruction/pipeline.js` | `ocrBlocks.length > 0` check | + debug logging tiap stage |
