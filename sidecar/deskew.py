import base64
import io
import logging
import os
import statistics
from typing import List, Optional

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("deskew")

app = FastAPI(title="Deskew Sidecar", version="1.0.0")


class DeskewRequest(BaseModel):
    image: str
    max_angle: float = 30.0


class DeskewResponse(BaseModel):
    angle: float
    confidence: float
    rotated: str


class DetectSkewResponse(BaseModel):
    angle: float
    confidence: float


class CorrectPerspectiveRequest(BaseModel):
    image: str


class CorrectPerspectiveResponse(BaseModel):
    image: str
    success: bool
    message: str = ""


def _decode_image(b64: str) -> np.ndarray:
    img_bytes = base64.b64decode(b64)
    img = Image.open(io.BytesIO(img_bytes))
    return np.array(img.convert("RGB"))


def _encode_image(img: np.ndarray) -> str:
    pil_img = Image.fromarray(img)
    buf = io.BytesIO()
    pil_img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _detect_skew_hough(img: np.ndarray, max_angle: float = 30.0):
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    gray = cv2.bitwise_not(gray)
    thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]
    coords = np.column_stack(np.where(thresh > 0))
    if len(coords) < 100:
        return 0.0, 0.0

    edges = cv2.Canny(thresh, 50, 150, apertureSize=3)
    lines = cv2.HoughLines(edges, 1, np.pi / 180, int(min(thresh.shape) * 0.15))
    if lines is None:
        return 0.0, 0.0

    angles = []
    weights = []
    for rho, theta in lines[:, 0]:
        angle = np.degrees(theta) - 90
        if angle > 45:
            angle -= 90
        elif angle < -45:
            angle += 90
        if abs(angle) > max_angle:
            continue
        length_weight = abs(rho)
        angles.append(angle)
        weights.append(length_weight)

    if not angles:
        return 0.0, 0.0

    if len(angles) >= 5:
        median_angle = statistics.median(angles)
        q1 = np.percentile(angles, 25)
        q3 = np.percentile(angles, 75)
        iqr = q3 - q1
        filtered = [(a, w) for a, w in zip(angles, weights) if q1 - 1.5 * iqr <= a <= q3 + 1.5 * iqr]
        if filtered:
            angles = [a for a, w in filtered]
            weights = [w for a, w in filtered]

    if not angles:
        return 0.0, 0.0

    total_weight = sum(abs(w) + 1 for w in weights)
    weighted_angle = sum(a * (abs(w) + 1) for a, w in zip(angles, weights)) / total_weight

    angle_consistency = len([a for a in angles if abs(a - weighted_angle) < 1.0]) / max(len(angles), 1)
    confidence = min(angle_consistency * 1.5, 1.0)

    return round(weighted_angle, 2), round(confidence, 2)


def _detect_perspective(img: np.ndarray):
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    gray = cv2.bitwise_not(gray)
    thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]
    coords = np.column_stack(np.where(thresh > 0))
    if len(coords) < 100:
        return img, False, "Tidak cukup konten untuk deteksi tepi"

    edges = cv2.Canny(thresh, 30, 100)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    dilated = cv2.dilate(edges, kernel, iterations=2)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return img, False, "Tidak ada kontur terdeteksi"

    h, w = img.shape[:2]
    max_area = 0
    best_contour = None
    for c in contours:
        area = cv2.contourArea(c)
        if area > max_area and area > w * h * 0.1:
            max_area = area
            best_contour = c

    if best_contour is None:
        return img, False, "Tidak ada kontur area signifikan"

    peri = cv2.arcLength(best_contour, True)
    approx = cv2.approxPolyDP(best_contour, 0.02 * peri, True)
    if len(approx) != 4:
        return img, False, f"Kontur {len(approx)} titik, bukan 4 (halaman mungkin tidak terdeteksi)"

    pts = approx.reshape(4, 2).astype(np.float32)
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    (tl, tr, br, bl) = rect

    width_a = np.linalg.norm(br - bl)
    width_b = np.linalg.norm(tr - tl)
    max_width = max(int(width_a), int(width_b))
    height_a = np.linalg.norm(tr - br)
    height_b = np.linalg.norm(tl - bl)
    max_height = max(int(height_a), int(height_b))
    dst = np.array([
        [0, 0],
        [max_width - 1, 0],
        [max_width - 1, max_height - 1],
        [0, max_height - 1],
    ], dtype=np.float32)

    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(img, M, (max_width, max_height))
    return warped, True, "Perspektif berhasil dikoreksi"


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "opencv_version": cv2.__version__,
    }


