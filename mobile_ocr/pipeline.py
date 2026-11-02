"""Module B: photos to calibrated regions, OCR and source-coordinate text maps."""

import base64
from io import BytesIO
import math
from threading import Lock
from time import perf_counter
from uuid import uuid4
import warnings

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .engine import ChineseOCR, OCRRuntimeError
from .calibration import calibrate_photo
from .geometry import rectify_page
from .layout import analyze_layout, bounding_box

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000


class BusyError(RuntimeError):
    pass


def decode_image(encoded: bytes) -> np.ndarray:
    if not encoded:
        raise ValueError("没有收到图片。")
    if len(encoded) > MAX_IMAGE_BYTES:
        raise ValueError("图片文件超过 8 MiB，请压缩后重试。")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(encoded)) as im:
                if im.format not in {"JPEG", "PNG", "WEBP"}:
                    raise ValueError("仅支持 JPEG、PNG、WebP 图片。")
                if im.width * im.height > MAX_IMAGE_PIXELS:
                    raise ValueError("图片超过 2000 万像素，请缩小后重试。")
                if min(im.size) < 32:
                    raise ValueError("图片过小，宽和高至少需要 32 像素。")
                if getattr(im, "is_animated", False):
                    raise ValueError("请上传单张静态图片。")
                # Source coordinates refer to the EXIF-oriented photo, before
                # the explicit user rotation or left/right region separation.
                im = ImageOps.exif_transpose(im).convert("RGB")
                return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("无法解码图片，文件可能损坏或尺寸过大。") from exc


def sample_polygon(polygon, samples_per_edge=9):
    p = np.asarray(polygon, dtype=float)
    return np.concatenate([
        p[i] + np.linspace(0, 1, samples_per_edge, endpoint=False)[:, None] * (p[(i + 1) % len(p)] - p[i])
        for i in range(len(p))
    ])


