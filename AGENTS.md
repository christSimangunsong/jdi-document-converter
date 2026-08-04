# AGENTS.md — jdi-document-converter

> Compact instructions for OpenCode sessions. Full progress log (changelog): **`CHANGELOG.md`** — add new entries there (top of file). The v1–v17 history is also preserved below the `---` divider (nothing deleted).
>
> For an even shorter version, see `AGENTS_QUICK.md`.

## Architecture

| Entry | File | Reconstruction | DB save |
|-------|------|----------------|---------|
| CLI | `app.js` | Legacy (stops after `cleanText()`) | No |
| Web | `server.js` | **Legacy** (`RECONSTRUCTION_ENABLED=false`, default) **or Pipeline** (`RECONSTRUCTION_ENABLED=true`) | `POST /api/activities/save` |

**Pipeline** (RECONSTRUCTION_ENABLED=true): `downloadPdf` → `detectPdfType` → [TEXT: `textExtractor` | SCAN: `convertPdfToImages→performOcrBlocks`] → `runReconstruction` → Markdown/HTML/JSON/Chunks

**Legacy** (default): `downloadPdf` → `detectPdfType` → `extractText` (TEXT) / `convertPdfToImages→performOcr|performStructuredOcr` (SCAN) → `cleanText` → `rebuildDocumentStructure` → output `.txt`

## Commands

| Command | Function |
|---------|----------|
| `npm start` | Web server `localhost:3000` |
| `npm run cli` | CLI batch from `data/links.json` |
| `npm test` | `node --experimental-vm-modules test.js` (170 unit tests) |
| `npm run lint` | `eslint .` |
| `npm run format` | `prettier --write "**/*.{js,json,css,html}"` |
| `npm run benchmark` | Run OCR engine benchmarks |

## Routes (Web)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/process-url` | Body `{url, nama?}` |
| POST | `/process-urls` | `{urls:[]}` (max 20) **SSE streaming FIFO** |
| POST | `/process-upload` | Multipart field `pdf` |
| POST | `/process-uploads` | Multipart field `pdf` (max 20) **SSE streaming FIFO** |
| GET | `/download/:file` | Download `.txt` — file di `outputDir`, **fallback ke `output_text` DB** (v29.5) |
| GET | `/api/activities` | List activities |
| GET | `/api/activities/stats` | Summary + daily group 7 days |
| GET | `/api/activities/:id` | Detail by ID |
| POST | `/api/activities/save` | Save text + metadata to DB (JSON body); **file cache `output/*.txt` dihapus otomatis setelah sukses** (v29.5) |
| DELETE | `/api/activities/:id` | Delete activity + `.txt` file |
| GET | `/api/report/download` | `?from=&to=&format=xlsx\|csv` |

Batch routes use SSE streaming (events: `progress`, `result`, `error`, `done`). Single routes return JSON.

## CJS / ESM Hybrid

CJS project (`require`) with **3 dynamic ESM imports**. Do NOT convert to `require()` — will error.

| File | Dynamic import |
|------|---------------|
| `src/pdf/imageConverter.js:11` | `import('pdfjs-dist/legacy/build/pdf.mjs')` |
| `src/pdf/imageConverter.js:26` | `import('@napi-rs/canvas')` |
| `src/ocr/engines/paddleEngine.js:13` | `import('ppu-paddle-ocr')` |

## Gotcha — Buffer/Uint8Array/Canvas

`pdfjs-dist` v4 and `ppu-paddle-ocr` require `Uint8Array`/`Canvas`, reject `Buffer`.

- `imageConverter.js:34` — `new Uint8Array(buffer)` before `pdfjs.getDocument()`
- `imageConverter.js:79` — push `Canvas` directly, avoid `toBuffer()`
- `paddleEngine.js:25` — `recognize()` accepts `Canvas` (which has `.toBuffer()`)
- `imageConverter.js:11-18` — pdfjs-dist worker path resolved from `require.resolve('pdfjs-dist/package.json')` + `url.pathToFileURL()`

## Status & Duplication

`processBuffer()` returns status: `BERHASIL`, `GAGAL`, `RUSAK`, `KOSONG`.

- 0 byte → **KOSONG**; pipeline throws → **RUSAK**; `cleanText()` empty → **KOSONG**; download fails → **GAGAL**
- SHA256 hash checked at `POST /api/activities/save`: if hash exists AND `output_text IS NOT NULL` → DUPLICATE, rejected
- `getActivities()` / `getStats()` only return records with `output_text IS NOT NULL`

