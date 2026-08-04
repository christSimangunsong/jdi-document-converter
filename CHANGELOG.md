# CHANGELOG - jdi-document-converter

> Log progres proyek ini. Setiap update menambahkan entri baru di bagian paling atas (## Changelog - TANGGAL (vN)).
> Riwayat v1-v17 di bawah ini adalah salinan utuh dari AGENTS.md - tidak ada yang dihapus.

---

## Changelog — 2026-08-04 (v29.4)

### ringkasan
**Root cause "table-aware tidak pernah jalan" ditemukan & diperbaiki + timeout PaddleX dilonggarkan.** (1) Bug pre-existing di `_recognizePageCascade` (`src/ocr/router.js`): halaman yang DITERIMA gate kualitas (`shouldAcceptPage`) di-early-return **tanpa properti `image`** → gate `config.tableAware.enabled && outcome.image` di `performOcrBlocks` selalu `false` untuk halaman bagus — **table-aware hanya pernah berjalan untuk halaman kualitas rendah** yang lolos full cascade; dokumen scan/digital bersih sama sekali tidak dikirim ke sidecar (log "Kirim halaman ke table-ocr" tidak pernah muncul). (2) `MAX_PAGE_TIMEOUT` dinaikkan 300000 → **720000 (12 mnt)** — PaddleX table_recognition butuh ~9 mnt/halaman wired di CPU, timeout 5 mnt selalu melewati halaman wired → tabel hilang. (3) `docker-compose.yml` masih hardcode `TABLE_AWARE_TIMEOUT=3600000` (1 jam — nilai lama penyebab UI macet saat sidecar hang).

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/ocr/router.js` | early-return accepted: `return { score, blocks, text, engine, accepted: true }` TANPA `image` → `outcome.image` undefined → table-aware skip diam-diam | `return { ..., image: img }` — halaman berkualitas baik kini ikut dikirim ke table-aware |
| `src/services/tableAwareService.js` | `MAX_PAGE_TIMEOUT=300000` (5 mnt) | **720000 (12 mnt)** — batas per-halaman via `Math.min(config.tableAware.timeout, MAX_PAGE_TIMEOUT)`; PaddleX wired ~9 mnt/halaman di CPU |
| `.env` | `TABLE_AWARE_TIMEOUT=300000` | `720000` |
| `docker-compose.yml` | `TABLE_AWARE_TIMEOUT=3600000` hardcoded | `TABLE_AWARE_TIMEOUT=${TABLE_AWARE_TIMEOUT:-720000}` |

### detail

**Verifikasi runtime (uji user via UI, server PID 13904, semua fix dimuat)**: Perbub No 21/2020 Pendidikan Anti Korupsi (PDF digital, 15 hlm) — **~77 dtk total**, skor review **0.94**, markdown 19.455 char, **8 halaman dikirim per-halaman ke table-ocr (14:02:28–44, ~2-6 dtk/hlm via img2table)**, sidecar kembali idle setelahnya — **tanpa hang**. Sebelum fix: log tidak pernah memuat "Kirim halaman ke table-ocr" untuk dokumen bagus (hanya muncul di uji sintetis saat halaman low-quality).

**Catatan operasional**: (1) test CLI 27-hlm yang di-abort (13:48) meninggalkan sidecar 5003 sibuk ±18 mnt (CPU 165-177%) menyelesaikan halaman PaddleX wired yang sedang diproses — request berikutnya mengantre (wajar, bukan hang); (2) proses background `verify_pipeline.js` yang di-spawn opencode ditemukan masih hidup padahal output sudah selesai ditulis — script tidak memanggil `process.exit()` sehingga event loop tetap terbuka; dibersihkan via kill; (3) komit `4e5c53a` (12:32, "v27-v29.2") sudah memuat seluruh fix kode v29.2+v29.3 termasuk early-return image di atas.

---

## Changelog — 2026-08-04 (v29.3)

### ringkasan
**Verifikasi end-to-end v29.1 pada dokumen asli user + penyempurnaan aturan garbage + perbaikan bug konkurensi.** Dua dokumen scan asli diverifikasi penuh (36 hlm + 18 hlm) dengan hasil: **cjk=0, symbols=0, mirrorRuns=0, glue=0** pada keduanya. Ditemukan 3 sisa cacat yang diperbaiki di `garbageTokens.js`; dan bug konkurensi pre-existing di `router.js` (cache preprocessed GLOBAL) yang menyebabkan status RUSAK saat dua konversi berjalan paralel.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/utils/garbageTokens.js` | `cleanLineText`: huruf tunggal setelah marker Lolos (sisa OCR kolom tabel "b. I", "d. F", "e. k"); "BABI" tidak dinormalisasi; baris tabel mirror tanpa vokal ("\| s88rsT smuA rdsqms& ... \|") tidak dihapus | (1) **huruf tunggal setelah penanda daftar dihapus** ("b. I Kelurahan" → "b. Kelurahan") — aman: "a. 1" (digit), "a. b. c. d." (marker) utuh; (2) **`normalizeGluedBABRoman`** ("BABI"→"BAB I", "BABII"→"BAB II") — "BABINSA" aman; (3) **baris konsonan-dense dihapus**: ≥5 token dengan ≥70% rasio konsonan (tanpa vokal) → baris garbage murni di-drop ("\| s88rsT smuA rdsqms& ... \|" hilang) — prosa normal/singkatan pendek ("APBD DAK DAU") aman |
| `src/ocr/router.js` | `_preprocessedCache[i]` GLOBAL di-index nomor halaman absolute | **cache PER-JOB**: `_getPageImage(imageBuffers, i, retry, engCfg, jobCache)` + `_recognizePageCascade(i, imageBuffers, jobCache)`; `performOcr` & `performOcrBlocks` bikin `const jobCache = []` lokal — dua konversi paralel (upload browser + batch) tidak lagi saling menimpa cache halaman → fix "Cannot set properties of undefined (setting '0')" → RUSAK |
| `test.js` | 182 tests | **187 tests** (+5: huruf tunggal setelah marker "b. I"/"d. F"/"e. k", marker/angka aman "a. 1"/"a. b. c. d.", BABI→BAB I + BABINSA aman, baris mirror konsonan-dense dihapus + prosa/singkatan aman, baris tabel angka utuh) |

### detail

**Verifikasi (runtime, dokumen asli user via `verify_pipeline.js` standalone — tanpa server, render 1x→rectify→deteksi tabel→render 2x/3x→`ocrRouter.performOcrBlocks`→`runReconstruction`)**:
- **Perbub Sampah 2/2020 (36 hlm, 7 halaman tabel)**: **147.070 char** (baseline v29 58.714 — konten lampiran yang dulu terpotong kini lengkap), **cjk=0, symbols=0, mirrorRuns=0, glue=0**, review 0.74 (4 issue), blocks=50, rotasi fallback aktif di hlm 10-15.
- **Perbub DAU Tambahan 20/2020 (18 hlm, 12 halaman tabel)**: **38.855 char** (sebelumnya 21.209 — run pertama terpotong memori), **cjk=0, symbols=0, mirrorRuns=0, glue=0**, review 0.87 (2 issue), blocks=28, tablePages=12.
- `npm test` 187 passed 0 failed; lint 0 error (20 warning pre-existing).
- **Catatan memori**: PC user hanya 7.8 GB RAM (bebas ±1-2 GB dengan opencode+VS Code+sidecar) — proses verify S3 sempat mati senyap 2× saat dua proses node+paddle jalan bersamaan; fix `verify_pipeline.js`: lepas `lowImages`/`images` (`length = 0`) agar canvas bisa di-GC sebelum pipeline lanjut. Server user (port 3000) sudah restart otomatis (PID baru) dan kini memuat kode v29.3.

---

## Changelog — 2026-08-04 (v29.2)

### ringkasan
**Perbaikan kelambatan/stuck konversi (user: "kenapa lama sekali disini, jika memang ada bug perbaiki")**. Investigasi: UI macet ±12 mnt di fase table-aware — (1) sidecar table-ocr (5003) hang (worker mati 0% CPU) sementara server menunggu SATU request batch 6 halaman dengan timeout `TABLE_AWARE_TIMEOUT=3600000` (1 JAM); (2) `OSD_ENABLED=false` diabaikan `deskewRouter.js` — Tesseract OSD tetap dicoba tiap halaman (timeout 1500 ms + reset worker tesseract.js yang rusak); (3) halaman wired-grid tak dibatasi — PaddleX table_recognition ~9 mnt/halaman di CPU, batch 6 halaman bisa 30-60+ mnt.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/services/tableAwareService.js` | `analyzeTables()`: SATU POST batch `{pages:[N]}` timeout `config.tableAware.timeout` | **per-halaman**: loop POST `{pages:[1]}` per halaman, timeout per halaman di-cap `MAX_PAGE_TIMEOUT=300000` (5 mnt); gagal/timeout satu halaman → `warn` + `tables: []` → lanjut halaman lain (skip aman); hasil urut sesuai input (mapping `taResults[k]` di router tetap valid) |
| `src/ocr/router.js` | `performOcrBlocks`: semua halaman wired → engine `paddlex` | **cap 2 PaddleX/dokumen**: counter `paddlexUsed`; halaman wired ke-3+ dialihkan ke `img2table` (~2 dtk) + log info — kualitas colspan 2 tabel pertama terjaga, batch ≤ ~20 mnt |
| `src/ocr/deskewRouter.js` | `tryTesseractOsd()` tanpa cek config | gate `config.osd.enabled === false` → `return null` (sama seperti `orientationDetector.js`) — hemat ±30 dtk/dokumen + stop reset worker tesseract.js yang rusak tiap halaman |
| `.env` | `TABLE_AWARE_TIMEOUT=3600000` | `TABLE_AWARE_TIMEOUT=300000` (5 mnt/halaman; kode juga cap di `MAX_PAGE_TIMEOUT`) |

### detail

**Verifikasi (runtime)**: dokumen scan 27 hlm via `/process-upload` — BERHASIL 77.1 dtk (test-tabel-sintetis, review 1.0, 0 issue, verify_output "SEMUA BERSIH"); log sidecar menunjukkan request **per-halaman** (`Halaman 1 gagal (img2table): cannot identify image file` — img2table gagal decode gambar tapi pipeline lanjut, skip aman, TIDAK hang). Run user (Perbub No 20/2020 compressed, 18 hlm) selesai normal 1063 dtk tanpa hang. `npm test` 182 passed 0 failed; lint 0 error (20 warning pre-existing).

**Catatan operasional**: (1) bila sidecar 5003 hang lagi (CPU 0% saat ada request), kill prosesnya — server fallback otomatis dalam ≤5 mnt (per-page timeout) dan sidecar di-auto-spawn ulang via `SIDECAR_AUTOSTART`; (2) jalur TEXT (PDF digital dengan text layer) tidak memanggil table-aware — hanya jalur SCAN; (3) run sintetis sebelumnya sempat TIDAK menulis file markdown client karena fetch gagal di tengah restart server — ulangi request bila terjadi.

---

## Changelog — 2026-08-04 (v29.1)

### ringkasan
**Perbaikan generik output rapi untuk SEMUA file (instruksi user: "perbaiki kode programnya yang kurang, agar hasil outputnya rapi, dan tidak ada hasil simbol simbol yang aneh aneh")**. Tiga cacat kode diatasi: (1) `_rescueGarbageBlocks` hanya membersihkan blok yang GAGAL gate kualitas — blok yang lolos gate tapi ber-prefix fragmen mirror ("T E SALINAN L R 3 1 E 5. E BUPATI DAIRI...") bocor ke output; (2) aturan token garbage tidak mengenali run fragmen mirror (token bare 1 huruf/angka berurutan) dan tidak menormalkan angka menempel ("TAHUN2020"); (3) `_filterWholePageGarbageLines` membuang SELURUH baris yang mengandung CJK ("Pasal 1 国" ikut hilang) padahal cukup dibersihkan token-nya. Semua aturan token dipusatkan di modul baru `src/utils/garbageTokens.js` (satu sumber kebenaran, dipakai router OCR + output cleaner). Dedup tetap TIDAK dijalankan (arsip, pelajaran v28).

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/utils/garbageTokens.js` (**baru**) | — | Modul bersama aturan token: `isOutputGarbageToken` (pindah dari outputCleaner), `isGarbageRunToken` (core 1 huruf/angka, bukan penanda daftar, bukan Rp), `isListMarker` ("a.", "b)", "(1)" — dilindungi), `cleanLineText`, `cleanGarbageText`, `normalizeGluedWordNumber` ("TAHUN2020" → "TAHUN 2020"), `fixInternalDots` ("SAL.INAN" → "SALINAN"; "Drs."/"a.n."/NIP. aman) |
| `src/reconstruction/cleaner/outputCleaner.js` | aturan inline 100 baris | re-export dari `garbageTokens` — API publik sama (`isOutputGarbageToken`, `cleanLineText`, `cleanOutputText`, `cleanLines`, `countGarbageTokens`) |
| `src/ocr/router.js` | `_rescueGarbageBlocks`: blok lolos gate dilewati tanpa pembersihan; `_filterWholePageGarbageLines`: baris ber-CJK dibuang utuh | (1) **pembersihan token TANPA SYARAT untuk SEMUA blok** sebelum cek `needsRescue` — fragmen mirror yang lolos gate ikut dirapikan; (2) `_filterWholePageGarbageLines`: token dibersihkan DULU (via `cleanLineText`), baru baris yang masih ber-CJK/readability < -0.5 dibuang — "Pasal 1 国" jadi "Pasal 1" (tidak hilang) |
| `src/reconstruction/builder/documentTreeBuilder.js` | sel tabel disimpan mentah (`_parseTable` + jalur `detectTableFromLines`) | sel tabel di-`cleanLineText` saat build — teks tabel TIDAK lewat pipeline `cleanLines` (hanya `ctx.lines`), jadi garbage mirror dalam sel ("1 1 T T 1 1", 国) sebelumnya bocor ke markdown |
| `scripts/verify_output.js` (**baru**) | — | Verifikasi output instan: hitung CJK/simbol/mirror-run/TAHUN-menempel/dot-internal dari file markdown tersimpan (tanpa OCR ulang); mode `--upload <pdf> <out>` sekaligus upload; exit 1 bila ada anomali |
| `test.js` | 174 tests (7 cleaner) | **182 tests** (+8: run mirror "T E SALINAN L R 3 1 E 5. E" → "SALINAN BUPATI DAIRI", multi-line, TAHUN2020/NOMOR20, struktur sah "BAB I di daerah"/"huruf a ayat (1)"/"Rp 5.000"/"1. Undang-Undang Dasar 1945", run digit "kota kecil Kota 1 1" utuh, "1 1 T T 1 1" dihapus, dot internal, sel tabel dibersihkan) |

### detail

**Aturan run mirror**: run ≥2 token bare berurutan (core tepat 1 huruf/angka + punct tepi opsional) yang memuat ≥1 huruf tunggal → seluruh run dihapus. Aman untuk: "BAB I" (run 1 token), "huruf a", "Rp 5.000" ("Rp" 2 huruf bukan bare), "1. Undang-Undang" (penanda angka + kata panjang), "kota kecil Kota 1 1" (digit saja, tanpa huruf), "1: 3:" (tanpa huruf tunggal). Menghapus: "T E", "L R 3 1 E 5. E", "1 1 T T 1 1".

**Verifikasi (runtime)**: dokumen 27 hlm scan (Perbub Desa Wisata 1/2020, dari `uploads/`) — status BERHASIL, **145 dtk** (vs ~270 dtk sebelum OSD off), markdown 28.950 char, **0 CJK, 0 simbol (∪/ν/¹)**, prefix mirror "T E ... L R 3 1 E 5. E" hilang (residu "L SAL.INAN T" → "L SALINAN T" setelah fixInternalDots), review skor 0.84. Dokumen 36 hlm digital (Perbub Sampah 2/2020): 36 dtk, **0 CJK, 0 simbol**, 0 TAHUN menempel, review skor 0.97. `npm test` 182 passed 0 failed; lint 0 error (20 warning pre-existing). Catatan: "Va_nod.ww:" di dokumen digital = artefak text layer PDF sumber (bukan OCR); residual "n Hu" kecil = sisa gabungan band repair halaman 1 scan.

---

## Changelog — 2026-08-03 (v28)

### ringkasan
**Pemulihan kelengkapan output (prioritas user: semua isi teks keluar, bukan estetika)**: `_dedupeConsecutive` (v27) terbukti membuang 31 dari 37 baris dokumen 36 hlm — karena tiap "line" pipeline = teks SATU HALAMAN PENUH, dan header hukum berulang di tiap halaman ("BUPATI DAIRI PROVINSI SUMATERA UTARA...", frasa pasal) membuat overlap token ≥60% antar halaman berurutan → markdown 58.738 → **11.946 char** (13 → 6 children). Fungsi dihapus total. Selain itu `repairTableBlocks` (v27) menerima canvas mentah/variant tanpa deskew → 0 region grid → repair mati senyap → tabel miring (hal 30/32) kehilangan blok region. Perbaikan: repair memakai cache rectified `_preprocessedCache[i][bestRetry]` + `rotateCanvas(bestAngle)` untuk halaman yang dikoreksi rotasi.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/reconstruction/builder/documentTreeBuilder.js` | `build()`: `_dedupeConsecutive(lines)` → `detectTableFromLines` + `_groupIntoParagraphs` | `lines` langsung (perilaku v26) — `_dedupeConsecutive` dihapus total (menghilangkan konten: baris = halaman penuh, header berulang → overlap ≥60% → 31/37 baris dibuang) |
| `src/ocr/router.js` | `repairTableBlocks(bestImg, ...)` — bestImg = canvas mentah atau variant threshold+rotate TANPA deskew → 0 region → repair skip senyap; `outcome.image` = bestImg jelek → table-aware gagal di hal 30/32 | repair pakai `_preprocessedCache[i][bestRetry]` (gambar rectified: deskew+perspective+threshold) + `rotateCanvas(cached, bestAngle)` bila halaman dikoreksi rotasi → grid lurus → region terdeteksi (perilaku v26) dengan urutan v27 (setelah rotasi); saat repair berhasil `bestImg = repairImg` → table-aware/rescue dapat gambar berkualitas; + `logger.warn` bila 0 region pada halaman masih jelek (cegah regresi senyap) |
| `test.js` | 170 tests | 167 tests — hapus 3 test `_dedupeConsecutive` |

### detail

**Bukti regresi v27 (log `08-03`)**: dokumen sama (Perbub Sampah 2/2020, 36 hlm) — run 08:58 (v26): 37 blocks/37 lines/**13 children**/**58.738 char**; run 10:02/10:30/10:55 (v27): 37 blocks/37 lines/**6 children**/**11.946 char**. Blok OCR identik — perbedaan murni di `documentTreeBuilder` karena dedup membuang halaman 2–36 (header + frasa hukum berulang → overlap ≥60%). `repairTableBlocks` di v27 juga tidak pernah jalan (0 baris "Repair tabel" di 3 run; v26: "1 region terdeteksi" tiap run).

**Verifikasi**: `npm test` 167 passed 0 failed; lint 0 error. Setelah re-run: target markdown ≥50K char, "Repair tabel: 1 region terdeteksi" muncul, tabel hal 30/32 terisi, table-aware 21/29/34, tanpa simbol (SYMBOL_RE v27 dipertahankan).

---

### ringkasan
**Empat perbaikan kualitas output berdasar evaluasi hasil `npm start` dokumen Perbub Dairi**: (1) kolom tabel halaman miring tersusun benar via OCR per-sel berbasis garis grid; (2) garbage non-Latin (Yunani ν, ∪, superscript ¹, "bo20202") kini terdeteksi gate; (3) loop re-OCR anti-simbol-terbalik dengan eskalasi skala (saran user); (4) dedup baris tabel lintas halaman. 14 unit test baru — total 170 passed.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/ocr/tableRegionOcr.js` | region OCR saja di `repairTableBlocks` | + `ocrGridCells()` — garis grid → rect per sel → `ocrTableCell` (2×) → `formatAsciiTable`; grid per-sel menang bila skor > region OCR (tanpa regresi), blok whole-page yang kontennya tercakup tabel dibuang |
| `src/ocr/router.js` | `repairTableBlocks` dipanggil SEBELUM fallback rotasi (tidak berguna untuk halaman miring 90° — grid belum selaras) | repair dipindah SETELAH fallback rotasi (grid selaras di gambar ter-rectify) + loop baru `_reOcrWithScaleEscalation` — output masih mirror garbage (CJK/Yunani/∪/tanpa kata umum) atau belum accepted → upscale 1.5×→2×→2.5×→3× + OCR ulang, hasil dipakai hanya bila skor lebih baik |
| `src/ocr/qualityMetrics.js` | `isGarbageWord`: CJK, digit, Latin 1-char | + simbol non-Latin ≥40% tanpa huruf Latin ("ν1"), simbol terisolasi ("∪", "ν"), superscript berulang ("u¹5nu1¹5aux"), digit-dominan dengan ≤2 huruf ("bo20202", kecuali Rp…/angka murni) |
| `src/reconstruction/builder/documentTreeBuilder.js` | — | + `_dedupeConsecutive()` — baris berurutan lintas halaman dengan overlap token ≥60% (token ≥4 huruf, min 4 token) dibuang |
| `test.js` | 156 tests | +14 tests (section 13) = 170 |

### detail

**OCR per-sel (P1)**: tabel halaman miring sebelumnya dibaca whole-page → sel antar kolom tercampur ("Dinas Lingkungan…Hidup" terbelah, header "TAHUN NOKEBIJAKAN…" berulang). Sekarang di halaman yang sudah di-rectify: `_detectHorizLines`/`_detectVertLines` → grid sel (min lebar 10px, min 2 kolom, min 2 baris) → tiap sel di-crop + 2× upscale + grayscale+threshold → OCR → `formatAsciiTable`. Gate skor `computeQualityScore` menjamin tidak ada regresi vs region OCR/whole-page.

**Loop eskalasi skala (P5, saran user)**: `_hasMirrorGarbage(text)` = CJK | Yunani | ∪ | superscript | box-drawing | `commonWordRatio === 0`. Bila output masih mengandung itu atau belum accepted setelah retry+rotasi, gambar (orientasi terbaik yang diketahui) diperbesar bertahap 1.5×→3× dan di-OCR ulang sampai bersih; hasil terbaik selalu disimpan (tidak pernah menurunkan).

**Verifikasi**: `npm test` 170 passed 0 failed (156 lama + 14 baru: isGarbageWord Yunani/∪/¹/bo20202 + false-positive protection 1.000/Rp1.500/tahun2020, `_hasMirrorGarbage`, no-op eskalasi, dedup lintas halaman), lint 0 error (20 warning lama, tidak dari sesi ini).

---

## Changelog — 2026-08-03 (v26)

### ringkasan
**Perbaikan garbage mirror pada halaman tabel miring (hal 30/34)**: teks OCR hasil fallback rotasi terbaca terbalik ("NOLERA TA RORANS...", "国", "lpom era") dan lolos gate kualitas (score 0.89). Akar masalah ditemukan via instrumentasi bertahap: `_tryRotationVariants` meng-rotate gambar **dulu**, lalu `grayscale+threshold` — threshold pada gambar yang sudah di-rotate menghasilkan binary rusak → PaddleOCR membaca mirror garbage. Selain itu `_rescueGarbageBlocks` (tryBandRescue) selalu mencoba rescue untuk blok whole-page — bahkan yang sudah bersih — sehingga filter membuang baris konten dan skor anjlok. Perbaikan: preprocess sebelum rotate, rescue hanya untuk blok yang gagal gate, dan kriteria `firstReadable` memakai total huruf.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/ocr/router.js` | `_tryRotationVariants`: rotateCanvas dulu → preprocessImage | preprocessImage (grayscale+threshold) **dulu** → rotateCanvas/mirror pada binary |
| `src/ocr/router.js` | `_rescueGarbageBlocks`: `tryBandRescue = !hasBbox && wordCount >= 3` — selalu jalan untuk blok whole-page; filter/repair dijalankan sebelum gate | filter/repair/probe HANYA jika `needsRescue` (cjk ≥ 1 / garbageRatio > 0.35 / common === 0) — blok bersih di-pass tanpa disentuh |
| `src/ocr/router.js` | `_repairWholePageTopBand` firstReadable: `letters = match(/[a-zA-Z]+/g).length` (match-count kata) | `match(/[a-zA-Z]/g).length` (total huruf) + `len ≥ 15 && digits ≤ 4` — baris konten "2) Pelaksanaan training of trainer" terdeteksi, "lpom era"/"nCurAA1/Dcsa" tidak |
| `src/utils/tableFormatter.js` (sesi sebelumnya — belum tercatat) | literal `\nNone` lolos `\bNone\b` (didahului huruf "n" — tanpa word boundary) | `cleanCellText` konversi `\\n`, `&#10;`, `&#13;` → newline nyata SEBELUM menghapus `None`/border |

### detail

**Urutan preprocess krusial**: test terkontrol membuktikan — rotate(-90) mentah → OCR = "TAHUN NOKEBIJAKAN..." (bersih); rotate(-90) → grayscale+threshold → OCR = mirror garbage; grayscale+threshold → rotate(-90) → OCR = bersih. Threshold Otsu global pada gambar yang sudah di-rotate memilih ambang yang merusak stroke huruf.

**Temuan debugging** (untuk referensi): blok whole-page hasil fallback adalah 1 blok raksasa campuran garbage+konten (PaddleOCR `recognizeBlocks` tanpa bbox); band 420px atas gambar benar = header bersih; `_lineReadability` berbasis match-count membuat threshold 0.5 mustahil untuk baris pendek (semua baris < 0.07).

**Verifikasi (sample 36 hlm, e2e penuh)**:
- Hal 30: fallback `-90°` 0.43→**0.97**, paddle 1258 chars bersih, **semua 47 baris konten ada** — termasuk baris yang img2table drop ("Hidup Pekerjaan Umum dan", "Tata Ruang, Desa,", "Kelurahan, Pemberdayaan", "Kesejahteraan Keluarga", "e. Pembentukan jejaring nasional...", "sistem data dasar...", "informasi Sampah RumahTangga dan") dan yang tadinya dibuang filter ("Kota kecil Kegiatan 2 2 2...", tahun "202020212022202320242025"). Table-aware TIDAK menimpa (prosa hilang dicegah).
- Hal 34: fallback `-90°` 0.00→**0.96**, table-aware 8579 (img2table) menggantikan, cjk=0, none=0 — tidak ada regresi.
- E2E 36 hlm: **semua accepted** (score 0.77-0.99), TOTAL CJK 8 (P24:1, P26:7), none=0.
- `npm test`: 156 passed 0 failed; lint 0 error.

**Catatan sisa**: P24/P26 masih menyisakan CJK kecil (1 & 7 char, accepted) — baris garbage yang lolos rescue probe; bukan target sesi ini.

---

## Changelog — 2026-08-03 (v25)

### ringkasan
**Menutup sisa kasus simbol pada halaman tabel grid miring + otomatisasi sidecar.** Tes user (npm start, tanpa sidecar) menunjukkan 3 blok simbol tersisa di Lampiran I — semua halaman tabel ber-grid miring yang lolos koreksi. Akar masalah: (1) `detectTextOrientation` hanya melihat komponen terbesar — garis grid miring jadi komponen horizontal palsu (θ≈0) → halaman dianggap tegak; (2) halaman yang tetap miring (mis. hal 30 = "西 T W E 丽 图...") LOLOS gate kualitas karena token Latin 1-char terisolasi tidak dihitung garbage → fallback retry tidak pernah aktif; (3) sidecar harus dijalankan manual. Perbaikan: agregat area komponen vertikal vs horizontal, OCR multi-arah dengan skor keterbacaan (kata+digit−CJK), aturan garbage token Latin 1-char, fallback variasi rotasi 180/±90 di router untuk halaman kualitas rendah, dan **auto-start sidecar saat `npm start`** (`SIDECAR_AUTOSTART` + `PYTHON_BIN`).

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/ocr/orientationDetector.js` | `detectTextOrientation` pakai komponen terbesar; `pickRotationDirection` OCR ±90 + commonWordRatio | + **agregat area** komponen vertikal (|θ|≥80) vs horizontal (|θ|≤10), `rotated` (ratio≥0.55) / `ambiguous` (0.45-0.55); `pickRotationByOcr` — OCR 0/±90 (+180 opsional, downscale 700px), skor `_readabilityScore` = 10×commonWordRatio + huruf + digit − penalti CJK, rotate hanya jika margin ≥ 0.05; `rotateCanvas` di-export |
| `src/ocr/qualityMetrics.js` | `isGarbageWord`: digit & CJK saja | + token Latin 1-char terisolasi (selain a/i — "BAB I" aman) = garbage → halaman miring dengan token pecah ("T W E M I R N") kini ditolak gate kualitas → memicu retry/fallback |
| `src/ocr/router.js` | cascade selesai di retry terakhir | + `_tryRotationVariants` — jika halaman masih low-quality setelah retry: OCR 180/±90 (preprocess tanpa steps rectify), pilih skor terbaik; log "koreksi rotasi OCR fallback" |
| `server.js` | start() hanya initDatabase + listen | + auto-start sidecar async (spawn Python deskew 5002 + table-ocr 5003, health check 120s, anti-dobel via port probe, kill saat exit/SIGINT/SIGTERM) — gagal sidecar TIDAK menggagalkan server |
| `src/config/index.js` | — | + block `sidecar`: `autostart` (SIDECAR_AUTOSTART, default true), `pythonBin` (PYTHON_BIN, default `python`) |
| `.env` | — | + `SIDECAR_AUTOSTART=true`, `PYTHON_BIN=C:\Users\ACER\.conda\envs\jdi-ocr\python.exe` |
| `sidecar/run_deskew.py` | — (baru) | peluncur deskew port 5002, set PATH+TESSDATA (menyamai pola `run_server.py`) |
| `scripts/sidecars.js` | — (baru) | `npm run sidecars` — spawn manual kedua sidecar (log inherit) |
| `start-sidecars.bat` | — (baru) | double-click → 2 jendela sidecar (baca PYTHON_BIN dari .env) |
| `scripts/e2e-check.js` | — (baru) | alat regresi: pipeline penuh + laporan CJK per halaman |

### detail

**Kenapa agregat area, bukan komponen terbesar**: halaman tabel grid miring — garis grid asli-vertikal jadi horizontal (θ≈0) dengan area besar; teks sel (vertikal, θ≈90) kalah area jika hanya komponen terbesar yang diambil → verdict "tegak". Dengan agregat area semua komponen (≥0.05% halaman), teks sel + garis asli-horizontal yang kini vertikal menang (ratio ≥ 0.55) → terdeteksi. Grid super-dominan → ratio ≈ 0.5 → `ambiguous` → **OCR 4-rotasi** (0/90/180/270) memutuskan — sekaligus menutup kasus 180°.

**Skor keterbacaan** `_readabilityScore`: rasio kata umum Indonesia (kamus textLayerValidator) ×10 + proporsi huruf + digit (tie-breaker tabel angka-murni) − penalti CJK×1.5 (tanda teks miring terbaca simbol). Margin 0.05 menghindari false-positive rotate pada halaman tegak.

**Verifikasi (sample 36 hlm, e2e penuh)**:
- `correctOrientation` scale 2.0: **24/25 halaman miring terdeteksi** (hal 12-29, 31-36); hal 30 MISS kontur (grid super-dominan, ratio < 0.45).
- Hal 30 diselamatkan **fallback router**: garbage baru → ditolak gate (score 0.43) → `_tryRotationVariants` → `-90°` (score 0.89, teks "2) Pelaksanaan training of trainer..." terbaca, cjk 14→1).
- E2E 36 halaman: **semua accepted** (score 0.72-0.99), **TOTAL CJK 3 karakter** (sebelumnya 3 blok simbol penuh). tablePages: 16,18,24,26,29,32.
- Auto-start: `node server.js` → server siap + "Sidecar table-ocr siap di 5003" (~4s); deskew siap dalam ≤120s (import cv2 lambat); port bersih setelah kill.
- `npm test`: 146 passed 0 failed; lint 0 error (15 warnings baseline).

**Catatan sisa**: hal 30 masih menyisakan ~15% noise blok (mirror/terpotong) di sebagian sel tabel — mayoritas teks terbaca; hal 34: 2 CJK. Skew halus non-90° tetap di luar cakupan (deskew-adaptive menangani ±15°).

---

## Changelog — 2026-08-02 (v24)

### ringkasan
**Penutupan gap pipeline web app (Node)**: konten lampiran yang discan miring 90/180/270° DI DALAM halaman portrait (ukuran halaman tetap portrait) tidak pernah dikoreksi di jalur OCR biasa — `correctOrientation` hanya menangani halaman landscape (h<w). Kini `correctOrientation` untuk halaman portrait: (1) coba **Tesseract OSD** (`tryTesseractOsd`, tesseract.js) → (2) jika worker OSD tidak tersedia (env ini: "LSTM requested, but not present" — tesseract.js 5.1.1 gagal buat worker `osd`), **fallback kontur + OCR arah**: connected components (runs + union-find, JS murni) → θ (momen inersia) komponen teks terbesar ≥ 80° = teks vertikal → arah CW/CCW ditentukan OCR 2 kandidat (rotate ±90, downscale 700px) dengan engine paddle (reuse cache router) + `commonWordRatio` dari `textLayerValidator`.

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/ocr/orientationDetector.js` | `correctOrientation`: hanya `height < width` → rotate -90, portrait → skip | + OSD portrait (tryTesseractOsd + gate `config.osd.minConfidence`, normalisasi conf 0-1→0-100) → fallback kontur: `detectTextOrientation` (downscale ≤1600px, Otsu, connected components 8-connectivity via runs, θ momen inersia komponen terbesar, ekspor non-publik), `pickRotationDirection` (OCR 2 kandidat paddle downscale 700px, `commonWordRatio`), `_getOsdEngine` (reuse `ocrRouter.getActiveEngine()` paddle → hindari 2× model OCR; stale engine → reset saat error) |

### detail

**Kenapa kontur, bukan proyeksi/run** (semua divalidasi empiris di dokumen nyata 36 hlm):
- Proyeksi densitas baris/kolom & hitungan run panjang: TIDAK diskriminatif (hal 2 tegak vs hal 12 miring sama-sama nH=6; miring malah punya run horizontal panjang karena karakter tipis rapat).
- Komponen teks θ: bekerja di resolusi ≥ huruf ~18px (render scale ≥ 1.5-2.0). **Gagal saat huruf < ~15px** (render scale 1.0 / downscale 1000px): teks melebur jadi blob horizontal palsu (komponen terbesar θ≈0 untuk halaman miring).
- θ komponen terbesar (scale 2.0): hal 2 → -0.2 (tegak), hal 12 → 88.2, hal 13 → 88.8, hal 24 → -86.8 (miring) — cocok dengan OSD Python.
- Tanda θ TIDAK menentukan arah (hal 12 θ+88 butuh CW, hal 27 θ+85 butuh CCW) → arah via OCR 2 kandidat + rasio kata umum.
- Keterbatasan: 180° tidak terdeteksi kontur (OSD menangani jika tersedia); server.js pass 1 render scale 1.0 (table boost) tidak ter-rectify (huruf terlalu kecil) — dampak terbatas karena pipeline OCR utama (scale 2.0-3.0) yang menghasilkan teks.

### verifikasi
- `correctOrientation` (scale 2.0): hal 2 tetap 1224×2016 (OCR ratio 0.40); hal 13/24/36 → 2016×1224 (OCR ratio 0.45/0.28/0.25 — teks normal, tanpa simbol).
- Jalur reuse engine: `ocrRouter.getActiveEngine()` paddle → hal 13/24 ROTATED, hal 2 tetap; `resetEngine` bersih.
- `npm test`: 146 passed 0 failed; lint 0 error (15 warnings baseline).

---

## Changelog — 2026-08-02 (v23)

### ringkasan
**Koreksi rotasi robust untuk dokumen scan miring** — lampiran tabel (landscape) yang discan miring 90° di halaman portrait membuat Tesseract membaca **simbol-simbol** (garbage) jika rotasi tidak dikoreksi. `table_aware_ocr.py` bergantung penuh pada Tesseract OSD (`image_to_osd`); di lingkungan tanpa `tesseract-osd` (atau OSD gagal), `detect_rotation_angle()` mengembalikan 0 → tidak ada koreksi → simbol (direproduksi). Solusi: **fallback OCR 4-orientasi** (`--psm 6` pada gambar downscale ≤1000px, pilih rotasi dengan `common_word_ratio` tertinggi) — teruji 100% akurat pada 7 halaman dokumen nyata (rotasi prediksi cocok dengan OSD). Backport sama diterapkan ke sidecar `table_ocr/main.py` + **transform bbox balik** ke koordinat gambar asli (Node meng-crop bbox dari gambar yang tidak di-rotate).

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `table_aware_ocr.py` | `detect_rotation_angle()`: OSD saja, `except pytesseract.TesseractError: return 0` | + fallback `_detect_rotation_by_ocr()` — OCR 4-rotasi + `common_word_ratio`, return `(-best) % 360` (konvensi OSD, dipakai `apply_rotation`); `except Exception` + log peringatan; + `_ocr_page_text()` — PSM 3 default, retry `--psm 6` saat osd hilang (gambar sudah tegak dari koreksi) |
| `sidecar/table_ocr/main.py` | `/analyze` langsung ke engine, tanpa rotasi | + `_ensure_rotation()` (OSD → fallback OCR 4-orientasi, konvensi sama) diterapkan sebelum engine; + `_map_bbox_back()` transform bbox 90/180/270 kembali ke koordinat gambar asli (Node crop dari gambar asli); bbox pydantic di-assign ulang |

### detail

**Diagnosis (dokumen nyata: Perbub No 2 Tahun 2020 - 36 hlm scan murni)**:
- Hal 1-11 tegak; **hal 12-36 lampiran discan miring 90°** (OSD rotate=90 conf 17-22 utk hal 12-17, rotate=270 utk hal 18-36). Bukan landscape page (612×1008 pt portrait) → `orientationDetector` Node (h<w) tidak menangkap → pipeline web app juga kena kasus ini.
- Reproduksi: `process_page` dengan OSD dimatikan → simbol total (`900 I �08661 ZZOTOLE!`); dengan OSD aktif → teks normal + tabel. Fallback OCR 4-orientasi menghasilkan prediksi rotasi yang **sama persis dengan OSD** (hal 12-14 → 90, hal 24-36 → 270).
- Bug arah fallback (v1): return `best` (sudut probe CCW) tapi `apply_rotation` butuh konvensi OSD (`rotate(-angle)`) → arah terbalik → tetap simbol; fix: `(-best_angle) % 360`.
- Pendekatan lain ditolak setelah validasi empiris: proyeksi densitas baris/kolom (gagal: hal 2 tegak terdeteksi miring, hal 12 miring terdeteksi tegak), minAreaRect (normalisasi sudut menyesatkan, hal 36 diduga tegak padahal rotate=270), flip LR (bukan mirror).

**Transform bbox balik** (koordinat gambar ter-rotasi → gambar asli, di mana Node crop):
- rotate(-90)/angle=90: `(x,y) → (y, H-1-x)`; angle=270: `(x,y) → (W-1-y, x)`; angle=180: `(x,y) → (W-1-x, H-1-y)`. 4 sudut bbox dipetakan → min/max.

### verifikasi
- `process_pdf` penuh 36 hlm: 36 OCR ulang, 22 tabel terdeteksi, rotasi hal 12-17=90 / 18-36=270; hal 12 output normal (`LAMPIRAN I PERATURAN BUPATI DAIRI` + tabel angka `41,483.79` dst, tanpa simbol).
- Simulasi env tanpa OSD (monkeypatch `image_to_osd` → raise): fallback → hal 12-14 rotasi 90, 24-36 rotasi 270, semua teks normal.
- Sidecar: uvicorn 5003 + POST /analyze hal 12 (img2table) → 1 tabel, bbox `[643,254,1078,2355]` dalam bounds asli 1700×2800 ✓ (strip vertikal = bentuk konten miring, transform konsisten); sidecar dimatikan setelah verifikasi.
- `npm test`: 146 passed, 0 failed.

---

## Changelog — 2026-08-02 (v22)

### ringkasan
**Table-Aware OCR (hybrid img2table + PaddleX)** via sidecar `sidecar/table_ocr/` — hasil komparasi empiris (v21b/2b) menunjukkan img2table lemah pada grid wired + colspan (header baris terduplikasi) dan PaddleX tidak mendeteksi tabel borderless; solusi: **gate piksel murah** (`detectWiredGridRegions`, Otsu + run-length, ~140 ms/halaman, verifikasi 4/4 pada sintetis) menentukan engine per halaman: grid wired (≥3 garis vertikal dalam band, margin 5% tepi, tanpa fallback horizontal-only) → PaddleX `table_recognition` (colspan akurat), halaman lain → img2table. Blok hasil sidecar (`source: 'table-aware'`) menggantikan blok OCR dalam region tabel di pipeline reconstruction.

### file baru

| File | keterangan |
|---|---|
| `sidecar/table_ocr/main.py` | FastAPI port 5003: `POST /analyze` (pages [{image, engine}]) hybrid; img2table (TesseractOCR ind+eng, borderless+implicit rows) / PaddleX `table_recognition` lazy singleton (env: PADDLE_PDX_MODEL_SOURCE=modelscope, PIR ON, mkldnn OFF); `GET /health` (termasuk debug tesseract/PATH); per-halaman error tidak membatalkan batch |
| `sidecar/table_ocr/requirements.txt` | paddlepaddle==3.3.1, paddleocr 3.7.0, paddlex[ocr] 3.7.2, img2table 2.0.0, opencv-contrib-python==4.10.0.84, fastapi, uvicorn, pytesseract, pandas |
| `sidecar/table_ocr/Dockerfile` | python 3.10-slim + tesseract-ocr + tesseract-ocr-ind + libgl/libgomp, port 5003 |
| `sidecar/table_ocr/run_server.py` | entry dev Windows: set PATH (Library\bin) + TESSDATA_PREFIX dari dalam Python (Task Scheduler/WMI tidak mewarisi PATH conda; `setdefault` tidak menimpa PATH yang ada) |
| `src/services/tableAwareService.js` | client HTTP: `analyzeTables(pages)` batch, health check 3 s, timeout `TABLE_AWARE_TIMEOUT` (default 30 mnt), unreachable → return null (skip, pipeline normal) |

### file diubah

| File | sebelum | sesudah |
|---|---|---|
| `src/ocr/tableRegionOcr.js` | `detectTableRegions()` (fallback horiz-only = false positive paragraf padat) | + `detectWiredGridRegions()` gate ketat run-length VERTIKAL per band (run kontigu → 1 garis, prototipe c17), export `blockInRegion` |
| `src/ocr/router.js` | `performOcrBlocks()` flatten per halaman, tanpa table-aware | refactor `perPage[]` + batch request: gate per halaman (outcome.image dari cascade = gambar ter-rectify bestRetry) → `analyzeTables` → blok `source:'table-aware'` (ASCII via `formatTableHtmlToText`) menggantikan blok dalam bbox tabel; `_recognizePageCascade` ekspose `image` |
| `src/ocr/cellOcr.js` | `normalizeBbox` object {x,y,w,h}: precedence ternary salah → `w`/`h` = NaN (bug dormant, blok engine pakai array) | fix precedence: `w = bbox.w \|\| bbox.width \|\| (bbox.right != null ? ...)` |
| `src/config/index.js` | — | + `tableAware` block: `enabled` (TABLE_AWARE_ENABLED, default off), `serviceUrl` (TABLE_AWARE_SERVICE_URL), `timeout` (TABLE_AWARE_TIMEOUT 1800000) |
| `.env` | — | + `TABLE_AWARE_ENABLED=true`, `TABLE_AWARE_SERVICE_URL=http://127.0.0.1:5003`, `TABLE_AWARE_TIMEOUT=3600000` |
| `docker-compose.yml` | 5 services | + `table-ocr` (5003, volume `table_ocr_cache:/root/.paddlex`), env TABLE_AWARE_* di app |
| `test.js` | 137 tes | + 9 tes section `=== 15. Table-Aware Gate & Config ===` = **145 passed**: config defaults, gate grid wired/blank/border-box/horizontal-only/paragraf, blockInRegion, analyzeTables disabled |

### detail

**Hasil komparasi (dasar desain, 4 halaman sintetis)**:
- hal 1 (paragraf): img2table 0 tabel ✓ / PaddleX 0 tabel ✓
- hal 2 (grid wired + colspan): img2table header duplikat ✗ / **PaddleX 1 tabel, colspan benar** (519 dtk incl. init pipeline) ✓
- hal 3 (borderless): **img2table 1 tabel isi benar** ✓ / PaddleX 0 tabel (borderless tak terdeteksi) ✗
- hal 4 (landscape grid): img2table tersebar 3 blok ✗ / PaddleX 1 tabel semua sel merger ✗

**Gate `detectWiredGridRegions`** (port produksi dari `c17-triase-v3-test.js`):
```
Otsu → garis H run-length (≥60% width) → band antar 2 garis H berturutan
→ per band: garis V run-length ≥60% tinggi BAND (bukan full page!)
→ ≥3 garis V inner (margin 5% tepi, tolak border kotak halaman) → region
```
Verifikasi sintetis: gate 0/9/0/1 (4/4 benar); paragraf padat 0 (run-length menghindari FP kolom teks terisolasi).

**Env PaddleX yang stabil** (crash PIR/mkldnn, lihat catatan 2b): paddlepaddle **3.3.1**; `PADDLE_PDX_MODEL_SOURCE=modelscope` (huggingface diblokir); `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True`; `PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT=False`; `FLAGS_use_mkldnn=0`. **JANGAN set `FLAGS_enable_pir_api=0`** (gagal load model PIR: `type of attribute: strides is not right`). `pipe.predict(path)` — input positionally, dict `{"input": ...}` ditolak. PP-StructureV3 (RT-DETR cells/DocLayout) crash access-violation di CPU → ganti `create_pipeline("table_recognition")` (SLANet v1, stabil).

**Dev server Windows**: Task Scheduler `schtasks /run` bisa stuck "Queued" dan cmd/bat parsing rusak (LF/`%PATH%`) → spawn via `Invoke-CimMethod Win32_Process.Create` (proses lahir dari WmiPrvSE, lepas dari job-tree tool; env TIDAK diwarisi dari PowerShell → `run_server.py` set PATH/TESSDATA dari dalam Python).

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