@app.post("/detect-skew", response_model=DetectSkewResponse)
async def detect_skew(req: DeskewRequest):
    try:
        img = _decode_image(req.image)
        angle, confidence = _detect_skew_hough(img, req.max_angle)
        logger.info(f"  Skew terdeteksi: {angle}° (confidence: {confidence})")
        return DetectSkewResponse(angle=angle, confidence=confidence)
    except Exception as e:
        logger.error(f"  Gagal deteksi skew: {e}")
        raise HTTPException(500, str(e))


@app.post("/deskew", response_model=DeskewResponse)
async def deskew(req: DeskewRequest):
    try:
        img = _decode_image(req.image)
        angle, confidence = _detect_skew_hough(img, req.max_angle)
        if abs(angle) < 0.1 or confidence < 0.05:
            return DeskewResponse(
                angle=0.0,
                confidence=confidence,
                rotated=_encode_image(img),
            )
        h, w = img.shape[:2]
        center = (w // 2, h // 2)
        M = cv2.getRotationMatrix2D(center, angle, 1.0)
        cos = abs(M[0, 0])
        sin = abs(M[0, 1])
        new_w = int(h * sin + w * cos)
        new_h = int(h * cos + w * sin)
        M[0, 2] += new_w / 2 - center[0]
        M[1, 2] += new_h / 2 - center[1]
        rotated = cv2.warpAffine(img, M, (new_w, new_h), borderValue=(255, 255, 255))
        logger.info(f"  Rotasi {angle}° diterapkan (confidence: {confidence})")
        return DeskewResponse(
            angle=angle,
            confidence=confidence,
            rotated=_encode_image(rotated),
        )
    except Exception as e:
        logger.error(f"  Gagal deskew: {e}")
        raise HTTPException(500, str(e))


@app.post("/correct-perspective", response_model=CorrectPerspectiveResponse)
async def correct_perspective(req: CorrectPerspectiveRequest):
    try:
        img = _decode_image(req.image)
        corrected, success, message = _detect_perspective(img)
        return CorrectPerspectiveResponse(
            image=_encode_image(corrected),
            success=success,
            message=message,
        )
    except Exception as e:
        logger.error(f"  Gagal koreksi perspektif: {e}")
        raise HTTPException(500, str(e))


@app.post("/deskew-full", response_model=DeskewResponse)
async def deskew_full(req: DeskewRequest):
    try:
        img = _decode_image(req.image)
        corrected, success, message = _detect_perspective(img)
        if success:
            logger.info(f"  {message}")
            img = corrected
        angle, confidence = _detect_skew_hough(img, req.max_angle)
        if abs(angle) < 0.1 or confidence < 0.05:
            return DeskewResponse(
                angle=0.0,
                confidence=confidence,
                rotated=_encode_image(img),
            )
        h, w = img.shape[:2]
        center = (w // 2, h // 2)
        M = cv2.getRotationMatrix2D(center, angle, 1.0)
        cos = abs(M[0, 0])
        sin = abs(M[0, 1])
        new_w = int(h * sin + w * cos)
        new_h = int(h * cos + w * sin)
        M[0, 2] += new_w / 2 - center[0]
        M[1, 2] += new_h / 2 - center[1]
        rotated = cv2.warpAffine(img, M, (new_w, new_h), borderValue=(255, 255, 255))
        logger.info(f"  Full deskew: perspektif + rotasi {angle}° (confidence: {confidence})")
        return DeskewResponse(
            angle=angle,
            confidence=confidence,
            rotated=_encode_image(rotated),
        )
    except Exception as e:
        logger.error(f"  Gagal deskew-full: {e}")
        raise HTTPException(500, str(e))


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("DESKEW_PORT", "5002"))
    uvicorn.run(app, host="0.0.0.0", port=port)
