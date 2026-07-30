import base64
import io
import logging
import os
from typing import Dict, List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("surya-sidecar")

app = FastAPI(title="Surya OCR Sidecar", version="1.0.0")

ocr_model = None
det_model = None


class AnalyzeRequest(BaseModel):
    images: List[str]
    lang: str = "id"
    options: Optional[Dict] = None


class TextBlock(BaseModel):
    text: str
    confidence: float = 0.0
    bbox: Optional[List[float]] = None


class PageResult(BaseModel):
    page: int
    text: str
    blocks: List[TextBlock] = []


class AnalyzeResponse(BaseModel):
    pages: List[PageResult]
    engine: str = "surya"


@app.on_event("startup")
async def startup():
    global ocr_model, det_model
    logger.info("Menginisialisasi Surya OCR...")
    try:
        from surya.recognition import RecognitionPredictor
        from surya.detection import DetectionPredictor

        det_model = DetectionPredictor()
        ocr_model = RecognitionPredictor()
        logger.info("Surya OCR siap digunakan")
    except Exception as e:
        logger.error(f"Gagal inisialisasi Surya OCR: {e}")
        raise


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "engine": "surya",
        "ocr_ready": ocr_model is not None,
        "det_ready": det_model is not None,
    }


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest):
    global ocr_model, det_model
    if ocr_model is None or det_model is None:
        raise HTTPException(500, "Engine belum diinisialisasi")

    pages = []
    for i, b64 in enumerate(req.images):
        try:
            img_bytes = base64.b64decode(b64)
            img = Image.open(io.BytesIO(img_bytes))
            img_array = np.array(img.convert("RGB"))

            logger.info(f"  Mendeteksi teks halaman {i + 1}/{len(req.images)}...")
            detections = det_model([img_array])

            logger.info(f"  Mengenali teks halaman {i + 1}/{len(req.images)}...")
            rec_results = ocr_model(img_array, detections)

            blocks = []
            text_parts = []

            surya_lang_map = {"id": "id", "en": "en"}
            lang = surya_lang_map.get(req.lang, "id")

            if rec_results and rec_results.text_lines:
                for line in rec_results.text_lines:
                    block = TextBlock(
                        text=line.text,
                        confidence=getattr(line, "confidence", 0.0),
                        bbox=getattr(line, "bbox", None),
                    )
                    blocks.append(block)
                    text_parts.append(line.text)

            text = "\n".join(text_parts)

            pages.append(PageResult(
                page=i + 1,
                text=text,
                blocks=blocks,
            ))

        except Exception as e:
            logger.error(f"  Gagal memproses halaman {i + 1}: {e}")
            pages.append(PageResult(page=i + 1, text="", blocks=[]))

    return AnalyzeResponse(pages=pages)


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "5001"))
    uvicorn.run(app, host="0.0.0.0", port=port)
