# AGENTS.md — jdi-document-converter

## Arsitektur
- **CLI** (`app.js`) — entrypoint batch processing dari `data/links.json`
- **Web** (`server.js`) — Express server dengan rute:
  - `POST /process-url` — proses single PDF dari URL
  - `POST /process-urls` — batch proses hingga 20 URL
  - `POST /process-upload` — proses single PDF upload
  - `POST /process-uploads` — batch proses hingga 20 file
  - `GET /download/:file` — download hasil `.txt`
- **Frontend** (`public/index.html`) — halaman dengan input multi-URL (textarea) + multi-file upload, hasil ditampilkan sebagai daftar expandable + download per item
- Pipeline: download/detect → extractText/convertPdfToImages → OCR → textCleaner → **DocumentStructureRebuilder** → output .txt
- Semua logika di `src/`: `pdf/` (detector, imageConverter, textExtractor), `ocr/engine.js`, `utils/` (retry, textCleaner, DocumentStructureRebuilder), `services/` (logger, pdfDownloader, reportGenerator)

## DocumentStructureRebuilder
- File: `src/utils/DocumentStructureRebuilder.js`
- Class `DocumentStructureRebuilder` dengan method `rebuild(text)` — dipanggil setelah `cleanText()`
- **detect**: BAB (I/II/1/2), Bagian (Kesatu…), Paragraf 1, Pasal 1, Ayat header, (1) ayat, a./a) huruf, 1./1) nomor, bullet
- **hierarchy**: tree berdasarkan level, anak ditempel ke parent terdekat
- **serialize**: BAB → 1 blank line before, PASAL → 1 blank line before + newline after, Ayat → indent 2sp, Huruf/Nomor → indent 4sp, body → blank line antar paragraf
- Output siap untuk vector DB chunking tanpa mengubah isi kalimat

## Commands
| Perintah | Fungsi |
|---|---|
| `npm start` | Jalankan web server (Express) di `localhost:3000` |
| `npm run cli` | Jalankan CLI batch dari `data/links.json` |
| `npm test` | Belum ada test (`test.js` belum dibuat) |

## Konfigurasi (`.env`)
`OUTPUT_DIR`, `LOG_DIR`, `MAX_RETRIES`, `RETRY_DELAY_MS`, `DOWNLOAD_TIMEOUT`, `OCR_LANG` (default `id`), `PDF_RENDER_SCALE` (default `2.0`), `PORT` (default `3000`)

## Catatan penting
- Semua log/komentar dalam Bahasa Indonesia
- `src/ocr/engine.js` menggunakan `import()` dinamis untuk `ppu-paddle-ocr` (ESM-only) dari proyek CJS — jangan diubah ke `require()`
- `data/links.json` berisi array `{id, url, nama}` — wajib ada untuk mode CLI
- Tidak ada linter, formatter, typecheck, CI, atau git repo

## Gotcha: Buffer → Uint8Array / ArrayBuffer / Canvas
Library modern (`pdfjs-dist` v4, `ppu-paddle-ocr`) menolak `Buffer` (Node.js) dan meminta `Uint8Array` atau `ArrayBuffer` murni.

| File | Solusi |
|---|---|
| `src/pdf/imageConverter.js:43` | Kirim `Canvas` langsung (`images.push(canvas)`) — hindari `toBuffer()` |
| `src/pdf/imageConverter.js:18` | `new Uint8Array(buffer)` sebelum `pdfjs.getDocument()` di `imageConverter.js` |
| `src/ocr/engine.js:29` | `recognize()` terima `Canvas` langsung (punya `.toBuffer()`) — terdeteksi otomatis |

**Pola:** Jika ada error `"Please provide binary data as Uint8Array, rather than Buffer"` atau `"getContext is not a function"`, kemungkinan data masih berupa `Buffer` dan perlu dikonversi atau dilewatkan sebagai `Canvas` langsung.