class OCRPipeline:
    def __init__(self, engine=None):
        self.engine = engine if engine is not None else ChineseOCR()
        self._lock = Lock()

    @property
    def ready(self):
        return self.engine.ready

    @staticmethod
    def _validate_options(mode, min_confidence, max_side):
        if mode not in {"none", "perspective", "auto"}:
            raise ValueError("校正模式必须为 none、perspective 或 auto。")
        if not math.isfinite(min_confidence) or not 0 <= min_confidence <= 1:
            raise ValueError("置信度必须在 0 到 1 之间。")
        if not isinstance(max_side, int) or not 640 <= max_side <= 2560:
            raise ValueError("每区处理分辨率 max_side 必须为 640 到 2560 之间的整数。")

    def process(self, encoded: bytes, *, mode="auto", min_confidence=0.45,
                max_side=1920, rotation=0, split="none", split_position=0.5):
        """Recognize encoded JPEG/PNG/WebP supplied by module A or a file."""
        self._validate_options(mode, min_confidence, max_side)
        if not self._lock.acquire(blocking=False):
            raise BusyError("正在处理另一张照片，请稍后重试。")
        try:
            start = perf_counter()
            source = decode_image(encoded)
            return self._process_source(source, mode, min_confidence, max_side,
                                        rotation, split, split_position, start, perf_counter())
        finally:
            self._lock.release()

    def process_image(self, image: np.ndarray, *, mode="auto", min_confidence=0.45,
                      max_side=1920, rotation=0, split="none", split_position=0.5):
        """Recognize an already oriented uint8 BGR image supplied by module A.

        The source coordinate system is exactly this array. Make a private
        snapshot so a camera producer cannot mutate it during inference.
        """
        self._validate_options(mode, min_confidence, max_side)
        if (not isinstance(image, np.ndarray) or image.ndim != 3
                or image.shape[2] != 3 or image.dtype != np.uint8):
            raise ValueError("输入必须是 uint8 BGR 三通道照片。")
        if min(image.shape[:2]) < 32 or image.shape[0] * image.shape[1] > MAX_IMAGE_PIXELS:
            raise ValueError("照片宽高至少为 32 像素，总像素不超过 2000 万。")
        if not self._lock.acquire(blocking=False):
            raise BusyError("正在处理另一张照片，请稍后重试。")
        try:
            start = perf_counter()
            source = image.copy()
            return self._process_source(source, mode, min_confidence, max_side,
                                        rotation, split, split_position, start, perf_counter())
        finally:
            self._lock.release()

    def _process_source(self, source, mode, min_confidence, max_side,
                        rotation, split, split_position, start, decoded_at):
        calibration_at = perf_counter()
        photo_regions = calibrate_photo(source, rotation=rotation, split=split,
                                        split_position=split_position)
        geometry_seconds = perf_counter() - calibration_at
        ocr_seconds = 0.0
        lines, blocks, regions, notes = [], [], [], []
        for photo_region in photo_regions:
            geometry_at = perf_counter()
            page = rectify_page(photo_region.image, mode=mode, max_side=max_side)
            geometry_seconds += perf_counter() - geometry_at
            ocr_at = perf_counter()
            detections = self.engine.recognize(page.image, min_confidence)
            ocr_seconds += perf_counter() - ocr_at
            ordered, local_blocks = analyze_layout(detections, page.image.shape[1])
            line_offset = len(lines)
            block_offset = len(blocks)
            block_ids = {block["id"]: f"block-{block_offset + i + 1}"
                         for i, block in enumerate(local_blocks)}
            for block in local_blocks:
                blocks.append({
                    **block,
                    "id": block_ids[block["id"]],
                    "region_id": photo_region.id,
                    "line_ids": [f"line-{line_offset + int(line_id.split('-')[-1])}"
                                 for line_id in block["line_ids"]],
                })
            region_line_ids = []
            for detection, block_id in ordered:
                # Map a curved boundary through dewarp, perspective, crop and
                # user rotation, back to the original EXIF-oriented photo.
                source_polygon = photo_region.to_source(
                    page.to_source(sample_polygon(detection.polygon)))
                index = len(lines) + 1
                line_id = f"line-{index}"
                region_line_ids.append(line_id)
                lines.append({
                    "id": line_id, "reading_order": index,
                    "region_id": photo_region.id, "block_id": block_ids[block_id],
                    "text": detection.text, "confidence": round(detection.confidence, 4),
                    "polygon_source": np.round(source_polygon, 3).tolist(),
                    "polygon_rectified": np.round(detection.polygon, 3).tolist(),
                    "bbox_source": np.round(bounding_box(source_polygon), 3).tolist(),
                    "bbox_rectified": np.round(bounding_box(detection.polygon), 3).tolist(),
                })
            region_notes = list(page.warnings)
            if any(bounding_box(d.polygon)[3] > bounding_box(d.polygon)[2] * 1.5 for d, _ in ordered):
                region_notes.append("检测到竖向文字；当前阅读顺序算法以横排文档为主。")
            if not ordered:
                region_notes.append("未检测到可靠文字，请使用清晰照片或调整分割线。")
            notes.extend(f"{photo_region.label}：{note}" for note in region_notes)
            ok, buffer = cv2.imencode(".jpg", page.image, [cv2.IMWRITE_JPEG_QUALITY, 90])
            if not ok:
                raise OCRRuntimeError("无法编码校正后的页面。")
            transform = page.as_dict()
            # Export matrices in the same original-photo coordinate space as
            # polygon_source. Curvature is still handled by curvature_mesh.
            source_to_page = page.perspective_matrix @ photo_region.source_to_region_matrix
            transform.update({
                "source_size": [source.shape[1], source.shape[0]],
                "region_source_size": list(photo_region.region_size),
                "source_to_page_matrix": source_to_page.tolist(),
                "page_to_source_matrix": np.linalg.inv(source_to_page).tolist(),
                "warnings": region_notes,
            })
            region_w, region_h = photo_region.region_size
            region_corners = np.array([[0, 0], [region_w - 1, 0],
                                       [region_w - 1, region_h - 1], [0, region_h - 1]], float)
            regions.append({
                "id": photo_region.id, "label": photo_region.label, "kind": photo_region.kind,
                "line_ids": region_line_ids,
                "polygon_source": np.round(photo_region.to_source(region_corners), 3).tolist(),
                "rectified_size": [page.image.shape[1], page.image.shape[0]],
                "rectified_image": "data:image/jpeg;base64," + base64.b64encode(buffer).decode("ascii"),
                "calibration": photo_region.as_dict(), "transform": transform,
                "warnings": region_notes,
            })
        if not lines:
            notes.append("照片中未检测到可靠文字，请检查方向、分区和清晰度。")
        first = regions[0]
        return {
            "schema_version": "2.0",
            "document_id": uuid4().hex,
            "engine": "rapidocr-onnxruntime-1.4.4",
            "source_size": [source.shape[1], source.shape[0]],
            "rotated_size": list(photo_regions[0].rotated_size),
            "calibration": {"rotation_clockwise": int(rotation), "split": split,
                            "split_position": float(split_position)},
            "text": "\n".join(line["text"] for line in lines),
            "lines": lines, "blocks": blocks, "regions": regions,
            # Compatibility view only: multi-region consumers must use regions.
            "rectified_size": first["rectified_size"],
            "rectified_image": first["rectified_image"],
            "transform": first["transform"],
            "coordinates": {
                "unit": "pixel", "origin": "top-left", "x_axis": "right", "y_axis": "down",
                "bbox_format": "x,y,width,height", "source_orientation": "EXIF-transposed",
                "scope": "single-photo", "text_location_level": "line",
                "rectified_space": "region-local",
            },
            "layout_method": "whitespace-xy-cut-heuristic",
            "warnings": notes,
            "timing_ms": {
                "decode": round((decoded_at - start) * 1000, 1),
                "geometry": round(geometry_seconds * 1000, 1),
                "ocr": round(ocr_seconds * 1000, 1),
                "total": round((perf_counter() - start) * 1000, 1),
            },
        }
