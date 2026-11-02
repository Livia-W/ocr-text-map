"""Small adapter around the bundled Chinese/English PP-OCR ONNX models."""

from dataclasses import dataclass

import numpy as np


class OCRRuntimeError(RuntimeError):
    """A missing dependency, model, or inference failure."""


@dataclass
class Detection:
    polygon: np.ndarray
    text: str
    confidence: float


class ChineseOCR:
    def __init__(self):
        self._engine = None

    @property
    def ready(self) -> bool:
        return self._engine is not None

    def recognize(self, image: np.ndarray, min_confidence: float) -> list[Detection]:
        try:
            if self._engine is None:
                from rapidocr_onnxruntime import RapidOCR

                self._engine = RapidOCR(
                    intra_op_num_threads=2,
                    inter_op_num_threads=1,
                    det_limit_type="max",
                    det_limit_side_len=1280,
                )
            # Set the engine threshold on every call; otherwise its default 0.5
            # would silently discard results requested at a lower threshold.
            result, _ = self._engine(image, text_score=min_confidence)
        except Exception as exc:
            raise OCRRuntimeError(
                "中文 OCR 初始化或推理失败，请检查 Python 3.10–3.12 环境、依赖和模型文件。"
            ) from exc
        detections = []
        for polygon, text, score, *_ in result or []:
            polygon = np.asarray(polygon, dtype=np.float64)
            if (
                polygon.shape == (4, 2)
                and np.isfinite(polygon).all()
                and str(text).strip()
                and np.isfinite(score)
                and float(score) >= min_confidence
            ):
                detections.append(Detection(polygon, str(text).strip(), float(score)))
        return detections
