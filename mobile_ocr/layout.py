"""Whitespace-based layout and reading order for horizontal printed text.

This is deliberately a geometric heuristic, not a semantic layout model.
Recursive whitespace cuts separate full-width headers, then text columns.
"""

import numpy as np

from .engine import Detection


def bounding_box(points) -> list[float]:
    p = np.asarray(points, dtype=float)
    low, high = p.min(axis=0), p.max(axis=0)
    return [float(low[0]), float(low[1]), float(high[0] - low[0]), float(high[1] - low[1])]


def _bounds(item: Detection):
    x, y, w, h = bounding_box(item.polygon)
    return x, y, x + w, y + h


def _gap_cut(items, axis, minimum):
    intervals = sorted((_bounds(d)[axis], _bounds(d)[axis + 2]) for d in items)
    best_gap, best_cut = 0, None
    end = intervals[0][1]
    for start, stop in intervals[1:]:
        if start - end >= minimum and start - end > best_gap:
            best_gap, best_cut = start - end, (start + end) / 2
        end = max(end, stop)
    return best_cut


def _partition(items, median_height, page_width, depth=0):
    if len(items) < 2 or depth >= 24:
        return [items]
    # A column gutter takes precedence when it spans the current region.
    cut = _gap_cut(items, 0, max(1.4 * median_height, page_width * 0.025))
    axis = 0
    if cut is None:
        axis = 1
        cut = _gap_cut(items, 1, max(4, 0.8 * median_height))
    if cut is None:
        return [items]
    left = [d for d in items if _bounds(d)[axis + 2] <= cut]
    right = [d for d in items if _bounds(d)[axis] > cut]
    if not left or not right or len(left) + len(right) != len(items):
        return [items]
    return _partition(left, median_height, page_width, depth + 1) + _partition(
        right, median_height, page_width, depth + 1
    )


def _join_text(left: str, right: str) -> str:
    # Latin words need spaces; CJK text and punctuation do not.
    space = left[-1:].isascii() and left[-1:].isalnum() and right[:1].isascii() and right[:1].isalnum()
    return left + (" " if space else "") + right


def _merge_fragments(items):
    rows = []
    for item in sorted(items, key=lambda d: (_bounds(d)[1], _bounds(d)[0])):
        x0, y0, x1, y1 = _bounds(item)
        target = None
        for row in reversed(rows):
            rx0, ry0, rx1, ry1 = _bounds(row)
            overlap = min(y1, ry1) - max(y0, ry0)
            height = max(1, min(y1 - y0, ry1 - ry0))
            adjacent = 0 <= x0 - rx1 <= height or 0 <= rx0 - x1 <= height
            if overlap >= 0.65 * height and adjacent:
                target = row
                break
        if target is None:
            rows.append(Detection(item.polygon.copy(), item.text, item.confidence))
        else:
            bx0, by0, bx1, by1 = _bounds(target)
            # Keep slanted detector polygons separate: axis-aligned unions would
            # degrade their geometry and could join separate slanted lines.
            if abs(target.polygon[1, 1] - target.polygon[0, 1]) > 0.2 * height:
                rows.append(Detection(item.polygon.copy(), item.text, item.confidence))
                continue
            count = len(target.text) + len(item.text)
            target.confidence = (target.confidence * len(target.text) + item.confidence * len(item.text)) / count
            # Detection tops often differ by a few pixels on the same row.
            # A later item may therefore be the left-hand fragment.
            target.text = _join_text(item.text, target.text) if x0 < bx0 else _join_text(target.text, item.text)
            target.polygon = np.array(
                [[min(bx0, x0), min(by0, y0)], [max(bx1, x1), min(by0, y0)],
                 [max(bx1, x1), max(by1, y1)], [min(bx0, x0), max(by1, y1)]], dtype=float
            )
    return sorted(rows, key=lambda d: (_bounds(d)[1], _bounds(d)[0]))


def analyze_layout(detections: list[Detection], page_width: int):
    """Return ordered (Detection, block_id) pairs and JSON-ready blocks."""
    if not detections:
        return [], []
    median_height = float(np.median([max(1, _bounds(d)[3] - _bounds(d)[1]) for d in detections]))
    regions = _partition(detections, median_height, page_width)
    ordered, blocks = [], []
    for region in regions:
        rows = _merge_fragments(region)
        block_id = f"block-{len(blocks) + 1}"
        indices = range(len(ordered) + 1, len(ordered) + len(rows) + 1)
        heights = [_bounds(d)[3] - _bounds(d)[1] for d in rows]
        blocks.append({
            "id": block_id,
            "type": "heading" if len(rows) <= 2 and np.median(heights) > 1.35 * median_height else "text",
            "line_ids": [f"line-{i}" for i in indices],
            "bbox": bounding_box(np.concatenate([d.polygon for d in rows])),
            "coordinate_space": "rectified",
        })
        ordered.extend((row, block_id) for row in rows)
    return ordered, blocks
