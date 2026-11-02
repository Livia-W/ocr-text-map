"""Photo preparation must preserve actual pixel identities and coordinates."""

import json
import unittest

import numpy as np

from mobile_ocr.calibration import calibrate_photo


def coordinate_image(height: int, width: int) -> np.ndarray:
    ys, xs = np.indices((height, width))
    return np.stack((xs % 256, ys % 256, (xs + ys) % 256), axis=2).astype(np.uint8)


class CalibrationTests(unittest.TestCase):
    def test_four_rotations_preserve_corner_pixels_and_coordinate_mapping(self):
        image = coordinate_image(64, 96)
        source_corners = np.array([[0, 0], [95, 0], [95, 63], [0, 63]])
        expected = {
            0: [[0, 0], [95, 0], [95, 63], [0, 63]],
            90: [[63, 0], [63, 95], [0, 95], [0, 0]],
            180: [[95, 63], [0, 63], [0, 0], [95, 0]],
            270: [[0, 95], [0, 0], [63, 0], [63, 95]],
        }
        for rotation, corners in expected.items():
            with self.subTest(rotation=rotation):
                region, = calibrate_photo(image, rotation=rotation)
                np.testing.assert_array_equal(region.image, np.rot90(image, -rotation // 90))
                np.testing.assert_array_equal(region.from_source(source_corners), corners)
                np.testing.assert_array_equal(region.to_source(corners), source_corners)
                for source_point, region_point in zip(source_corners, corners):
                    sx, sy = source_point
                    rx, ry = region_point
                    np.testing.assert_array_equal(region.image[ry, rx], image[sy, sx])

    def test_noncentral_split_covers_every_pixel_in_left_to_right_order(self):
        image = coordinate_image(80, 200)
        for split, prefix, labels in (("pages", "page", ["左页", "右页"]),
                                      ("columns", "column", ["左栏", "右栏"])):
            with self.subTest(split=split):
                regions = calibrate_photo(image, split=split, split_position=0.35)
                self.assertEqual([r.id for r in regions], [prefix + "-1", prefix + "-2"])
                self.assertEqual([r.label for r in regions], labels)
                self.assertEqual(regions[0].bounds_rotated, (0, 0, 70, 80))
                self.assertEqual(regions[1].bounds_rotated, (70, 0, 130, 80))
                np.testing.assert_array_equal(np.concatenate([r.image for r in regions], axis=1), image)
                np.testing.assert_array_equal(regions[1].to_source([[0, 0], [129, 79]]),
                                              [[70, 0], [199, 79]])

    def test_rotation_then_split_uses_rotated_width_and_round_trips(self):
        image = coordinate_image(150, 210)
        rng = np.random.default_rng(17)
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                regions = calibrate_photo(image, rotation=rotation, split="pages", split_position=0.4)
                rotated = np.rot90(image, -rotation // 90)
                boundary = round(rotated.shape[1] * 0.4)
                self.assertEqual(regions[1].bounds_rotated[0], boundary)
                np.testing.assert_array_equal(np.concatenate([r.image for r in regions], axis=1), rotated)
                for region in regions:
                    width, height = region.region_size
                    points = rng.uniform([0, 0], [width - 1, height - 1], (40, 2))
                    np.testing.assert_allclose(region.from_source(region.to_source(points)), points, atol=1e-12)
                    source_point = region.to_source([[0, 0]])[0].astype(int)
                    np.testing.assert_array_equal(region.image[0, 0], image[source_point[1], source_point[0]])

    def test_metadata_is_serializable_and_image_regions_are_independent(self):
        image = coordinate_image(80, 100)
        left, right = calibrate_photo(image, rotation=180, split="columns")
        metadata = json.loads(json.dumps(right.as_dict(), ensure_ascii=False))
        self.assertEqual(metadata["source_size"], [100, 80])
        self.assertEqual(metadata["rotated_size"], [100, 80])
        self.assertEqual(metadata["bounds_rotated"], [50, 0, 50, 80])
        self.assertEqual(metadata["kind"], "column")
        np.testing.assert_allclose(np.asarray(metadata["region_to_source_matrix"]) @
                                   np.asarray(metadata["source_to_region_matrix"]), np.eye(3))
        original = image.copy()
        left.image[:] = 0
        np.testing.assert_array_equal(image, original)
        np.testing.assert_array_equal(right.image, np.rot90(original, 2)[:, 50:])

    def test_invalid_parameters_and_regions_too_small_are_rejected(self):
        image = coordinate_image(100, 200)
        bad_arguments = [
            {"rotation": 45}, {"rotation": True}, {"rotation": 90.0},
            {"split": "automatic"}, {"split": []},
            {"split_position": 0.09}, {"split_position": 0.91},
            {"split_position": float("nan")}, {"split_position": float("inf")},
            {"split_position": True}, {"split_position": "0.5"},
            {"split": "pages", "split_position": 0.1},
        ]
        for arguments in bad_arguments:
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                calibrate_photo(image, **arguments)
        for invalid in (None, np.zeros((20, 20), np.uint8),
                        np.zeros((0, 20, 3), np.uint8), np.zeros((20, 20, 3), np.float32)):
            with self.assertRaises(ValueError):
                calibrate_photo(invalid)
        with self.assertRaises(ValueError):
            calibrate_photo(coordinate_image(31, 200), split="pages")
        with self.assertRaises(ValueError):
            calibrate_photo(coordinate_image(200, 31), rotation=90, split="columns")


if __name__ == "__main__":
    unittest.main()
