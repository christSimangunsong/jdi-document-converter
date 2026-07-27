# AGENTS.md — jdi-document-converter

## Arsitektur
- **CLI** (`app.js`) — batch processing dari `data/links.json`
- **Web** (`server.js`) — **Express v5** server
  - `POST /process-url` / `POST /process-urls` — single/batch dari URL (max 20)
  - `POST /process-upload` / `POST /process-uploads` — single/batch upload (max 20)
  - `GET /download/:file` — download `.txt`
- **Frontend** (`public/index.html`) — tab URL (textarea) + tab Upload (multi-file), hasil expandable + download per item
- Pipeline: `download` → `detectPdfType` → `extractText` (TEXT) / `convertPdfToImages`→`performOcr` (SCAN) → `cleanText` → `DocumentStructureRebuilder` → output `.txt`
- **Penting:** Web server memanggil `rebuildDocumentStructure()` (`server.js:43`), CLI (`app.js:67`) **TIDAK** — CLI berhenti setelah `cleanText()`

## CJS / ESM Hybrid
Project CJS (`require`), beberapa dependensi ESM-only diimpor dinamis:

| File | Dynamic import |
|---|---|
| `src/pdf/imageConverter.js:8,10` | `import('pdfjs-dist/legacy/build/pdf.mjs')`, `import('@napi-rs/canvas')` |
| `src/ocr/engine.js:11` | `import('ppu-paddle-ocr')` |

Jangan ubah ke `require()` — akan error.

## Buffer → Uint8Array / Canvas gotcha
`pdfjs-dist` v4 dan `ppu-paddle-ocr` menolak `Buffer`, minta `Uint8Array` atau `Canvas`.
- `imageConverter.js:18` — `new Uint8Array(buffer)` sebelum `pdfjs.getDocument()`
- `imageConverter.js:43` — push `Canvas` langsung, hindari `toBuffer()`
- `engine.js:29` — `recognize()` terima `Canvas` (punya `.toBuffer()`)
- Error indikatif: `"Please provide binary data as Uint8Array, rather than Buffer"` / `"getContext is not a function"`

## DocumentStructureRebuilder
`src/utils/DocumentStructureRebuilder.js` — class `DocumentStructureRebuilder` dengan method `rebuild(text)`, dipanggil setelah `cleanText()`.
- **Detect**: BAB (I/II/1/2), Bagian (Kesatu…), Paragraf, Pasal, Ayat header, (1) ayat, a./a) huruf, 1./1) nomor, bullet
- **Hierarki**: tree based on level, anak ditempel ke parent terdekat
- **Serialize**: BAB → 1 blank line before, PASAL → 1 blank line before + newline after, Ayat → indent 2sp, Huruf/Nomor → indent 4sp, body → blank line antar paragraf

## Commands
| Perintah | Fungsi |
|---|---|
| `npm start` | Web server `localhost:3000` |
| `npm run cli` | CLI batch dari `data/links.json` |
| `npm test` | `node --experimental-vm-modules test.js` (file `test.js` belum ada) |

## Konfigurasi (`.env`)
`OUTPUT_DIR` (./output), `LOG_DIR` (./logs), `MAX_RETRIES` (3), `RETRY_DELAY_MS` (2000), `DOWNLOAD_TIMEOUT` (60000), `OCR_LANG` (id), `PDF_RENDER_SCALE` (2.0), `PORT` (3000)

`linksPath` dikode keras ke `./data/links.json` di `src/config/index.js:14` — tidak dari `.env`.

## Catatan
- Semua log/komentar dalam Bahasa Indonesia
- `data/links.json` = array `{id, url, nama}` — wajib untuk mode CLI
- Retry pakai exponential backoff: `delayMs * attempt` (`src/utils/retry.js:19`)
- `pdf-parse` (CJS) untuk deteksi jenis PDF (`detector.js`) dan ekstrak teks (`textExtractor.js`)
- `@napi-rs/canvas` (bukan `node-canvas`) untuk render PDF ke Canvas
- Tidak ada linter, formatter, typecheck, atau CI
