"""Page rectification and reversible pixel-coordinate transforms.

Curvature correction is a conservative, text-baseline model for horizontal
printed pages. It does not reconstruct a 3-D surface or infer hidden text.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np


def _project(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    shape = np.asarray(points).shape
    values = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    homogeneous = np.column_stack((values, np.ones(len(values)))) @ matrix.T
    denominator = homogeneous[:, 2:3]
    if np.any(np.abs(denominator) < 1e-10):
        raise ValueError("坐标位于透视变换的无穷远处")
    return (homogeneous[:, :2] / denominator).reshape(shape)


@dataclass
class RectifiedPage:
    """All mappings use pixels; source coordinates refer to the uploaded frame."""

    image: np.ndarray
    source_size: tuple[int, int]
    perspective_matrix: np.ndarray
    perspective_applied: bool = False
    warnings: list[str] = field(default_factory=list)
    curvature_x: np.ndarray | None = None
    curvature_target_y: np.ndarray | None = None
    curvature_source_y: np.ndarray | None = None

    @property
    def curvature_applied(self) -> bool:
        return self.curvature_x is not None

    @property
    def rectified_size(self) -> tuple[int, int]:
        return self.image.shape[1], self.image.shape[0]

    def _curve_y(self, x: np.ndarray, y: np.ndarray, inverse: bool) -> np.ndarray:
        if not self.curvature_applied:
            return y.copy()
        # Each column of the control mesh is monotonic. Interpolating its
        # inverse therefore preserves the same coordinate model both ways.
        curves = np.vstack([
            np.interp(x, self.curvature_x, row)
            for row in self.curvature_source_y
        ])
        targets = self.curvature_target_y
        if inverse:
            intervals = np.searchsorted(targets, y, side="right") - 1
            intervals = np.clip(intervals, 0, len(targets) - 2)
            fractions = (y - targets[intervals]) / (targets[intervals + 1] - targets[intervals])
            columns = np.arange(len(x))
            return curves[intervals, columns] * (1 - fractions) + curves[intervals + 1, columns] * fractions
        intervals = (curves <= y[None, :]).sum(axis=0) - 1
        intervals = np.clip(intervals, 0, len(targets) - 2)
        columns = np.arange(len(x))
        low = curves[intervals, columns]
        high = curves[intervals + 1, columns]
        fractions = (y - low) / (high - low)
        return targets[intervals] * (1 - fractions) + targets[intervals + 1] * fractions

    def to_source(self, points: np.ndarray) -> np.ndarray:
        values = np.asarray(points, dtype=np.float64)
        shape = values.shape
        values = values.reshape(-1, 2).copy()
        values[:, 1] = self._curve_y(values[:, 0], values[:, 1], inverse=True)
        return _project(values, np.linalg.inv(self.perspective_matrix)).reshape(shape)

    def to_rectified(self, points: np.ndarray) -> np.ndarray:
        values = np.asarray(points, dtype=np.float64)
        shape = values.shape
        values = _project(values, self.perspective_matrix).reshape(-1, 2)
        values[:, 1] = self._curve_y(values[:, 0], values[:, 1], inverse=False)
        return values.reshape(shape)

    def as_dict(self) -> dict:
        mesh = None
        if self.curvature_applied:
            mesh = {
                "x": self.curvature_x.tolist(),
                "target_y": self.curvature_target_y.tolist(),
                "source_y": self.curvature_source_y.tolist(),
                "description": "校正坐标 (x, target_y) 到透视平面 (x, source_y) 的分段线性逆映射",
            }
        return {
            "source_size": list(self.source_size),
            "rectified_size": list(self.rectified_size),
            "perspective_applied": self.perspective_applied,
            "curvature_applied": self.curvature_applied,
            "source_to_page_matrix": self.perspective_matrix.tolist(),
            "page_to_source_matrix": np.linalg.inv(self.perspective_matrix).tolist(),
            "curvature_mesh": mesh,
            "coordinate_unit": "pixel",
            "warnings": self.warnings,
        }


def _ordered_quad(points: np.ndarray) -> np.ndarray:
    points = np.asarray(points, dtype=np.float32).reshape(4, 2)
    center = points.mean(axis=0)
    angles = np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0])
    points = points[np.argsort(angles)]
    start = int(np.argmin(points.sum(axis=1)))
    return np.roll(points, -start, axis=0)


def _find_page(gray: np.ndarray) -> np.ndarray | None:
    height, width = gray.shape
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    _, light_regions = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    candidates = []
    for mask in (edges, light_regions):
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        candidates.extend(contours)
    for contour in sorted(candidates, key=cv2.contourArea, reverse=True)[:12]:
        area = cv2.contourArea(contour)
        if not 0.3 * width * height <= area <= 0.985 * width * height:
            continue
        perimeter = cv2.arcLength(contour, True)
        quad = cv2.approxPolyDP(contour, 0.025 * perimeter, True)
        if len(quad) != 4 or not cv2.isContourConvex(quad):
            continue
        quad = _ordered_quad(quad)
        side_lengths = np.linalg.norm(quad - np.roll(quad, 1, axis=0), axis=1)
        if side_lengths.min() < min(width, height) * 0.2:
            continue
        if area / max(cv2.contourArea(quad), 1.0) < 0.85:
            continue
        inside = np.zeros_like(gray)
        cv2.fillConvexPoly(inside, quad.astype(np.int32), 255)
        # A text block's rectangular envelope must not be mistaken for paper.
        # This intentionally declines a white sheet on an indistinct white desk.
        inner = cv2.erode(inside, np.ones((9, 9), np.uint8))
        outer = cv2.bitwise_not(cv2.dilate(inside, np.ones((9, 9), np.uint8)))
        if cv2.countNonZero(inner) < 100 or cv2.countNonZero(outer) < 100:
            continue
        inner_mean = cv2.mean(gray, mask=inner)[0]
        outer_mean = cv2.mean(gray, mask=outer)[0]
        if inner_mean < 110 or inner_mean - outer_mean < 8:
            continue
        return quad
    return None


def _fit_baselines(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """Find several independently observed, similarly curved text baselines."""
    height, width = gray.shape
    if min(height, width) < 120 or np.std(gray) < 8:
        return None
    _, ink = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    count, _, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
    glyphs = [s for s in stats[1:count]
              if 5 <= s[cv2.CC_STAT_HEIGHT] <= min(100, height * 0.12)
              and 2 <= s[cv2.CC_STAT_WIDTH] <= s[cv2.CC_STAT_HEIGHT] * 3.0
              and s[cv2.CC_STAT_AREA] >= 8]
    if len(glyphs) < 24:
        return None
    text_height = float(np.median([s[cv2.CC_STAT_HEIGHT] for s in glyphs]))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT,
                                     (max(11, round(text_height * 1.65)),
                                      max(3, round(text_height * 0.18))))
    joined = cv2.dilate(ink, kernel)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(joined, 8)
    grid_x = np.linspace(0, width - 1, 33)
    fits = []
    for label in range(1, count):
        left, top, line_width, line_height, area = stats[label]
        if line_width < width * 0.6 or line_height > text_height * 5:
            continue
        if top <= 1 or top + line_height >= height - 1:
            continue
        # Work within this text band's actual ink, not the dilated envelope.
        stripe = (labels[top:top + line_height, left:left + line_width] == label)
        stripe &= ink[top:top + line_height, left:left + line_width] != 0
        sample_x, sample_y = [], []
        window = max(12, round(text_height * 1.7))
        for begin in range(0, line_width, window):
            ys, xs = np.where(stripe[:, begin:begin + window])
            if len(ys) < max(8, text_height):
                continue
            sample_x.append(float(np.median(xs + begin + left)))
            sample_y.append(float(np.quantile(ys, 0.90) + top))
        if len(sample_x) < 9:
            continue
        xs = np.asarray(sample_x)
        ys = np.asarray(sample_y)
        # Normalized coordinates avoid an ill-conditioned polynomial fit.
        normalized_x = (xs - width / 2) / width
        coefficients = np.polyfit(normalized_x, ys, 2)
        for _ in range(2):
            residuals = ys - np.polyval(coefficients, normalized_x)
            median = np.median(residuals)
            mad = np.median(np.abs(residuals - median))
            keep = np.abs(residuals - median) <= max(2.0, 3 * mad)
            if keep.sum() < max(7, len(xs) * 0.65):
                break
            coefficients = np.polyfit(normalized_x[keep], ys[keep], 2)
        residuals = ys - np.polyval(coefficients, normalized_x)
        if np.median(np.abs(residuals)) > text_height * 0.18:
            continue
        baseline = np.polyval(coefficients, (grid_x - width / 2) / width)
        if baseline.min() <= 2 or baseline.max() >= height - 3:
            continue
        if np.ptp(baseline) > min(height * 0.15, text_height * 4):
            continue
        fits.append(baseline)
    if len(fits) < 3:
        return None
    fits = np.asarray(sorted(fits, key=np.median))
    # Reject crossing or almost-touching baselines: interpolation must not fold.
    if np.min(np.diff(fits, axis=0)) < max(4, text_height * 0.4):
        return None
    chord = fits[:, :1] + (fits[:, -1:] - fits[:, :1]) * np.linspace(0, 1, len(grid_x))
    bends = fits - chord
    bend_sizes = np.max(np.abs(bends), axis=1)
    curved = bend_sizes >= max(2, text_height * 0.12)
    if curved.sum() < 3:
        return None
    signs = np.sign(bends[curved, len(grid_x) // 2])
    if abs(signs.mean()) < 0.8:
        return None
    # Dissimilar shapes often indicate a diagram/table rather than bent paper.
    median_bend = float(np.median(bend_sizes[curved]))
    if np.quantile(bend_sizes[curved], 0.9) > median_bend * 3:
        return None
    targets = np.concatenate(([0.0], np.median(fits, axis=1), [height - 1.0]))
    sources = np.vstack((np.zeros(len(grid_x)), fits, np.full(len(grid_x), height - 1.0)))
    return grid_x, targets, sources


def _unbend(image: np.ndarray, xs: np.ndarray, targets: np.ndarray, sources: np.ndarray) -> np.ndarray:
    height, width = image.shape[:2]
    columns = np.arange(width, dtype=np.float64)
    curves = np.vstack([np.interp(columns, xs, row) for row in sources])
    rows = np.arange(height, dtype=np.float64)
    intervals = np.clip(np.searchsorted(targets, rows, side="right") - 1, 0, len(targets) - 2)
    fractions = ((rows - targets[intervals]) / (targets[intervals + 1] - targets[intervals]))[:, None]
    map_y = curves[intervals] * (1 - fractions) + curves[intervals + 1] * fractions
    map_x = np.broadcast_to(columns, (height, width))
    return cv2.remap(image, map_x.astype(np.float32), map_y.astype(np.float32),
                     cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def rectify_page(image: np.ndarray, mode: str = "auto", max_side: int = 1280) -> RectifiedPage:
    """Resize, optionally detect a page, then flatten reliable curved baselines.

    ``none`` only resizes; ``perspective`` does not fit curvature; ``auto``
    attempts both, retaining the image when there is insufficient evidence.
    """
    if mode not in {"none", "perspective", "auto"}:
        raise ValueError("校正模式必须是 none、perspective 或 auto")
    if not isinstance(image, np.ndarray) or image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("输入必须是非空 BGR 三通道图像")
    if image.dtype != np.uint8 or min(image.shape[:2]) < 2:
        raise ValueError("输入必须是至少 2×2 的 uint8 图像")
    if not isinstance(max_side, int) or not 64 <= max_side <= 4096:
        raise ValueError("max_side 必须是 64 到 4096 的整数")
    source_h, source_w = image.shape[:2]
    ratio = min(1.0, max_side / max(source_w, source_h))
    width, height = max(2, round(source_w * ratio)), max(2, round(source_h * ratio))
    resized = cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA) if ratio < 1 else image.copy()
    matrix = np.array([[width / source_w, 0, 0], [0, height / source_h, 0], [0, 0, 1]], np.float64)
    page = RectifiedPage(resized, (source_w, source_h), matrix)
    if mode == "none":
        return page
    gray = cv2.cvtColor(page.image, cv2.COLOR_BGR2GRAY)
    quad = _find_page(gray) if min(width, height) >= 64 else None
    if quad is not None:
        top, right, bottom, left = (np.linalg.norm(quad[1] - quad[0]),
                                    np.linalg.norm(quad[2] - quad[1]),
                                    np.linalg.norm(quad[2] - quad[3]),
                                    np.linalg.norm(quad[3] - quad[0]))
        page_w, page_h = max(2, round(max(top, bottom))), max(2, round(max(left, right)))
        destination = np.array([[0, 0], [page_w - 1, 0],
                                [page_w - 1, page_h - 1], [0, page_h - 1]], np.float32)
        perspective = cv2.getPerspectiveTransform(quad, destination)
        page.image = cv2.warpPerspective(page.image, perspective, (page_w, page_h),
                                         borderMode=cv2.BORDER_REPLICATE)
        page.perspective_matrix = perspective @ matrix
        page.perspective_applied = True
        gray = cv2.cvtColor(page.image, cv2.COLOR_BGR2GRAY)
    else:
        page.warnings.append("未检测到可靠页面边界，保留画面范围。")
    if mode == "auto":
        model = _fit_baselines(gray)
        if model is not None:
            page.curvature_x, page.curvature_target_y, page.curvature_source_y = model
            page.image = _unbend(page.image, *model)
        else:
            page.warnings.append("未发现足够可靠的弯曲文字行，未应用曲面展开。")
    return page
