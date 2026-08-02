"""
table_ocr/main.py
=================
Sidecar FastAPI untuk OCR tabel terstruktur (hybrid img2table + PaddleX).

Strategi (hasil komparasi empiris, 2026-08-02):
  - img2table  : cepat (~2 dtk/halaman), menang tabel borderless, lemah pada
                 struktur grid wired + colspan (header baris terduplikasi).
  - PaddleX     : struktur grid wired + colspan akurat, GAGAL mendeteksi
                 tabel borderless, sangat lambat (~13 mnt/halaman CPU) dan
                 butuh paddle 3.3.1 + PIR + mkldnn OFF (lihat CHANGELOG v22).

Node.js menentukan engine per halaman lewat gate piksel murah
(`detectWiredGridRegions`, run-length + Otsu, ~140 ms/halaman):
  - halaman LOLOS gate (ada grid wired) -> engine "paddlex"
  - halaman lain (borderless / paragraf)  -> engine "img2table"

PaddleX dimuat lazy (singleton) agar startup sidecar tetap cepat dan
img2table tidak pernah terblokir oleh inisialisasi PaddleX.
"""

import base64
import io
import logging
import os
import tempfile
from typing import List, Optional

os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "modelscope")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "False")
os.environ.setdefault("FLAGS_use_mkldnn", "0")

import pandas as pd
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel

# img2table butuh tesseract binary; OCR_LANG default mengikuti env/docker-compose
OCR_LANG = os.environ.get("TABLE_OCR_LANG", "ind+eng")
MIN_TABLE_CELLS = int(os.environ.get("TABLE_MIN_CELLS", "4"))
MAX_PAGES = int(os.environ.get("TABLE_MAX_PAGES", "50"))

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("table-ocr")

app = FastAPI(title="Table OCR Sidecar (hybrid)", version="1.0.0")

_tesseract_ocr = None
_paddlex_pipe = None


def _get_tesseract_ocr():
    global _tesseract_ocr
    if _tesseract_ocr is None:
        from img2table.ocr import TesseractOCR

        _tesseract_ocr = TesseractOCR(lang=OCR_LANG)
    return _tesseract_ocr


def _get_paddlex_pipe():
    global _paddlex_pipe
    if _paddlex_pipe is None:
        logger.info("Memuat pipeline PaddleX table_recognition (sekali saja)...")
        from paddlex import create_pipeline

        _paddlex_pipe = create_pipeline("table_recognition")
        logger.info("Pipeline PaddleX siap.")
    return _paddlex_pipe


# ---------------------------------------------------------------------------
# Model request/response
# ---------------------------------------------------------------------------


class PageRequest(BaseModel):
    image: str  # base64 PNG
    engine: str = "img2table"  # "img2table" | "paddlex"


class AnalyzeRequest(BaseModel):
    pages: List[PageRequest]


class TableResult(BaseModel):
    html: str
    bbox: Optional[List[int]] = None  # [x1, y1, x2, y2] piksel gambar


class PageResult(BaseModel):
    page: int
    engine: str
    tables: List[TableResult]
    note: str = ""


class AnalyzeResponse(BaseModel):
    results: List[PageResult]


class HealthResponse(BaseModel):
    status: str
    paddlex_loaded: bool
    engines: List[str] = ["img2table", "paddlex"]
    tesseract: Optional[str] = None
    tessdata: Optional[str] = None
    path_head: Optional[str] = None


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _decode_image(b64: str) -> Image.Image:
    img_bytes = base64.b64decode(b64)
    return Image.open(io.BytesIO(img_bytes)).convert("RGB")


_COMMON_WORDS = {
    "yang", "dan", "dalam", "pada", "dengan", "tahun", "ayat", "pasal",
    "tentang", "atau", "untuk", "dari", "ini", "di", "ke", "adalah",
    "sebagaimana", "dimaksud", "peraturan", "daerah", "pemerintah",
}


def _common_word_ratio(text: str) -> float:
    import re

    words = re.findall(r"[a-zA-Z]+", text.lower())
    if len(words) < 15:
        return 0.0
    return sum(1 for w in words if w in _COMMON_WORDS) / len(words)


def _detect_rotation(image: Image.Image) -> int:
    """Deteksi rotasi 0/90/180/270 via Tesseract OSD. Kalau OSD gagal
    (mis. tesseract-osd tidak terinstall), fallback OCR 4-orientasi dengan
    memilih rotasi yang menghasilkan rasio kata umum tertinggi. Nilai
    kembalian mengikuti konvensi OSD ('rotate' field) - koreksi diterapkan
    via image.rotate(-angle), jadi sudut probe (CCW) dinegasikan."""
    try:
        import pytesseract

        osd = pytesseract.image_to_osd(image, output_type=pytesseract.Output.DICT)
        return int(osd.get("rotate", 0))
    except Exception as exc:
        logger.warning("OSD gagal (%s: %s); pakai fallback OCR 4-orientasi.", type(exc).__name__, exc)
        try:
            import pytesseract

            probe = image.copy()
            probe.thumbnail((1000, 1000))
            best_angle, best_ratio = 0, 0.0
            for angle in (0, 90, 180, 270):
                text = pytesseract.image_to_string(
                    probe.rotate(angle, expand=True),
                    lang=OCR_LANG,
                    config="--psm 6",
                )
                r = _common_word_ratio(text)
                if r > best_ratio:
                    best_angle, best_ratio = angle, r
            if best_ratio < 0.03:
                return 0
            return (-best_angle) % 360
        except Exception:
            return 0


