# Quick Reference — jdi-document-converter

Instruksi ringkas untuk sesi OpenCode. Changelog project ada di `AGENTS.md`.

## Arsitektur

| Entry | File | Rekonstruksi | DB |
|-------|------|---|---|
| CLI | `app.js` | Legacy (`cleanText()` only) | No |
| Web | `server.js` | Legacy (`RECONSTRUCTION_ENABLED=false`) **atau** Pipeline (`RECONSTRUCTION_ENABLED=true`) | `POST /api/activities/save` |

**Pipeline baru** (saat `RECONSTRUCTION_ENABLED=true`): `downloadPdf` → `detectPdfType` → [TEXT: `textExtractor` | SCAN: `convertPdfToImages→performOcrBlocks`] → `runReconstruction` → output Markdown/HTML/JSON/Chunks.

**Legacy** (saat `RECONSTRUCTION_ENABLED=false`, default): `downloadPdf` → `detectPdfType` → `extractText` (TEXT) / `convertPdfToImages→performOcr|performStructuredOcr` (SCAN) → `cleanText` → `rebuildDocumentStructure` → output `.txt`.

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm start` | Web server `localhost:3000` |
| `npm run cli` | CLI dari `data/links.json` |
| `npm test` | `node --experimental-vm-modules test.js` (88 tests) |
| `npm run lint` | `eslint .` (2-space, single quotes) |
| `npm run format` | `prettier --write "**/*.{js,json,css,html}"` |

## CJS / ESM Hybrid

Project CJS (`require`), **3 dynamic ESM imports** — jangan diubah ke `require()`.

| File | Dynamic import |
|---|---|
| `src/pdf/imageConverter.js:8` | `import('pdfjs-dist/legacy/build/pdf.mjs')` |
| `src/pdf/imageConverter.js:9` | `import('@napi-rs/canvas')` |
| `src/ocr/engine.js:11` | `import('ppu-paddle-ocr')` |

## Gotcha — Buffer/Uint8Array/Canvas

`pdfjs-dist` v4 dan `ppu-paddle-ocr` minta `Uint8Array`/`Canvas`, tolak `Buffer`.

- `imageConverter.js:20` — `new Uint8Array(buffer)` sebelum `pdfjs.getDocument()`
- `imageConverter.js:46` — push `Canvas` langsung, hindari `toBuffer()`
- `engine.js:29` — `recognize()` terima `Canvas` (punya `.toBuffer()`)
- `imageConverter.js:12-16` — worker path dari `require.resolve('pdfjs-dist/package.json')` + `url.pathToFileURL()`

## Status & Duplikasi

`processBuffer()` return status: `BERHASIL`, `GAGAL`, `RUSAK`, `KOSONG`.

- 0 byte → KOSONG; pipeline throw → RUSAK; `cleanText()` kosong → KOSONG; download gagal → GAGAL
- SHA256 hash dicek di `POST /api/activities/save`: jika hash sudah ada DAN `output_text IS NOT NULL` → DUPLICATE
- `getActivities()` / `getStats()` hanya return record dengan `output_text IS NOT NULL`

## Reconstruction Pipeline

`src/reconstruction/` — pipeline modular untuk dokumen hukum Indonesia.

**Stages**: `documentAnalyzer` → [TEXT: `textExtractor` | SCAN: `readingOrderResolver`] → `lineMerger` → `documentTreeBuilder` → `legalParser` → output (Markdown, HTML, Semantic JSON, Chunks, Embedding).

**Pipeline file**: `pipeline.js:14` (16 files total).

| Stage | File | Fungsi |
|---|---|---|
| Analyzer | `analyzer/documentAnalyzer.js` | Deteksi tipe PDF (digital/scan), kelompokkan per halaman |
| Extractor | `analyzer/textExtractor.js` | Ekstrak teks dari PDF digital via pdf-parse |
| Reading Order | `builder/readingOrderResolver.js` | Urutkan blok OCR berdasarkan posisi Y→X |
| Line Merger | `builder/lineMerger.js` | Gabung blok sebaris jadi Line |
| Tree Builder | `builder/documentTreeBuilder.js` | Deteksi BAB/Pasal/Ayat/Huruf/Angka, bangun pohon |
| Legal Parser | `builder/legalParser.js` | Tag komponen hukum (Menimbang/Mengingat/Memutuskan) |
| Markdown | `output/markdownGenerator.js` | Output Markdown dengan heading, bold, indent |
| HTML | `output/htmlGenerator.js` | Output HTML dengan CSS inline |
| JSON | `output/semanticJsonGenerator.js` | Output JSON semantik (type/number/title/text) |
| Chunks | `output/chunkBuilder.js` | Bagi teks jadi chunk (size + overlap) untuk RAG |
| Embedding | `output/embeddingFormatter.js` | Format chunk untuk embedding input |
| Debug | `debug/visualDebugger.js` | Debug tree dalam HTML/JSON interaktif |
| Index | `index.js` | Entry point `runReconstruction()` |

**Pipeline baru** ditambahkan di `server.js:48-85` — jika `config.reconstruction.enabled` true, panggil `performOcrBlocks()` (return blocks dengan bbox+confidence) → `runReconstruction(pdfBuffer, ocrBlocks)`.

## Konfigurasi

- `.env`: `OUTPUT_DIR`, `LOG_DIR`, `MAX_RETRIES`, `RETRY_DELAY_MS`, `DOWNLOAD_TIMEOUT`, `OCR_LANG`, `PDF_RENDER_SCALE`, `PORT`, `DB_HOST/USER/PASSWORD/NAME/PORT`, `STRUCTURE_SERVICE_URL`, `SIDECAR_TIMEOUT`, `RECONSTRUCTION_ENABLED`, `RECONSTRUCTION_DEBUG`, `RECONSTRUCTION_CHUNK_SIZE`, `RECONSTRUCTION_CHUNK_OVERLAP`
- `RECONSTRUCTION_ENABLED=false` secara default — backward compat
- `linksPath` hardcoded ke `./data/links.json` (`src/config/index.js:14`) — bukan dari `.env`
- Nama file URL: `extractFileNameFromUrl()` — last segment, strip `.pdf`, sanitasi, max 200 chars. URL dengan spasi di-encode `%20` lalu `decodeURIComponent()`
- Nama file upload: `path.parse(file.originalname).name`
- Multer simpan di `uploads/`, dibersihkan setelah diproses

## Routes (Web)

| Method | Path | Keterangan |
|--------|------|------------|
| POST | `/process-url` | Body `{url, nama?}` |
| POST | `/process-urls` | Body `{urls:[]}` (max 20) **SSE streaming FIFO** |
| POST | `/process-upload` | Multipart field `pdf` |
| POST | `/process-uploads` | Multipart field `pdf` (max 20) **SSE streaming FIFO** |
| GET | `/download/:file` | Download `.txt` dari `config.outputDir` |
| GET | `/api/activities` | List activities (200 terbaru) |
| GET | `/api/activities/stats` | Statistik + daily 7 hari |
| GET | `/api/activities/:id` | Detail activity by ID |
| POST | `/api/activities/save` | Simpan text + metadata ke DB (body JSON) |
| DELETE | `/api/activities/:id` | Hapus activity + file `.txt` |
| GET | `/api/report/download` | Query `?from=&to=&format=xlsx\|csv` |

## Modular OCR Engine

`src/ocr/` — arsitektur pluggable dengan interface seragam.

```
Engine Interface (OcrEngine)
├── PaddleEngine     ← ppu-paddle-ocr (default, local)
├── TesseractEngine  ← tesseract.js (local)
└── SuryaEngine      ← surya-ocr via Python sidecar (port 5001)
```

**Konfigurasi** via `.env`:
- `OCR_ENGINE=paddle|tesseract|surya|auto` — pilih engine (default: paddle)
- `OCR_PREPROCESS=true|false` — enable image preprocessing sebelum OCR
- `OCR_PREPROCESS_STEPS=grayscale,denoise,threshold,deskew`

Semua engine mengimplementasi `init()`, `recognize(image)`, `recognizePage(image)`, `destroy()`.

## Sidecar (PP-StructureV3)

Python FastAPI (`sidecar/main.py`), port 5000.

- **Jika `STRUCTURE_SERVICE_URL` tidak diset** → pakai modular OCR engine berdasarkan `OCR_ENGINE`
- **Jika diset** → `performStructuredOcr()` → POST `/analyze` (base64 images) → layout-aware OCR + table HTML
- **Jika sidecar unreachable/timeout** → log warning → fallback ke modular OCR
- **Per halaman error** → page return text kosong, halaman lain lanjut

## Benchmark Mode

`npm run benchmark` — bandingkan semua engine pada test set.

```
npm run benchmark -- --dir ./benchmark/test-set --engines paddle,tesseract,surya
```

**Test set format**: setiap dokumen butuh pasangan `.pdf` + `.gt.txt` (ground truth).

**Metrik**: CER, WER, confidence, speed (pg/s), layout quality, table quality, structure quality.

Output: `benchmark/results/benchmark-report.html` + `benchmark-report.json`.

## Image Preprocessor

`src/ocr/preprocessor.js` — pipeline preprocessing sebelum OCR:
- `grayscale` — konversi RGB ke grayscale (luminosity)
- `denoise` — median filter 3×3
- `threshold` — adaptive local thresholding
- `deskew` — deteksi dan koreksi kemiringan halaman

Diaktifkan via `OCR_PREPROCESS=true` atau `config.ocr.preprocess`.

## Garbage Filter

`textCleaner.js`: `isTableGarbage(line)` + `filterTableGarbage(text)`.
Deteksi baris sampah OCR (digit-dominated, short words) dan hapus dari akhir teks. Dipanggil di `cleanText()` sebelum heading detection.

## Catatan

- Semua log/komentar dalam Bahasa Indonesia
- `data/links.json` = array `{id, url, nama}` — wajib untuk CLI
- Retry: `delayMs * attempt` (`src/utils/retry.js:19`) — exponential backoff
- `pdf-parse` (CJS) untuk deteksi & ekstrak teks PDF
- `@napi-rs/canvas` (bukan `node-canvas`) — native Canvas untuk rendering PDF
- ESLint: `eslint:recommended`, 2-space indent, single quotes, comma-dangle always-multiline
- Prettier: singleQuote, trailingComma all, printWidth 120, tabWidth 2
- CI: GitHub Actions, push/PR ke `main`, Node 18 & 20, `lint → test`
- Docker: `node:20-slim`, tini, EXPOSE 3000
- `docker-compose`: 3 service (app + sidecar + MySQL 8), healthcheck db, volume persistensi
- Per-page error handling: imageConverter.js & engine.js **skip** halaman gagal (blank canvas / string kosong) — tidak abort seluruh dokumen