## OCR Engine

Pluggable architecture in `src/ocr/`:

| Engine | Class | Type | Config value |
|--------|-------|------|-------------|
| PaddleOCR | `paddleEngine.js` | Local (default) | `paddle` |
| Tesseract.js | `tesseractEngine.js` | Local | `tesseract` |
| Surya | `suryaEngine.js` | Sidecar (`surya-sidecar:5001`) | `surya` |

- `OCR_ENGINE=paddle|tesseract|surya|auto` in `.env` (default: `paddle`)
- `auto` tries surya → tesseract → paddle fallback
- Interface: `init()`, `recognize(image)`, `recognizePage(image)`, `recognizeBlocks(image)` (returns structured blocks with bbox+confidence), `destroy()`
- `performOcrBlocks()` used by Reconstruction pipeline

## Sidecars

| Sidecar | Port | Service | Purpose |
|---------|------|---------|---------|
| PP-StructureV3 | 5000 | `sidecar/main.py` (FastAPI) | Layout-aware OCR + table recognition |
| Surya | 5001 | `sidecar/surya/` | Alternative OCR engine |
| Deskew | 5002 | `sidecar/deskew.py` (FastAPI) | Hough Transform skew detection + perspective correction |
| Table-OCR | 5003 | `sidecar/table_ocr/` (FastAPI) | Hybrid img2table + PaddleX structured table OCR |

- PP-StructureV3: `POST /analyze` accepts base64 images, returns per-page text + table HTML
- If `STRUCTURE_SERVICE_URL` unset or unreachable → fallback to modular OCR engine
- Surya: used when `OCR_ENGINE=surya`
- Per-page error: failed pages return empty text, remaining pages continue
- Table-OCR: `POST /analyze` accepts `{pages: [{image, engine}]}` — engine `img2table` (borderless, ~2 s/page) or `paddlex` (`table_recognition` v1 SLANet, grid wired + colspan, ~9 min/page CPU). Engine dipilih Node via `detectWiredGridRegions()` (gate piksel ~140 ms/page: Otsu + run-length per band, ≥3 inner vertikal, margin 5% tepi — tanpa fallback horiz-only). Env PaddleX wajib: `PADDLE_PDX_MODEL_SOURCE=modelscope`, `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True`, `PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT=False`, `FLAGS_use_mkldnn=0`, paddle 3.3.1; **jangan** `FLAGS_enable_pir_api=0`. `pipe.predict(path)` positional. PP-StructureV3 crash di CPU → jangan dipakai.

## Image Preprocessor

`src/ocr/preprocessor.js` — enabled via `OCR_PREPROCESS=true`:
- `grayscale`, `denoise` (3×3 median), `threshold` (adaptive), `deskew`

Steps configured via `OCR_PREPROCESS_STEPS=grayscale,denoise,threshold` (comma-separated).

## Benchmark

`npm run benchmark -- --dir ./benchmark/test-set --engines paddle,tesseract,surya`

- Each document needs paired `.pdf` + `.gt.txt` (ground truth)
- Metrics: CER, WER, confidence, speed (pg/s), layout/table/structure quality
- Output: `benchmark/results/` (HTML + JSON)

## Configuration

`.env` variables (see `src/config/index.js` for defaults):