def _ensure_rotation(image: Image.Image):
    """Koreksi rotasi halaman SEBELUM ekstraksi tabel. Bbox yang dihasilkan
    engine berada dalam koordinat gambar TER-ROTASI, jadi Node (yang memakai
    gambar asli) perlu bbox di-transform balik via _map_bbox_back."""
    angle = _detect_rotation(image)
    if angle == 0:
        return image, 0
    logger.info("Halaman miring %d derajat -> dikoreksi.", angle)
    return image.rotate(-angle, expand=True), angle


def _map_bbox_back(bbox, angle: int, orig_w: int, orig_h: int) -> List[int]:
    """Transform [x1,y1,x2,y2] dari koordinat gambar ter-rotasi (PIL
    rotate(-angle)) kembali ke koordinat gambar asli."""
    if angle == 0:
        return bbox
    x1, y1, x2, y2 = bbox
    mapped = []
    for x, y in [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]:
        if angle == 90:
            mapped.append((y, orig_h - 1 - x))
        elif angle == 180:
            mapped.append((orig_w - 1 - x, orig_h - 1 - y))
        elif angle == 270:
            mapped.append((orig_w - 1 - y, x))
        else:
            mapped.append((x, y))
    xs = [p[0] for p in mapped]
    ys = [p[1] for p in mapped]
    return [min(xs), min(ys), max(xs), max(ys)]


def _df_to_html(df: pd.DataFrame) -> str:
    """DataFrame -> HTML tabel (border=0, colspan tidak tersedia dari img2table,
    tapi sel kosong dipertahankan sebagai <td> kosong). Python None dan NaN
    diubah menjadi string kosong dahulu - na_rep dari to_html hanya mengganti
    NaN, sehingga sel None (hasil OCR gagal di img2table) tetap tampil literal
    "None" jika tidak dibersihkan di sini."""
    cleaned = df.applymap(
        lambda v: "" if v is None or (isinstance(v, float) and pd.isna(v)) else v
    )
    return cleaned.to_html(index=False, border=0, na_rep="")


def _extract_tables_img2table(image: Image.Image) -> List[TableResult]:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)

    from img2table.document import Image as I2TImage

    doc = I2TImage(buf.getvalue())
    raw_tables = doc.extract_tables(
        ocr=_get_tesseract_ocr(),
        implicit_rows=True,
        borderless_tables=True,
    )

    results = []
    for t in raw_tables:
        n_filled = t.df.notna().sum().sum()
        if n_filled < MIN_TABLE_CELLS:
            continue
        flat_text = " ".join(str(v) for v in t.df.values.flatten() if pd.notna(v))
        if not any(ch.isdigit() for ch in flat_text):
            continue
        results.append(
            TableResult(
                html=_df_to_html(t.df),
                bbox=[t.bbox.x1, t.bbox.y1, t.bbox.x2, t.bbox.y2],
            )
        )
    return results


def _extract_tables_paddlex(image: Image.Image) -> List[TableResult]:
    pipe = _get_paddlex_pipe()

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        image.save(tmp_path, format="PNG")
        result = pipe.predict(tmp_path)
        tables = []
        layout_boxes = []
        htmls = []
        for res in result:
            r = res.json.get("res", {})
            layout_boxes = [
                b.get("coordinate")
                for b in (r.get("layout_det_res") or {}).get("boxes", [])
                if b.get("label") == "table"
            ]
            for t in r.get("table_res_list", []) or []:
                htmls.append(t.get("pred_html", ""))
        for i, coord in enumerate(layout_boxes):
            html = htmls[i] if i < len(htmls) else ""
            if not html:
                continue
            tables.append(TableResult(html=html, bbox=[int(v) for v in coord]))
        return tables
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
def health():
    import shutil

    return HealthResponse(
        status="ok",
        paddlex_loaded=_paddlex_pipe is not None,
        tesseract=shutil.which("tesseract"),
        tessdata=os.environ.get("TESSDATA_PREFIX"),
        path_head=os.environ.get("PATH", "")[:200],
    )


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest):
    if not req.pages:
        raise HTTPException(status_code=400, detail="pages kosong")
    if len(req.pages) > MAX_PAGES:
        raise HTTPException(status_code=400, detail=f"maks {MAX_PAGES} halaman per request")

    results = []
    for i, page_req in enumerate(req.pages):
        engine = page_req.engine if page_req.engine in ("img2table", "paddlex") else "img2table"
        try:
            image = _decode_image(page_req.image)
            orig_w, orig_h = image.size
            image, applied_angle = _ensure_rotation(image)
            if engine == "paddlex":
                tables = _extract_tables_paddlex(image)
            else:
                tables = _extract_tables_img2table(image)
            if applied_angle:
                for t in tables:
                    if t.bbox:
                        t.bbox = _map_bbox_back(t.bbox, applied_angle, orig_w, orig_h)
            results.append(PageResult(page=i + 1, engine=engine, tables=tables))
        except Exception as exc:  # per-halaman error tidak membatalkan batch
            logger.warning("Halaman %d gagal (%s): %s", i + 1, engine, exc)
            results.append(
                PageResult(page=i + 1, engine=engine, tables=[], note=f"error: {exc}")
            )

    return AnalyzeResponse(results=results)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("TABLE_OCR_PORT", "5003"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
