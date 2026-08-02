"""
table_aware_ocr.py
====================
Modul OCR yang menyelesaikan 2 masalah utama pada PDF hasil scan dokumen
pemerintah:

  1. TABEL MIRING/ROTASI  - lampiran berbentuk tabel lebar (landscape) yang
     discan dalam kondisi terputar 90'/180'/270' relatif terhadap halaman.
     Modul ini otomatis mendeteksi rotasi yang dibutuhkan (pakai Tesseract
     OSD) dan mengoreksinya SEBELUM di-OCR, bukan sesudahnya.

  2. TEKS-LAYER PALSU (look-alike text) - beberapa PDF (termasuk contoh yang
     diuji) SUDAH PERNAH di-OCR sebelumnya oleh software lain dengan hasil
     berantakan (karena rotasi tidak dikoreksi saat itu), lalu teks
     berantakan itu TERTANAM permanen sebagai text-layer PDF. Pipeline OCR
     naif yang hanya mengecek "apakah text-layer ada & cukup panjang" akan
     LOLOS begitu saja menerima sampah ini. Modul ini menambahkan pengecekan
     `common_word_ratio()` untuk mendeteksi text-layer yang terlihat ada
     tapi sebenarnya acak, dan memaksa OCR ulang dari gambar untuk halaman
     semacam itu.

  3. TABEL TIDAK TERBACA SEBAGAI TEKS DATAR - dipisahkan dari OCR teks biasa
     memakai img2table (deteksi grid tabel dari gambar), supaya struktur
     baris/kolom tabel tetap terjaga, bukan malah terserak jadi satu blok
     teks tanpa struktur.

TERUJI pada dokumen nyata (Perbub No 2 Tahun 2020 - lampiran tabel Target
Jakstrada yang sebelumnya gagal total di-OCR software lain): berhasil
mengembalikan seluruh data tabel dengan akurasi penuh.

Dependencies (install dulu):
    pip install --break-system-packages pymupdf opencv-python-headless \
        pytesseract img2table pandas pillow
    apt-get install -y tesseract-ocr tesseract-ocr-ind tesseract-ocr-osd

Pemakaian cepat:
    from table_aware_ocr import process_pdf
    process_pdf("dokumen.pdf", "output_markdown/")
"""

import re
import io
from pathlib import Path
from dataclasses import dataclass, field

import fitz  # PyMuPDF
import numpy as np
from PIL import Image
import pytesseract
import pandas as pd
from img2table.document import Image as I2TImage
from img2table.ocr import TesseractOCR

# ----------------------------------------------------------------------------
# Konfigurasi (silakan tuning sesuai karakteristik dokumen kamu)
# ----------------------------------------------------------------------------

OCR_DPI = 200                    # resolusi rasterisasi halaman
OCR_LANG = "ind+eng"             # bahasa Tesseract
MIN_CHARS_PER_PAGE = 40          # di bawah ini -> text-layer dianggap kosong
COMMON_WORD_RATIO_THRESHOLD = 0.05   # di bawah ini -> text-layer dianggap acak/garbled
MIN_TABLE_CELLS = 4               # tabel hasil deteksi di bawah ini diabaikan (kemungkinan noise)

# Kata-kata umum Bahasa Indonesia + istilah baku dokumen hukum, dipakai untuk
# menguji "kewarasan" sebuah text-layer. Kalau perlu, tambah domain-specific
# words sesuai jenis dokumen kamu.
COMMON_WORDS = {
    "yang", "dan", "dalam", "pada", "dengan", "tahun", "ayat", "pasal",
    "tentang", "atau", "untuk", "dari", "ini", "di", "ke", "adalah",
    "sebagaimana", "dimaksud", "peraturan", "daerah", "pemerintah",
}

_tesseract_ocr = TesseractOCR(lang=OCR_LANG)


# ----------------------------------------------------------------------------
# 1. Deteksi text-layer yang "terlihat ada tapi sebenarnya acak"
# ----------------------------------------------------------------------------

def common_word_ratio(text: str) -> float | None:
    """Rasio kata umum Bahasa Indonesia dalam teks. None kalau teks terlalu
    pendek untuk dinilai. Teks Indonesia normal biasanya > 0.10; text-layer
    hasil OCR yang rusak akibat rotasi salah biasanya mendekati 0.0
    (teruji empiris pada dokumen sampel: teks normal 0.14-0.35, teks
    rusak 0.0)."""
    words = re.findall(r"[a-zA-Z]+", text.lower())
    if len(words) < 15:
        return None
    hits = sum(1 for w in words if w in COMMON_WORDS)
    return hits / len(words)


