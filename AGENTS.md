# AGENTS.md — jdi-document-converter

> Compact instructions for OpenCode sessions. Full progress log (changelog): **`CHANGELOG.md`** — add new entries there (top of file). Full version history (v1–v17 → latest, nothing deleted) lives there; do NOT re-embed changelogs in this file.
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
| `npm test` | `node --experimental-vm-modules test.js` (214 unit tests) |
| `npm run sidecars` | Manual sidecar launcher: deskew (5002) + table-ocr (5003) via `scripts/sidecars.js` |
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
| OCR | `OCR_ENGINE`, `OCR_LANG` (id), `OCR_PREPROCESS`, `OCR_PREPROCESS_STEPS` (default `grayscale,denoise,threshold`; .env saat ini `rotate,deskew-adaptive,perspective,grayscale,threshold` — **urutan penting: rectify dulu, binarize terakhir**), `OCR_MIN_CONFIDENCE` (0.3), `OCR_MAX_CONFIDENCE_RETRIES` (2), `OCR_ENGINE_FALLBACK` (true), `OCR_QUALITY_GATE` (true), `OCR_MIN_WORD_COUNT` (5), `OCR_MAX_GARBAGE_RATIO` (0.4) |
| PDF | `PDF_RENDER_SCALE` (2.0) |
| Deskew | `DESKEW_ENGINE` (auto), `DESKEW_SERVICE_URL`, `DESKEW_MIN_CONFIDENCE` (0.3), `DESKEW_PERSPECTIVE` (true), `DESKEW_MAX_ANGLE` (15) |
| Projection | `PROJECTION_MIN_RATIO` (1.8), `PROJECTION_AMBIGUOUS_THRESHOLD` (0.65) |
| OSD | `OSD_ENABLED` (true), `OSD_MIN_CONFIDENCE` (8), `OSD_TIMEOUT` (5000) — **.env saat ini `OSD_ENABLED=false`** (v29: binary Tesseract lokal timeout → buang ~9 mnt/batch; orientasi tetap jalan via fallback kontur + OCR 4-arah). Jangan "perbaiki" jadi true tanpa cek binary |
| Perspective | `PERSPECTIVE_ENABLED` (true), `PERSPECTIVE_MIN_AREA` (0.2) |
| Table | `TABLE_DETECT` (true), `TABLE_PRESERVE_GRID` (true), `TABLE_SPLIT_CELLS` (true), `TABLE_RENDER_SCALE` (3.0) |
| Table-Aware | `TABLE_AWARE_ENABLED` (false), `TABLE_AWARE_SERVICE_URL`, `TABLE_AWARE_TIMEOUT` (1800000), `TABLE_AWARE_MAX_PADDLEX_PAGES` (2; 0 = nonaktifkan PaddleX — iterasi cepat) |
| DB | `DB_HOST/USER/PASSWORD/NAME/PORT` |
| Sidecar | `STRUCTURE_SERVICE_URL`, `SIDECAR_TIMEOUT` (120s), `SURYA_SERVICE_URL`, `DESKEW_SERVICE_URL`, **`SIDECAR_AUTOSTART`** (true), **`PYTHON_BIN`** (python) |
| Pipeline | `RECONSTRUCTION_ENABLED` (false), `RECONSTRUCTION_DEBUG` (false), `RECONSTRUCTION_DEBUG_DIR` (`./debug`), `RECONSTRUCTION_CHUNK_SIZE` (1000), `RECONSTRUCTION_CHUNK_OVERLAP` (200), `RECONSTRUCTION_OUTPUT_FORMAT` (markdown) |
| Review | `REVIEW_ENABLED` (true), `REVIEW_MAX_ISSUES` (50) |
| Output cleanup | `OUTPUT_CLEANUP_MAX_AGE_DAYS` (30), `OUTPUT_CLEANUP_INTERVAL_MS` (21600000) |

- File name from URL: `extractFileNameFromUrl()` — last segment, strip `.pdf`, sanitize, max 200 chars. Spaces encoded `%20` then `decodeURIComponent()`
- File name from upload: `path.parse(file.originalname).name`
- Multer saves to `uploads/`, cleaned after processing

## Notes