| Group | Key variables |
|-------|--------------|
| Paths | `OUTPUT_DIR`, `LOG_DIR`, `linksPath` hardcoded to `./data/links.json` |
| Retry | `MAX_RETRIES` (3), `RETRY_DELAY_MS` (2000), `DOWNLOAD_TIMEOUT` (60000) |
| OCR | `OCR_ENGINE`, `OCR_LANG` (id), `OCR_PREPROCESS`, `OCR_PREPROCESS_STEPS` (`grayscale,threshold,rotate,deskew-adaptive,perspective`), `OCR_MIN_CONFIDENCE` (0.3), `OCR_MAX_CONFIDENCE_RETRIES` (2), `OCR_ENGINE_FALLBACK` (true), `OCR_QUALITY_GATE` (true), `OCR_MIN_WORD_COUNT` (5), `OCR_MAX_GARBAGE_RATIO` (0.4) |
| PDF | `PDF_RENDER_SCALE` (2.0) |
| Deskew | `DESKEW_ENGINE` (auto), `DESKEW_SERVICE_URL`, `DESKEW_MIN_CONFIDENCE` (0.3), `DESKEW_PERSPECTIVE` (true), `DESKEW_MAX_ANGLE` (15) |
| Projection | `PROJECTION_MIN_RATIO` (1.8), `PROJECTION_AMBIGUOUS_THRESHOLD` (0.65) |
| OSD | `OSD_ENABLED` (true), `OSD_MIN_CONFIDENCE` (8), `OSD_TIMEOUT` (5000) |
| Perspective | `PERSPECTIVE_ENABLED` (true), `PERSPECTIVE_MIN_AREA` (0.2) |
| Table | `TABLE_DETECT` (true), `TABLE_PRESERVE_GRID` (true), `TABLE_SPLIT_CELLS` (true), `TABLE_RENDER_SCALE` (3.0) |
| Table-Aware | `TABLE_AWARE_ENABLED` (false), `TABLE_AWARE_SERVICE_URL`, `TABLE_AWARE_TIMEOUT` (1800000) |
| DB | `DB_HOST/USER/PASSWORD/NAME/PORT` |
| Sidecar | `STRUCTURE_SERVICE_URL`, `SIDECAR_TIMEOUT` (120s), `SURYA_SERVICE_URL`, `DESKEW_SERVICE_URL`, **`SIDECAR_AUTOSTART`** (true), **`PYTHON_BIN`** (python) |
| Pipeline | `RECONSTRUCTION_ENABLED` (false), `RECONSTRUCTION_DEBUG` (false), `RECONSTRUCTION_DEBUG_DIR` (`./debug`), `RECONSTRUCTION_CHUNK_SIZE` (1000), `RECONSTRUCTION_CHUNK_OVERLAP` (200), `RECONSTRUCTION_OUTPUT_FORMAT` (markdown) |
| Review | `REVIEW_ENABLED` (true), `REVIEW_MAX_ISSUES` (50) |
| Output cleanup | `OUTPUT_CLEANUP_MAX_AGE_DAYS` (30), `OUTPUT_CLEANUP_INTERVAL_MS` (21600000) |

- File name from URL: `extractFileNameFromUrl()` — last segment, strip `.pdf`, sanitize, max 200 chars. Spaces encoded `%20` then `decodeURIComponent()`
- File name from upload: `path.parse(file.originalname).name`
- Multer saves to `uploads/`, cleaned after processing

## Notes