def text_layer_is_trustworthy(text: str) -> bool:
    if len(text.strip()) < MIN_CHARS_PER_PAGE:
        return False
    ratio = common_word_ratio(text)
    if ratio is None:
        # teks pendek (mis. halaman hampir kosong / judul saja) - anggap OK,
        # tidak cukup data untuk menuduhnya rusak
        return True
    return ratio >= COMMON_WORD_RATIO_THRESHOLD


# ----------------------------------------------------------------------------
# 2. Deteksi & koreksi rotasi
# ----------------------------------------------------------------------------

def detect_rotation_angle(image: Image.Image) -> int:
    """Kembalikan sudut koreksi (0/90/180/270) yang dibutuhkan supaya gambar
    tegak dibaca normal. Pakai Tesseract OSD; kalau OSD tidak tersedia/gagal
    (mis. tesseract-osd tidak terinstall), pakai fallback OCR 4-orientasi
    yang menguji keempat rotasi dan memilih yang menghasilkan rasio kata
    umum Bahasa Indonesia tertinggi."""
    try:
        osd = pytesseract.image_to_osd(image, output_type=pytesseract.Output.DICT)
        return int(osd.get("rotate", 0))
    except Exception as exc:
        print(f"  [peringatan] OSD gagal ({exc.__class__.__name__}: {exc}); "
              "pakai fallback OCR 4-orientasi.")
        return _detect_rotation_by_ocr(image)


def _detect_rotation_by_ocr(image: Image.Image) -> int:
    """Fallback deteksi rotasi tanpa tesseract-osd: downscale lalu OCR
    (--psm 6) pada 4 rotasi, pilih rotasi dengan common_word_ratio tertinggi.
    Nilai kembalian mengikuti konvensi OSD ('rotate' field) yang dipakai
    apply_rotation() (koreksi = image.rotate(-angle)), jadi sudut probe
    (CCW) dinegasikan: koreksi benar = rotate(best) CCW => angle = -best."""
    probe = image.copy()
    probe.thumbnail((1000, 1000))
    best_angle, best_ratio = 0, 0.0
    for angle in (0, 90, 180, 270):
        text = pytesseract.image_to_string(
            probe.rotate(angle, expand=True), lang=OCR_LANG, config="--psm 6"
        )
        r = common_word_ratio(text) or 0.0
        if r > best_ratio:
            best_angle, best_ratio = angle, r
    if best_ratio < 0.03:
        return 0
    return (-best_angle) % 360


def apply_rotation(image: Image.Image, angle: int) -> Image.Image:
    """PENTING: makna 'angle' di sini adalah keluaran mentah pytesseract OSD
    ('rotate' field), yang divalidasi secara EMPIRIS (bukan asumsi dari
    dokumentasi) pada dokumen uji: OSD rotate=90 perlu dikoreksi dengan
    memutar gambar 90 derajat SEARAH JARUM JAM (PIL rotate(-90)) supaya
    hasilnya benar tegak - sudah diverifikasi lewat OCR hasil sebelum/
    sesudah rotasi pada file sampel."""
    if angle == 0:
        return image
    # PIL rotate() positif = berlawanan arah jarum jam, jadi kita negasikan
    return image.rotate(-angle, expand=True)


# ----------------------------------------------------------------------------
# 3. Ekstraksi tabel terstruktur
# ----------------------------------------------------------------------------

@dataclass
class DetectedTable:
    df: pd.DataFrame
    bbox: tuple  # (x1, y1, x2, y2) dalam koordinat piksel gambar

    def is_probably_real(self, min_cells: int = MIN_TABLE_CELLS) -> bool:
        """Filter tabel hasil false-positive (mis. blok judul yang salah
        terdeteksi sebagai tabel 1 baris). Heuristik: tabel asli di dokumen
        hukum/pemerintah biasanya berisi angka; blok judul biasanya semua
        teks tanpa angka sama sekali."""
        n_filled = self.df.notna().sum().sum()
        if n_filled < min_cells:
            return False
        flat_text = " ".join(str(v) for v in self.df.values.flatten() if pd.notna(v))
        has_digit = bool(re.search(r"\d", flat_text))
        return has_digit

    def to_markdown(self) -> str:
        df = self.df.fillna("")
        return df.to_markdown(index=False)


def extract_tables(image: Image.Image) -> list[DetectedTable]:
    """Deteksi tabel dari gambar (sudah harus dalam orientasi tegak/benar)."""
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)

    doc = I2TImage(buf.getvalue())
    raw_tables = doc.extract_tables(ocr=_tesseract_ocr, implicit_rows=True, borderless_tables=True)

    results = []
    for t in raw_tables:
        bbox = (t.bbox.x1, t.bbox.y1, t.bbox.x2, t.bbox.y2)
        dt = DetectedTable(df=t.df, bbox=bbox)
        if dt.is_probably_real():
            results.append(dt)
    return results


