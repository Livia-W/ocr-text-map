"""Manual photo orientation and two-region separation before rectification.

The input is an EXIF-normalized BGR photo. Coordinates returned by this module
refer to that photo, before the user's explicit clockwise rotation. Region
coordinates can be passed to ``geometry.rectify_page`` independently; compose
its ``to_source`` with ``PhotoRegion.to_source`` to recover photo coordinates.
"""

from __future__ import annotations

from dataclasses import dataclass
from numbers import Real

import cv2
import numpy as np


def _transform_points(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    values = np.asarray(points, dtype=np.float64)
    if values.ndim < 1 or values.shape[-1] != 2 or not np.all(np.isfinite(values)):
        raise ValueError("坐标必须是末维为 2 的有限数值数组")
    shape = values.shape
    values = values.reshape(-1, 2)
    return (values @ matrix[:2, :2].T + matrix[:2, 2]).reshape(shape)


@dataclass
class PhotoRegion:
    """One unscaled region and its exact rotation/crop coordinate transforms."""

    image: np.ndarray
    id: str
    label: str
    kind: str
    rotation: int
    bounds_rotated: tuple[int, int, int, int]
    source_size: tuple[int, int]
    rotated_size: tuple[int, int]
    source_to_region_matrix: np.ndarray

    @property
    def region_to_source_matrix(self) -> np.ndarray:
        return np.linalg.inv(self.source_to_region_matrix)

    @property
    def region_size(self) -> tuple[int, int]:
        return self.image.shape[1], self.image.shape[0]

    def to_source(self, points: np.ndarray) -> np.ndarray:
        """Map region pixels to the original EXIF-normalized photo pixels."""
        return _transform_points(points, self.region_to_source_matrix)

    def from_source(self, points: np.ndarray) -> np.ndarray:
        """Map photo pixels to this region, including points outside its crop."""
        return _transform_points(points, self.source_to_region_matrix)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "kind": self.kind,
            "rotation": self.rotation,
            "bounds_rotated": list(self.bounds_rotated),
            "source_size": list(self.source_size),
            "rotated_size": list(self.rotated_size),
            "region_size": list(self.region_size),
            "source_to_region_matrix": self.source_to_region_matrix.tolist(),
            "region_to_source_matrix": self.region_to_source_matrix.tolist(),
            "coordinate_unit": "pixel",
            "source_coordinate_space": "exif_normalized_photo",
        }


def calibrate_photo(
    image: np.ndarray,
    *,
    rotation: int = 0,
    split: str = "none",
    split_position: float = 0.5,
) -> list[PhotoRegion]:
    """Rotate clockwise, then optionally separate two pages or two columns.

    ``split_position`` is the left region's fraction of the *rotated* width;
    its pixel boundary is ``round(rotated_width * split_position)``. The two
    crops cover every rotated pixel exactly once, in left-to-right order.
    Each split region must be at least 32 pixels wide and high. ``columns``
    supports exactly two columns; it does not perform automatic layout analysis.
    """
    if not isinstance(image, np.ndarray) or image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("输入必须是非空 BGR 三通道照片")
    if image.dtype != np.uint8 or min(image.shape[:2]) < 2:
        raise ValueError("输入必须是至少 2×2 的 uint8 照片")
    if isinstance(rotation, (bool, np.bool_)) or not isinstance(rotation, (int, np.integer)) or rotation not in (0, 90, 180, 270):
        raise ValueError("旋转角度必须是顺时针 0、90、180 或 270 度")
    if not isinstance(split, str) or split not in {"none", "pages", "columns"}:
        raise ValueError("分区方式必须是 none、pages 或 columns（左右两栏）")
    if isinstance(split_position, (bool, np.bool_)) or not isinstance(split_position, Real) or not np.isfinite(split_position) or not 0.1 <= split_position <= 0.9:
        raise ValueError("分割位置必须是旋转后照片宽度的 0.1 到 0.9 之间的比例")

    rotation = int(rotation)
    source_h, source_w = image.shape[:2]
    if rotation == 90:
        rotated = cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
        rotation_matrix = np.array([[0, -1, source_h - 1], [1, 0, 0], [0, 0, 1]], np.float64)
    elif rotation == 180:
        rotated = cv2.rotate(image, cv2.ROTATE_180)
        rotation_matrix = np.array([[-1, 0, source_w - 1], [0, -1, source_h - 1], [0, 0, 1]], np.float64)
    elif rotation == 270:
        rotated = cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
        rotation_matrix = np.array([[0, 1, 0], [-1, 0, source_w - 1], [0, 0, 1]], np.float64)
    else:
        rotated = image.copy()
        rotation_matrix = np.eye(3, dtype=np.float64)

    height, width = rotated.shape[:2]
    if split == "none":
        partitions = [(0, width, "page-1", "完整页面", "page")]
    else:
        boundary = round(width * float(split_position))
        if min(boundary, width - boundary, height) < 32:
            raise ValueError("分割后每个区域的宽和高都必须至少为 32 像素，请调整分割线或使用更大照片")
        if split == "pages":
            partitions = [(0, boundary, "page-1", "左页", "page"),
                          (boundary, width, "page-2", "右页", "page")]
        else:
            partitions = [(0, boundary, "column-1", "左栏", "column"),
                          (boundary, width, "column-2", "右栏", "column")]

    regions = []
    for left, right, region_id, label, kind in partitions:
        crop_matrix = np.array([[1, 0, -left], [0, 1, 0], [0, 0, 1]], np.float64)
        regions.append(PhotoRegion(
            image=rotated[:, left:right].copy(),
            id=region_id,
            label=label,
            kind=kind,
            rotation=rotation,
            bounds_rotated=(left, 0, right - left, height),
            source_size=(source_w, source_h),
            rotated_size=(width, height),
            source_to_region_matrix=crop_matrix @ rotation_matrix,
        ))
    return regions