- **DB sumber utama, `output/` hanya cache (v29.5)**: file `.txt` ditulis otomatis saat BERHASIL (cache sesi; branch reconstruction dulu TIDAK menulis — fixed), lalu **dihapus setelah "Simpan ke Database"** (POST `/api/activities/save`); `GET /download/:file` fallback ke `output_text` via `activityLogger.getByFileName()` bila file tak ada; `cleanupOutputDir()` (startup + `setInterval` 6 jam) hapus `*.txt`/`*.md` yang sudah tersimpan di DB atau stale > `OUTPUT_CLEANUP_MAX_AGE_DAYS` (30), file <10 mnt dilewati (anti-race). **Progress SSE detail**: event `progress` = `{pct, fileIndex, totalFiles, fileName, phase, page, totalPages}`; UI menampilkan fase + file i/n + halaman dan "Selesai — N file" 4 dtk di akhir. **Monitoring**: logger winston dual-write — baca `logs/app.log` (jangan redirect stdout).
- **Anti-stuck + table-aware benar-benar jalan (v29.4)**: (1) **bug early-return** di `_recognizePageCascade` (`src/ocr/router.js`): halaman yang DITERIMA gate (`shouldAcceptPage`) di-return **tanpa `image`** → gate `config.tableAware.enabled && outcome.image` di `performOcrBlocks` selalu `false` → **table-aware tidak pernah berjalan untuk dokumen berkualitas baik** (hanya halaman low-quality yang lolos full cascade); fix: sertakan `image: img` di early-return — verifikasi UI Perbub No 21 (digital, 15 hlm): 77 dtk, review 0.94, 8 halaman per-page dikirim ke table-ocr, tanpa hang; (2) **`MAX_PAGE_TIMEOUT=720000`** (12 mnt) di `tableAwareService.js` — PaddleX wired ~9 mnt/halaman CPU, 5 mnt selalu timeout → halaman wired dilewati senyap; per-page POST + `Math.min(timeout, MAX_PAGE_TIMEOUT)`; (3) `docker-compose.yml` pakai `${TABLE_AWARE_TIMEOUT:-720000}` (bukan hardcode 1 jam); `.env` `TABLE_AWARE_TIMEOUT=720000`.
- **Perbaikan generik output rapi (v29.1)**: aturan token terpusat di **`src/utils/garbageTokens.js`** (dipakai `router.js` + `outputCleaner.js` + `documentTreeBuilder.js` — satu sumber kebenaran). Tiga cacat diatasi: (1) `_rescueGarbageBlocks` kini melakukan **pembersihan token TANPA SYARAT untuk SEMUA blok** sebelum cek `needsRescue` — fragmen mirror yang lolos gate ("T E SALINAN L R 3 1 E 5. E") sebelumnya bocor ke output; (2) **aturan run mirror**: ≥2 token bare berurutan (core 1 huruf/angka + punct tepi) yang memuat ≥1 huruf tunggal dihapus — aman untuk "BAB I", "huruf a", "Rp 5.000", "1. Undang-Undang", "kota kecil Kota 1 1", "1: 3:"; (3) **`_filterWholePageGarbageLines` bersihkan token DULU, baru drop baris** — "Pasal 1 国" jadi "Pasal 1" (tidak hilang). Normalisasi tambahan: `normalizeGluedWordNumber` ("TAHUN2020" → "TAHUN 2020", "NOMOR20" → "NOMOR 20"), `normalizeGluedBABRoman` ("BABI" → "BAB I"; "BABINSA" aman), dan `fixInternalDots` ("SAL.INAN" → "SALINAN"; "Drs."/"a.n."/"NIP." aman). **Huruf tunggal setelah penanda daftar dihapus** ("b. I Kelurahan" → "b. Kelurahan" — sisa OCR kolom tabel; "a. 1"/"a. b. c. d." aman). **Baris konsonan-dense dihapus**: ≥5 token dengan ≥70% rasio konsonan tanpa vokal = garbage murni ("| s88rsT smuA rdsqms& ... |" — tabel ter-OCR arah salah; prosa normal & singkatan pendek "APBD DAK DAU" aman). **Sel tabel** juga di-`cleanLineText` saat build tree (`_parseTable` + jalur `detectTableFromLines`) — teks tabel tidak lewat pipeline `cleanLines` (hanya `ctx.lines`) sehingga garbage dalam sel sebelumnya bocor ke markdown. **Fix konkurensi (v29.3)**: `_preprocessedCache` GLOBAL di router.js diganti **cache PER-JOB** (`jobCache` param di `_getPageImage`/`_recognizePageCascade`) — dua konversi paralel sebelumnya saling menimpa cache halaman → "Cannot set properties of undefined" → status RUSAK. Tool verifikasi cepat: **`scripts/verify_output.js`** (analisis file markdown tersimpan: CJK/simbol/mirror-run/TAHUN-menempel — tanpa OCR ulang; `--upload <pdf> <out>`). 187 unit tests. Verifikasi e2e dokumen asli (36 hlm + 18 hlm): chars 147.070 / 38.855, **cjk=0, symbols=0, mirrorRuns=0, glue=0** keduanya.
- **Pemulihan kelengkapan output (v28)**: (1) **`_dedupeConsecutive` DIHAPUS total** (`documentTreeBuilder.js`) — terbukti menghilangkan konten: tiap "line" pipeline = teks SATU HALAMAN PENUH (blok whole-page), header hukum berulang tiap halaman ("BUPATI DAIRI PROVINSI SUMATERA UTARA...") + frasa pasal → overlap token ≥60% antar halaman berurutan → 31/37 baris dibuang → markdown 58.738 → **11.946 char** (13 → 6 children) untuk dokumen 36 hlm; (2) **`repairTableBlocks` pakai cache rectified** (`router.js`) — gambar dasar `_preprocessedCache[i][bestRetry]` (deskew+perspective+threshold) + `rotateCanvas(cached, bestAngle)` bila halaman dikoreksi rotasi fallback (v27: bestImg = canvas mentah/variant tanpa deskew → 0 region → repair skip senyap → tabel hal 30/32 kosong); saat repair berhasil `bestImg = repairImg` → table-aware/rescue dapat gambar bagus; `logger.warn` bila 0 region pada halaman masih jelek. 167 unit tests.
- **Perbaikan kualitas output (v27)**: (1) **`ocrGridCells()`** (`src/ocr/tableRegionOcr.js`) — OCR per-sel berbasis garis grid (rect per sel → `ocrTableCell` 2× → `formatAsciiTable`), menang bila skor `computeQualityScore` > region OCR/whole-page (tanpa regresi), blok whole-page yang kontennya tercakup tabel dibuang; (2) **`repairTableBlocks` dipindah SETELAH fallback rotasi** (`router.js`) — sebelumnya dijalankan sebelum rotasi sehingga grid halaman miring 90° tidak pernah terdeteksi; (3) **loop eskalasi skala anti-mirror** `_reOcrWithScaleEscalation` + `_hasMirrorGarbage` (CJK/Yunani/∪/superscript/box-drawing atau `commonWordRatio === 0`) — upscale 1.5×→2×→2.5×→3× + OCR ulang sampai bersih, hasil terbaik selalu disimpan; (4) **garbage non-Latin** di `isGarbageWord` — simbol ≥40% tanpa Latin ("ν1"), simbol terisolasi ("∪"), superscript berulang ("u¹5nu1¹5aux"), digit-dominan ≤2 huruf ("bo20202", kecuali Rp/angka murni); (5) ~~dedup baris lintas halaman~~ **DIHAPUS v28** (lihat catatan v28). 170 unit tests.
- All logs/comments in **Bahasa Indonesia**
- `data/links.json` format: `[{id, url, nama}]` — required for CLI
- **Test quirk**: `test.js` defines 117 tests but `npm test` reports 113 — the 4 `testAsync` (withRetry) tests are never awaited and `process.exit()` is synchronous, so they never finish. Don't trust the file count; trust `npm test` output
- Retry: exponential backoff `delayMs * attempt` (`src/utils/retry.js:19`)
- `pdf-parse` (CJS) for text PDF detection & extraction
- `@napi-rs/canvas` (not `node-canvas`) for PDF-to-Canvas rendering
- **Orientation correction** (opt-in): add `rotate` to `OCR_PREPROCESS_STEPS` to enable 90° rotation correction via projection peak analysis. Not enabled by default. See `src/ocr/orientationDetector.js`
- **Deskew adaptif multi-engine** (`src/ocr/deskewRouter.js`): cascading engine — **Tesseract OSD dulu (orientasi 0/90/180/270°)** → **Hough-lite pure-JS** (±15°, step 0.5°, downsample ≤1MP, `detectSkewHoughLite`) → Hough sidecar OpenCV (±30°) → Projection profile (±5°, fallback). OSD duluan karena hough-lite pada halaman rotasi 90° bisa menemukan sudut kecil palsu dan return lebih awal (OSD terlewat). Opsi `deskewImage(canvas, {skipOsd:true})` untuk jalur fine-deskew saja (deteksi grid pass 1, crop sel repair); OSD punya timeout `OSD_TIMEOUT` + downscale ≤1MP. Dikontrol via `DESKEW_ENGINE=auto|hough|tesseract|projection`. Koreksi rotasi `rotateCanvas(-angle)` (konvensi OpenCV). Sidecar: `sidecar/deskew.py` port 5002 dengan endpoint `/detect-skew`, `/deskew`, `/correct-perspective`, `/deskew-full` — jika `DESKEW_SERVICE_URL` kosong → perspective no-op aman.
- **Rectify sebelum deteksi tabel** (`server.js` `renderPdfImagesWithTableBoost`): pass 1 render scale 1.0 → tiap halaman di-rectify dulu (`correctOrientation` + `deskewImage({skipOsd:true})`) → baru `detectTableRegions()`. Sebelumnya deteksi grid di gambar mentah — grid miring tidak menutupi baris/kolom penuh (densitas ≥ 60%) → 0 region → halaman tidak di-render `TABLE_RENDER_SCALE` (3.0). `repairTableBlocks` (router.js) kini pakai gambar ter-rectify (`_preprocessedCache[i][bestRetry]`).
- **Confidence-based retry** (`src/ocr/qualityMetrics.js` + `src/ocr/router.js`): tiap halaman di-scoring (confidence, garbageRatio, wordCount). Retry bervariasi: retry 0 = steps default, retry 1 = +`upscale` 1.5×, retry 2 = +`upscale` 3.0× + `denoise`; engine alternatif (`auto` → surya→tesseract→paddle) hanya di retry terakhir — **preprocessing/DPI didahulukan, engine diganti untuk kasus italic/tipis**. `OCR_MAX_CONFIDENCE_RETRIES=2`. Fungsi: `computePageScore`, `shouldRetry`, `selectRetryStrategy`, `_stepsForRetry`.
- **Garbage CJK** (`src/ocr/qualityMetrics.js`): `isGarbageWord()` mendeteksi kata sampah dari OCR teks miring — CJK murni pendek (楼), campuran Latin+CJK ≤ 4 char (Q楼), digit+CJK ≤ 6 char → dihitung garbage → memicu retry (sebelumnya lolos karena hanya digit pendek yang dihitung)
- **Garbage token Latin 1-char** (v25, `isGarbageWord`): token terisolasi 1 karakter selain a/i ("T W E M I R N" — pecahan OCR teks miring) = garbage → halaman miring yang tadinya lolos gate (score 0.61, accepted) kini ditolak → retry/fallback aktif. "I"/"A" dikecualikan ("BAB I", "Lampiran IA")
- **Auto-start sidecar** (v25, `server.js`): `npm start` spawn Python deskew (5002) + table-ocr (5003) otomatis — health check 120s, anti-dobel (port probe), kill saat exit/SIGINT/SIGTERM, gagal → log warning + fallback aktif (TIDAK menggagalkan server). Kontrol: `SIDECAR_AUTOSTART` (default true), `PYTHON_BIN`. Manual: `npm run sidecars` atau `start-sidecars.bat`. Peluncur deskew: `sidecar/run_deskew.py` (set PATH+TESSDATA, menyamai `run_server.py`)
- **Region OCR tabel** (`src/ocr/tableRegionOcr.js`): `detectTableRegions(canvas)` — deteksi grid berbasis piksel (run-length horizontal/vertikal, densitas ≥ 60%, merge region gap < 10px); `ocrTableRegions()` — crop + padding 12px → upscale 2× → deskew (`skipOsd`) → grayscale+threshold → OCR per region; `repairTableBlocks()` dipanggil di `_recognizePageCascade` setelah retry dengan **gambar ter-rectify** — blok garbage dalam region tabel diganti blok hasil OCR region (score dihitung ulang)
- **Table-aware hybrid** (`sidecar/table_ocr/` port 5003 + `src/services/tableAwareService.js` + `router.js`): gate `detectWiredGridRegions()` (run-length VERTIKAL per band antar 2 garis H, ≥3 inner verts, margin 5% tepi, tanpa fallback horiz-only) pilih engine per halaman — grid wired → PaddleX `table_recognition` (colspan akurat), lainnya → img2table (borderless). Blok hasil (`source:'table-aware'`, ASCII via `formatTableHtmlToText`) menggantikan blok OCR dalam bbox tabel di `performOcrBlocks` (batch 1 request per dokumen). Opsional (`TABLE_AWARE_ENABLED` default false); sidecar unreachable → skip aman.
- **Table render boost** (`server.js` `renderPdfImagesWithTableBoost`): pass 1 render scale 1.0 → deteksi grid tiap halaman → halaman bertabel di-render ulang `TABLE_RENDER_SCALE` (3.0), lainnya `PDF_RENDER_SCALE` (2.0). Ganti `convertPdfToImages({adaptive:true})` lama yang `tablePages`-nya selalu kosong.
- **Rotasi robust scan miring** (v23): lampiran tabel landscape yang discan miring 90° di halaman portrait (page tetap 612×1008) membuat OCR menghasilkan simbol jika rotasi tidak dikoreksi. `table_aware_ocr.py` + `sidecar/table_ocr/main.py` kini punya fallback deteksi rotasi saat Tesseract OSD gagal (`tesseract-osd` tidak terinstall): OCR `--psm 6` pada 4 rotasi (downscale ≤1000px) → pilih `common_word_ratio` tertinggi; return `(-best) % 360` karena `apply_rotation` memakai konvensi OSD (`rotate(-angle)`) — jangan kembalikan sudut probe CCW mentah (arah terbalik → tetap simbol). Sidecar juga **mentransform bbox balik** 90/180/270 ke koordinat gambar asli (`_map_bbox_back`) karena Node meng-crop bbox dari gambar yang tidak di-rotate.
- **Rotasi portrait konten miring (v24)**: `src/ocr/orientationDetector.js` `correctOrientation` kini menangani konten miring 90/270° DI DALAM page portrait (bukan hanya page landscape): (1) Tesseract OSD (`tryTesseractOsd`) + gate `OSD_MIN_CONFIDENCE` → (2) fallback kontur JS murni `detectTextOrientation` — Otsu + connected components (runs + union-find) + θ momen inersia komponen teks terbesar ≥ 80° (downscale ≤1600px; **butuh huruf ≥ ~18px** — render scale 1.0 gagal, scale 2.0/3.0 pipeline OCR OK) → (3) arah CW/CCW via `pickRotationDirection`: OCR 2 kandidat (rotate ±90, downscale 700px) pakai engine paddle **reuse cache router** (`ocrRouter.getActiveEngine()`, hindari 2× model; engine stale/reset → dibikin ulang) + `commonWordRatio` dari `src/pdf/textLayerValidator`. Keterbatasan: 180° terlewat kontur (hanya OSD), server.js pass 1 render scale 1.0 tidak ter-rectify (dampak terbatas — teks dihasilkan pipeline scale 2.0+).
- **Agregat kontur + OCR multi-arah (v25, `orientationDetector.js`)**: `detectTextOrientation` kini mengagregat **area semua komponen** vertikal (|θ|≥80) vs horizontal (|θ|≤10) — halaman tabel grid miring (garis grid asli-vertikal jadi horizontal ber-area besar) tetap terdeteksi (sebelumnya komponen terbesar = garis grid θ≈0 → "tegak" → simbol). `rotated` (ratio≥0.55) / `ambiguous` (0.45-0.55). Arah diputuskan `pickRotationByOcr`: OCR 0/±90 (+180 jika `include180`) downscale 700px, skor `_readabilityScore` = 10×commonWordRatio + huruf + digit − 1.5×CJK (tie-breaker tabel angka-murni), rotate hanya jika margin ≥ 0.05 vs posisi semula.
- **Fallback rotasi router (v25, `router.js`)**: halaman yang MASIH low-quality setelah semua retry → `_tryRotationVariants` OCR 180/±90 (preprocess tanpa steps rectify) → pilih skor terbaik (log "koreksi rotasi OCR fallback"). Menyelamatkan kasus hal 30 (grid super-dominan, kontur "tegak", lolos gate v24 karena token Latin 1-char tidak dihitung garbage) — sekarang skor 0.43 → ditolak → fallback -90° → 0.89. Verifikasi e2e 36 hlm: semua accepted, TOTAL CJK 3 char (sebelumnya 3 blok simbol).
- **Urutan preprocess fallback rotasi (v26, `router.js`)**: `_tryRotationVariants` kini **preprocess dulu (grayscale+threshold), baru rotate** — sebaliknya (rotate → threshold) membuat OCR garbage mirror ("NOLERA TA RORANS...", "国", "lpom era") karena threshold pada gambar rotated menghasilkan binary rusak (hal 30: skor 0.89 teks mirror lolos gate!). Setelah fix: hal 30 `-90°` 0.43→**0.97** bersih, hal 34 0.00→0.96. `_rescueGarbageBlocks` di-reorder: blok yang **sudah bersih (`needsRescue` false) tidak disentuh** — sebelumnya `tryBandRescue` selalu true untuk blok whole-page → filter whole-page membuang baris konten ("Kota kecil Kegiatan 2 2 2..." dst) sehingga skor 0.97→0.64 + LOW QUALITY. `_repairWholePageTopBand.firstReadable` memakai **total huruf** (`/[a-zA-Z]/g`, bukan match-count `[a-zA-Z]+/g` — tiap kata dihitung 1) + `len ≥ 15 && digits ≤ 4` → baris konten seperti "2) Pelaksanaan training of trainer" terdeteksi, "lpom era"/"nCurAA1/Dcsa" tidak. E2E 36 hlm: semua accepted, hal 30 paddle 1258 bersih (baris-baris yang img2table drop — "Hidup Pekerjaan Umum dan", "e. Pembentukan jejaring nasional..." — kini ADA), hal 34 table-aware 8579 (cjk=0, none=0), TOTAL CJK 8 (P24:1, P26:7), none=0; 156 tests passed.
- **Composite page score** (`src/ocr/qualityMetrics.js`): `computeQualityScore(blocks)` = `0.5*conf + 0.35*(1-garbageRatio) + 0.15*min(wordCount/20,1)`; `shouldAcceptPage()` gate per halaman (minWordCount 5, minConfidence 0.3, maxGarbageRatio 0.4, minQualityScore 0.3)
- **Engine cascade** (`src/ocr/router.js`): tiap retry coba semua engine kandidat (preferred dulu, `auto` → surya→tesseract→paddle), hasil terbaik (skor komposit) disimpan; `results.pageQuality[]` berisi `{page, accepted, lowQuality, score, ...}`; blok yang gagal diterima diberi `quality:'low'` (teks **tetap dipakai**, hanya ditandai); legacy path menambahkan catatan `[CATATAN: N halaman LOW QUALITY]` di akhir teks
- **Document review** (`src/reconstruction/review/documentReviewer.js`): stage pipeline progres 0.7 → `doc.review = {score, issueCount, issues}` (laporan saja, tidak auto-fix). Severity: error 0.25 / warning 0.10 / info 0.03, skor = `max(0, 1-bobot)`, issue dipangkas `REVIEW_MAX_ISSUES`. Tipe: `bab-order`, `bab-duplicate`, `pasal-order`, `pasal-duplicate`, `ayat-order`, `ayat-start`, `heading-parent`, `orphan-ayat`, `orphan-item`, `table-empty`, `table-position`, `title-missing`, `preamble-missing`, `page-order`, `low-quality`; di-expose di `result.reconstruction.review` (top 10)
- **Tree builder** (`src/reconstruction/builder/documentTreeBuilder.js`): hierarki heading stack-based (BAB=1, BAGIAN=2, PARAGRAF=3, PASAL=4 push/pop; `while (stack.length - 1 >= level) pop` — BAB II jadi sibling BAB I); pasal di-pop sebelum pasal baru; paragraf di-flush saat ganti halaman/kosong/marker `(n)`/`a.`; grup diberi `pos` (startIdx asli) + sort → **tabel interleave di posisi aslinya** (bukan di akhir); deteksi judul (`^(PERATURAN|KEPUTUSAN|UNDANG-UNDANG|INSTRUKSI|NOTA KESEPAHAMAN|MEMORANDUM)` + panjang ≥ 25 atau NOMOR/TAHUN/TENTANG → node `title` level 0, render bold di markdown/HTML)
- **Adaptive DPI rendering** (`src/ocr/adaptiveRenderer.js`): halaman tabel di-render di scale 1.5×–2.5× dari base `PDF_RENDER_SCALE`. Retry meningkatkan scale otomatis. Cache render per page+scale.
- **Image converter per-page** (`src/pdf/imageConverter.js`): `renderPage(pdfDoc, pageNum, scale)` untuk render halaman individual. `convertPdfToImages()` support `{adaptive: true, tablePages: Set}`.
- **Table detection multi-engine** (`src/ocr/tableDetector.js`): PP-StructureV3 (port 5000) → Surya (port 5001) → heuristic (digit line + column alignment analysis). `detectTableStructure(canvas)` return source/confidence/tables.
- **Cell-level OCR** (`src/ocr/cellOcr.js`): crop cell dari full-page canvas → OCR 2× scale → format ASCII table via `reconstructTableFromBlocks(blocks)` dan `formatAsciiTable(rows)`. `ocrTableCell(canvas, bbox, engine)`.
- `performStructuredOcr()` (`src/services/structureService.js`): selalu coba PP-StructureV3 → Surya → standard OCR secara berjenjang.
- Per-page error handling: `imageConverter.js` and `engine.js` **skip** failed pages (blank canvas / empty string), do NOT abort the whole document
- **ESLint**: `eslint:recommended`, 2-space indent, single quotes, comma-dangle always-multiline
- **Prettier**: singleQuote, trailingComma all, printWidth 120, tabWidth 2, endOfLine lf
- **CI**: GitHub Actions on push/PR to `main`, Node 18 & 20 matrix, `npm ci` → `npm run lint` → `npm test` (with `NODE_OPTIONS=--experimental-vm-modules`)
- **Docker**: `node:20-slim`, tini entrypoint, `npm ci --only=production`, EXPOSE 3000
- **docker-compose**: 5 services (app + sidecar + surya-sidecar + deskew-sidecar + MySQL 8), healthcheck DB, persistent volumes

---

> **Progres log**: riwayat lengkap v1–v17 di bawah (dan terus bertambah di `CHANGELOG.md` — entri baru ditambahkan ke atas file tersebut).

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