- **Normalisasi typo OCR + footer chrome + fallback tabel (v30.1)**: (1) **`src/utils/ocrTypos.js`** (baru) — `fixOcrTypos(text)` dua lapis: aturan generik (kolon antar huruf "se:besar"→"sebesar" — "12:30"/"a.n." aman; strip prefiks `¿` U+00BF yang lolos filter textCleaner; prefiks `l`+konsonan hanya bila sisa ≥4 huruf ada di `ID_WORD_DICT` — "lkegiatan"→"kegiatan", "lampiran"/"lucu" aman; sufiks "nyva"→"nya" case-aware) + token map 12 entri case-preserving ("BAE"→"BAB", "Fasal"→"Pasal", "avat"→"ayat", "Nonor/Nornor"→"Nomor", "cengan"→"dengan", "Euvati"→"Bupati", "MEMUTUISKAN"→"MEMUTUSKAN", "YANCMAHA"→"YANG MAHA"); dipakai `garbageTokens.cleanLineText` (pipeline + sel tabel + legacy) dan `textCleaner.cleanText` SEBELUM `filterPageChrome` (agar "BAE III" terdeteksi `fixLegalHeadings`); (2) **footer chrome** (`outputCleaner.filterPageChrome` + legacy): zona footer 4 baris terbawah tiap halaman — `NIP_LINE_RE` (NIP+≥8 digit), `TTD_LINE_RE` ("ttd." murni), `SALINAN_SESUAI_RE`, `KEPALA_BAGIAN_HUKUM_RE` (full-line; "a.n. Kepala Bagian Hukum" konten aman); running header/footer kini 2 baris teratas/terbawah per halaman (footer berlapis); **dedup global heading preambul murni** ("Menimbang :"/"Mengingat :"/"MEMUTUSKAN :"/"Menetapkan :" — unik per dokumen, duplikat ghost layer dibuang; legacy per-baris tanpa info halaman); (3) **`tableFormatter.formatTableHtmlToText`**: gate `_tableGridUsable` (maxCols > 20; sel artefak grid ≥10%; variasi jumlah sel ≥3 nilai; baris 1-sel di samping ≥4-sel → grid korup) → fallback `formatTablePlainText` (sel `" | "` per baris, info tidak hilang); bersih → grid tetap; (4) **`TABLE_AWARE_MAX_PADDLEX_PAGES`** env (default 2, `0` = PaddleX nonaktif; config `parseInt`+NaN-check bukan `||` agar 0 dihormati; router pakai config, docker-compose pass-through). **Ghost layer** (dua dokumen saling selang kata dalam satu baris, hal 2-3 Perub No 8) tetap di luar scope — tidak bisa dipisah generik. 214 unit tests.
- **Normalisasi kata terpecah + struktur hukum (v30)**: (1) **`src/utils/wordFixer.js`** (baru) — kamus ~300 kata hukum + stopword; `mergeSplitWords(text, docTokens?)` gabung "Dala m"→"Dalam", "kerjasa ma"→"kerjasama"; konservatif (kedua fragmen huruf murni, gabungan ≥5 huruf, ada di kamus ATAU muncul sebagai token di dokumen yang sama; frasa sah "kerja sama"/"peraturan daerah" tidak digabung kecuali bentuk gabungan ada di dokumen); dipakai `garbageTokens.cleanLineText` (pipeline + legacy) dan `textCleaner.cleanText`; `countSplitWords` dipakai **gate retry router**: halaman diterima tapi ≥2 kata terpecah → 1× OCR ulang upscale 1.5×; (2) **`filterPageChrome(lines)`** (`outputCleaner.js`, dipakai pipeline setelah `cleanLines` + legacy `textCleaner`): nomor halaman murni ("2", "- 3 -", "·12·"), cap "SALINAN"/"SALINAN E3", fragmen cap "E3" hanya di baris pertama/terakhir tiap halaman; running header/footer ≥50% halaman dibuang; di legacy dijalankan SEBELUM `joinBrokenSentences` (kalau tidak chrome tergabung ke kalimat); (3) **`lineMerger._splitMultilineBlocks`** — blok whole-page ber-`\n` dipecah per baris (bbox offset Y, baris kosong dipertahankan → flush paragraf); sebelumnya `_toLine` meratakan `\n` → BAB/Pasal/Menimbang/footer menyatu → struktur hancur; (4) **`documentTreeBuilder._expandPreambleLines`** pecah "Menimbang : a. ...; b. ...", "MEMUTUSKAN : Menetapkan :" (hanya setelah ":"/";" — kalimat biasa aman); PASAL judul/isi menempel dipisah ("Pasal 1 Setiap orang..." → title+body); (5) **`markdownGenerator`** kini render body Pasal + isi preambul setelah ":" (`_legalRest`) — sebelumnya heading saja → isi HILANG; (6) **fix bug pre-existing `documentModel.js` Line constructor** (`blocks[0]` di param undefined → TypeError; dipakai `this.blocks`) — semua test async `new Line({text, order})` sebelumnya crash → rejected promise → **✓ palsu** (tidak pernah jalan); setelah fix test nyata 187 → **201 passed**.
- **DB sumber utama, `output/` hanya cache (v29.5)**: file `.txt` ditulis otomatis saat BERHASIL (cache sesi; branch reconstruction dulu TIDAK menulis — fixed), lalu **dihapus setelah "Simpan ke Database"** (POST `/api/activities/save`); `GET /download/:file` fallback ke `output_text` via `activityLogger.getByFileName()` bila file tak ada; `cleanupOutputDir()` (startup + `setInterval` 6 jam) hapus `*.txt`/`*.md` yang sudah tersimpan di DB atau stale > `OUTPUT_CLEANUP_MAX_AGE_DAYS` (30), file <10 mnt dilewati (anti-race). **Progress SSE detail**: event `progress` = `{pct, fileIndex, totalFiles, fileName, phase, page, totalPages}`; UI menampilkan fase + file i/n + halaman dan "Selesai — N file" 4 dtk di akhir. **Monitoring**: logger winston dual-write — baca `logs/app.log` (jangan redirect stdout).
- **Anti-stuck + table-aware benar-benar jalan (v29.4)**: (1) **bug early-return** di `_recognizePageCascade` (`src/ocr/router.js`): halaman yang DITERIMA gate (`shouldAcceptPage`) di-return **tanpa `image`** → gate `config.tableAware.enabled && outcome.image` di `performOcrBlocks` selalu `false` → **table-aware tidak pernah berjalan untuk dokumen berkualitas baik** (hanya halaman low-quality yang lolos full cascade); fix: sertakan `image: img` di early-return — verifikasi UI Perbub No 21 (digital, 15 hlm): 77 dtk, review 0.94, 8 halaman per-page dikirim ke table-ocr, tanpa hang; (2) **`MAX_PAGE_TIMEOUT=720000`** (12 mnt) di `tableAwareService.js` — PaddleX wired ~9 mnt/halaman CPU, 5 mnt selalu timeout → halaman wired dilewati senyap; per-page POST + `Math.min(timeout, MAX_PAGE_TIMEOUT)`; (3) `docker-compose.yml` pakai `${TABLE_AWARE_TIMEOUT:-720000}` (bukan hardcode 1 jam); `.env` `TABLE_AWARE_TIMEOUT=720000`.
- **Perbaikan generik output rapi (v29.1)**: aturan token terpusat di **`src/utils/garbageTokens.js`** (dipakai `router.js` + `outputCleaner.js` + `documentTreeBuilder.js` — satu sumber kebenaran). Tiga cacat diatasi: (1) `_rescueGarbageBlocks` kini melakukan **pembersihan token TANPA SYARAT untuk SEMUA blok** sebelum cek `needsRescue` — fragmen mirror yang lolos gate ("T E SALINAN L R 3 1 E 5. E") sebelumnya bocor ke output; (2) **aturan run mirror**: ≥2 token bare berurutan (core 1 huruf/angka + punct tepi) yang memuat ≥1 huruf tunggal dihapus — aman untuk "BAB I", "huruf a", "Rp 5.000", "1. Undang-Undang", "kota kecil Kota 1 1", "1: 3:"; (3) **`_filterWholePageGarbageLines` bersihkan token DULU, baru drop baris** — "Pasal 1 国" jadi "Pasal 1" (tidak hilang). Normalisasi tambahan: `normalizeGluedWordNumber` ("TAHUN2020" → "TAHUN 2020", "NOMOR20" → "NOMOR 20"), `normalizeGluedBABRoman` ("BABI" → "BAB I"; "BABINSA" aman), dan `fixInternalDots` ("SAL.INAN" → "SALINAN"; "Drs."/"a.n."/"NIP." aman). **Huruf tunggal setelah penanda daftar dihapus** ("b. I Kelurahan" → "b. Kelurahan" — sisa OCR kolom tabel; "a. 1"/"a. b. c. d." aman). **Baris konsonan-dense dihapus**: ≥5 token dengan ≥70% rasio konsonan tanpa vokal = garbage murni ("| s88rsT smuA rdsqms& ... |" — tabel ter-OCR arah salah; prosa normal & singkatan pendek "APBD DAK DAU" aman). **Sel tabel** juga di-`cleanLineText` saat build tree (`_parseTable` + jalur `detectTableFromLines`) — teks tabel tidak lewat pipeline `cleanLines` (hanya `ctx.lines`) sehingga garbage dalam sel sebelumnya bocor ke markdown. **Fix konkurensi (v29.3)**: `_preprocessedCache` GLOBAL di router.js diganti **cache PER-JOB** (`jobCache` param di `_getPageImage`/`_recognizePageCascade`) — dua konversi paralel sebelumnya saling menimpa cache halaman → "Cannot set properties of undefined" → status RUSAK. Tool verifikasi cepat: **`scripts/verify_output.js`** (analisis file markdown tersimpan: CJK/simbol/mirror-run/TAHUN-menempel — tanpa OCR ulang; `--upload <pdf> <out>`). 187 unit tests. Verifikasi e2e dokumen asli (36 hlm + 18 hlm): chars 147.070 / 38.855, **cjk=0, symbols=0, mirrorRuns=0, glue=0** keduanya.
- **Pemulihan kelengkapan output (v28)**: (1) **`_dedupeConsecutive` DIHAPUS total** (`documentTreeBuilder.js`) — terbukti menghilangkan konten: tiap "line" pipeline = teks SATU HALAMAN PENUH (blok whole-page), header hukum berulang tiap halaman ("BUPATI DAIRI PROVINSI SUMATERA UTARA...") + frasa pasal → overlap token ≥60% antar halaman berurutan → 31/37 baris dibuang → markdown 58.738 → **11.946 char** (13 → 6 children) untuk dokumen 36 hlm; (2) **`repairTableBlocks` pakai cache rectified** (`router.js`) — gambar dasar `_preprocessedCache[i][bestRetry]` (deskew+perspective+threshold) + `rotateCanvas(cached, bestAngle)` bila halaman dikoreksi rotasi fallback (v27: bestImg = canvas mentah/variant tanpa deskew → 0 region → repair skip senyap → tabel hal 30/32 kosong); saat repair berhasil `bestImg = repairImg` → table-aware/rescue dapat gambar bagus; `logger.warn` bila 0 region pada halaman masih jelek. 167 unit tests.
- **Perbaikan kualitas output (v27)**: (1) **`ocrGridCells()`** (`src/ocr/tableRegionOcr.js`) — OCR per-sel berbasis garis grid (rect per sel → `ocrTableCell` 2× → `formatAsciiTable`), menang bila skor `computeQualityScore` > region OCR/whole-page (tanpa regresi), blok whole-page yang kontennya tercakup tabel dibuang; (2) **`repairTableBlocks` dipindah SETELAH fallback rotasi** (`router.js`) — sebelumnya dijalankan sebelum rotasi sehingga grid halaman miring 90° tidak pernah terdeteksi; (3) **loop eskalasi skala anti-mirror** `_reOcrWithScaleEscalation` + `_hasMirrorGarbage` (CJK/Yunani/∪/superscript/box-drawing atau `commonWordRatio === 0`) — upscale 1.5×→2×→2.5×→3× + OCR ulang sampai bersih, hasil terbaik selalu disimpan; (4) **garbage non-Latin** di `isGarbageWord` — simbol ≥40% tanpa Latin ("ν1"), simbol terisolasi ("∪"), superscript berulang ("u¹5nu1¹5aux"), digit-dominan ≤2 huruf ("bo20202", kecuali Rp/angka murni); (5) ~~dedup baris lintas halaman~~ **DIHAPUS v28** (lihat catatan v28). 170 unit tests.
- All logs/comments in **Bahasa Indonesia**
- `data/links.json` format: `[{id, url, nama}]` — required for CLI
- **Test quirk**: `test.js`'s `test()` does NOT await async callbacks — a throw inside an async test becomes a rejected promise that's counted as ✓ (false positive). Since v30 fixed the `Line` constructor bug, all async treeBuilder tests actually run now. Also the 4 `testAsync` (withRetry) tests are never awaited and `process.exit()` is synchronous, so they never finish. Don't trust the file count; trust `npm test` output
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
- **docker-compose**: 6 services (app + sidecar + surya-sidecar + deskew-sidecar + table-ocr + MySQL 8), healthcheck DB, persistent volumes

---

> **Progres log**: riwayat lengkap v1–v17 hingga terbaru (semua versi, tidak ada yang dihapus) ada di **CHANGELOG.md** — entri baru ditambahkan di atas file tersebut.
