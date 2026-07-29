import base64
import io
import logging
import os
from typing import List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("sidecar")

app = FastAPI(title="PP-StructureV3 Sidecar", version="1.0.0")

engine = None


class AnalyzeRequest(BaseModel):
    images: List[str]
    lang: str = "id"


class TableData(BaseModel):
    html: str
    confidence: float = 0.0


class PageResult(BaseModel):
    page: int
    text: str
    tables: List[TableData] = []


class AnalyzeResponse(BaseModel):
    pages: List[PageResult]


@app.on_event("startup")
async def startup():
    global engine
    logger.info("Menginisialisasi PP-StructureV3...")
    try:
        from paddleocr import PPStructure

        engine = PPStructure(
            show_log=False,
            lang=os.getenv("OCR_LANG", "id"),
            use_gpu=os.getenv("USE_GPU", "0") == "1",
        )
        logger.info("PP-StructureV3 siap digunakan")
    except Exception as e:
        logger.error(f"Gagal inisialisasi PP-StructureV3: {e}")
        raise


@app.get("/health")
async def health():
    return {"status": "ok", "engine": engine is not None}


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest):
    global engine
    if engine is None:
        raise HTTPException(500, "Engine belum diinisialisasi")

    pages = []
    for i, b64 in enumerate(req.images):
        try:
            img_bytes = base64.b64decode(b64)
            img = Image.open(io.BytesIO(img_bytes))
            img_array = np.array(img.convert("RGB"))
            logger.info(f"  Menganalisis halaman {i + 1}/{len(req.images)}...")

            result = engine(img_array)

            page_text_parts = []
            tables = []
            for item in result:
                item_type = item.get("type", "")
                res = item.get("res", {})

                if item_type == "table":
                    html = res.get("html", "")
                    if html:
                        tables.append(TableData(
                            html=html,
                            confidence=item.get("confidence", 0.0),
                        ))
                elif item_type == "text":
                    text = res.get("text", "")
                    if text:
                        page_text_parts.append(text)

            text = "\n".join(page_text_parts)
            pages.append(PageResult(
                page=i + 1,
                text=text,
                tables=tables,
            ))

        except Exception as e:
            logger.error(f"  Gagal memproses halaman {i + 1}: {e}")
            pages.append(PageResult(
                page=i + 1,
                text="",
                tables=[],
            ))

    return AnalyzeResponse(pages=pages)


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "5000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
