"""Geometric correctness tests do not need OCR models or network access."""

import unittest

import cv2
import numpy as np

from mobile_ocr.geometry import RectifiedPage, rectify_page


def curved_page() -> np.ndarray:
    image = np.full((420, 800, 3), 255, np.uint8)
    for row in range(6):
        for x in range(52, 748, 25):
            bottom = round(55 + row * 55 + 28 * ((x - 400) / 350) ** 2)
            cv2.rectangle(image, (x, bottom - 17), (x + 15, bottom), (0, 0, 0), -1)
    return image


def first_line_spread(image: np.ndarray) -> float:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    bottoms = []
    for x in range(60, 744, 25):
        ink = np.where(gray[20:110, x] < 100)[0]
        if len(ink):
            bottoms.append(ink[-1])
    return float(np.std(bottoms))


class GeometryTests(unittest.TestCase):
    def test_perspective_and_curvature_coordinates_round_trip(self):
        homography = np.array([[0.8, 0.05, 12], [0.02, 0.9, 7], [0.0001, 0.0002, 1]])
        xs = np.linspace(0, 639, 17)
        bend = 12 * (1 - ((xs - 320) / 320) ** 2)
        targets = np.array([0.0, 80, 160, 240, 319])
        sources = np.vstack([xs * 0, 80 + bend, 160 + bend * 0.8, 240 + bend * 0.5, xs * 0 + 319])
        page = RectifiedPage(np.zeros((320, 640, 3), np.uint8), (800, 600),
                             homography, True, [], xs, targets, sources)
        rng = np.random.default_rng(7)
        output_points = rng.uniform([0, 0], [639, 319], (250, 2))
        restored = page.to_rectified(page.to_source(output_points))
        np.testing.assert_allclose(restored, output_points, atol=1e-7)
        self.assertTrue(page.as_dict()["curvature_applied"])

    def test_detects_tilted_bright_page_and_maps_corners(self):
        image = np.full((480, 640, 3), 35, np.uint8)
        corners = np.array([[110, 40], [540, 90], [570, 420], [70, 400]], np.int32)
        cv2.fillConvexPoly(image, corners, (245, 245, 245))
        page = rectify_page(image, mode="perspective")
        self.assertTrue(page.perspective_applied)
        w, h = page.rectified_size
        output_corners = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
        np.testing.assert_allclose(page.to_source(output_corners), corners, atol=3)

    def test_diamond_and_asymmetric_page_do_not_swap_or_cross_corners(self):
        # A diamond gives duplicate min/max sums in the common sum/difference
        # corner-ordering shortcut. The asymmetric case adds perspective skew.
        examples = [
            np.array([[320, 25], [620, 320], [320, 620], [25, 320]], np.int32),
            np.array([[185, 45], [610, 160], [470, 610], [45, 450]], np.int32),
        ]
        for corners in examples:
            with self.subTest(corners=corners.tolist()):
                image = np.full((650, 650, 3), 35, np.uint8)
                cv2.fillConvexPoly(image, corners, (245, 245, 245))
                page = rectify_page(image, mode="perspective")
                self.assertTrue(page.perspective_applied)
                w, h = page.rectified_size
                output_corners = np.array([[0, 0], [w - 1, 0],
                                           [w - 1, h - 1], [0, h - 1]])
                restored = page.to_source(output_corners)
                # Starting corner is arbitrary around a near-45-degree page;
                # a valid ordering must remain cyclic with distinct corners.
                errors = [np.max(np.linalg.norm(restored - np.roll(corners, shift, axis=0), axis=1))
                          for shift in range(4)]
                self.assertLess(min(errors), 4)
                np.testing.assert_allclose(page.to_rectified(restored), output_corners, atol=1e-7)

    def test_bent_text_becomes_flatter(self):
        image = curved_page()
        page = rectify_page(image, mode="auto")
        self.assertTrue(page.curvature_applied, page.warnings)
        self.assertLess(first_line_spread(page.image), first_line_spread(image) * 0.35)
        self.assertFalse(page.perspective_applied)

    def test_blank_and_straight_pages_are_not_bent(self):
        for value in (0, 127, 255):
            page = rectify_page(np.full((300, 400, 3), value, np.uint8))
            self.assertFalse(page.curvature_applied)
            self.assertFalse(page.perspective_applied)
        straight = np.full((420, 800, 3), 255, np.uint8)
        for row in range(6):
            for x in range(52, 748, 25):
                cv2.rectangle(straight, (x, 40 + row * 55), (x + 15, 57 + row * 55), (0, 0, 0), -1)
        self.assertFalse(rectify_page(straight).curvature_applied)

    def test_resize_mapping_and_small_frame(self):
        image = np.zeros((1000, 2000, 3), np.uint8)
        page = rectify_page(image, mode="none", max_side=1000)
        self.assertEqual(page.rectified_size, (1000, 500))
        np.testing.assert_allclose(page.to_source(np.array([[100, 200]])), [[200, 400]])
        small = rectify_page(np.full((2, 3, 3), 255, np.uint8))
        self.assertEqual(small.rectified_size, (3, 2))
        self.assertFalse(small.curvature_applied)

    def test_reject_invalid_inputs(self):
        for image in (None, np.zeros((0, 0, 3), np.uint8), np.zeros((20, 20), np.uint8)):
            with self.assertRaises(ValueError):
                rectify_page(image)
        with self.assertRaises(ValueError):
            rectify_page(np.zeros((20, 20, 3), np.uint8), mode="unknown")


if __name__ == "__main__":
    unittest.main()