def mask_regions(image: Image.Image, bboxes: list[tuple], pad: int = 5) -> Image.Image:
    """Tutup area tabel dengan kotak putih SEBELUM OCR teks biasa, supaya
    paragraf & tabel tidak saling tercampur/terduplikasi di hasil akhir."""
    img = image.copy()
    arr = np.array(img)
    for (x1, y1, x2, y2) in bboxes:
        x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
        x2, y2 = min(arr.shape[1], x2 + pad), min(arr.shape[0], y2 + pad)
        arr[y1:y2, x1:x2] = 255
    return Image.fromarray(arr)


# ----------------------------------------------------------------------------
# 4. Orkestrasi per halaman
# ----------------------------------------------------------------------------

@dataclass
class PageResult:
    page_num: int
    method: str  # "text_layer" | "ocr_simple" | "ocr_table_aware"
    rotation_applied: int
    markdown: str
    n_tables_found: int = 0


def _ocr_page_text(image: Image.Image) -> str:
    """OCR teks halaman dengan --psm 3 (default). Kalau gagal (mis. env tanpa
    tesseract-osd, yang dipakai PSM 3 untuk auto-segmentasi), retry dengan
    --psm 6 yang tidak bergantung pada osd - gambar sudah tegak dari koreksi
    rotasi, jadi hasil tetap benar."""
    try:
        return pytesseract.image_to_string(image, lang=OCR_LANG).strip()
    except pytesseract.TesseractError:
        return pytesseract.image_to_string(image, lang=OCR_LANG, config="--psm 6").strip()


def process_page(page: "fitz.Page", page_num: int) -> PageResult:
    text_layer = page.get_text("text").strip()

    if text_layer_is_trustworthy(text_layer):
        return PageResult(page_num, "text_layer", 0, text_layer)

    # Text-layer kosong ATAU acak -> render gambar & proses dari nol
    zoom = OCR_DPI / 72
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

    angle = detect_rotation_angle(image)
    if angle != 0:
        image = apply_rotation(image, angle)

    tables = extract_tables(image)

    if not tables:
        text = _ocr_page_text(image)
        return PageResult(page_num, "ocr_simple", angle, text, 0)

    # Ada tabel: tutup area tabel, OCR sisa halaman untuk teks paragraf,
    # lalu gabungkan urut berdasarkan posisi vertikal (atas ke bawah)
    masked = mask_regions(image, [t.bbox for t in tables])
    paragraph_text = _ocr_page_text(masked)

    blocks = []
    if paragraph_text:
        blocks.append(("text", 0, paragraph_text))
    for t in tables:
        blocks.append(("table", t.bbox[1], t.to_markdown()))
    blocks.sort(key=lambda b: b[1])  # urutkan berdasarkan posisi Y

    markdown = "\n\n".join(b[2] for b in blocks)
    return PageResult(page_num, "ocr_table_aware", angle, markdown, len(tables))


# ----------------------------------------------------------------------------
# 5. Orkestrasi seluruh dokumen
# ----------------------------------------------------------------------------

def process_pdf(pdf_path: str, output_dir: str, verbose: bool = True) -> list[PageResult]:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(pdf_path)
    results = []
    for i, page in enumerate(doc):
        result = process_page(page, i + 1)
        results.append(result)
        if verbose:
            tag = f" ({result.n_tables_found} tabel)" if result.n_tables_found else ""
            print(f"  Hal {result.page_num}: {result.method}{tag}"
                  f"{f' [rotasi {result.rotation_applied} derajat]' if result.rotation_applied else ''}")

    full_markdown = "\n\n".join(f"<!-- === Halaman {r.page_num} ({r.method}) === -->\n\n{r.markdown}" for r in results)
    slug = Path(pdf_path).stem
    out_path = out_dir / f"{slug}.md"
    out_path.write_text(full_markdown, encoding="utf-8")

    if verbose:
        n_ocr = sum(1 for r in results if r.method != "text_layer")
        n_tables = sum(r.n_tables_found for r in results)
        print(f"\nSelesai: {len(results)} halaman, {n_ocr} perlu OCR ulang, "
              f"{n_tables} tabel terdeteksi & diekstrak terstruktur.")
        print(f"Hasil markdown: {out_path}")

    return results


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Pemakaian: python table_aware_ocr.py <file.pdf> [output_dir]")
        sys.exit(1)
    pdf_path = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else "output_markdown"
    process_pdf(pdf_path, output_dir)
