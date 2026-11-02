from io import BytesIO
import json
import unittest

import numpy as np
from PIL import Image

from mobile_ocr.engine import Detection, OCRRuntimeError
from mobile_ocr.pipeline import BusyError, OCRPipeline, decode_image


def image_bytes(size=(1600, 800), format="JPEG", **kwargs):
    out = BytesIO()
    Image.new("RGB", size, "white").save(out, format=format, **kwargs)
    return out.getvalue()


class FakeEngine:
    ready = True

    def recognize(self, image, min_confidence):
        self.received_threshold = min_confidence
        return [Detection(np.array([[30, 30], [180, 30], [180, 55], [30, 55]], dtype=float), "中文 OCR", .97)]


class PipelineTests(unittest.TestCase):
    def test_text_map_retains_unicode_and_rescaling(self):
        engine = FakeEngine()
        result = OCRPipeline(engine).process(image_bytes(), mode="none", max_side=800, min_confidence=.25)
        self.assertEqual(result["source_size"], [1600, 800])
        self.assertEqual(result["rectified_size"], [800, 400])
        self.assertEqual(result["text"], "中文 OCR")
        self.assertEqual(engine.received_threshold, .25)
        item = result["lines"][0]
        np.testing.assert_allclose(item["bbox_source"], [60, 60, 300, 50], atol=.2)
        self.assertGreater(len(item["polygon_source"]), 4)
        self.assertEqual(result["coordinates"]["text_location_level"], "line")
        json.dumps(result, ensure_ascii=False, allow_nan=False)

    def test_exif_orientation_matches_displayed_image(self):
        exif = Image.Exif()
        exif[274] = 6
        image = decode_image(image_bytes((100, 200), exif=exif))
        self.assertEqual(image.shape[:2], (100, 200))

    def test_invalid_image_and_small_image(self):
        for encoded in (b"", b"not an image", image_bytes((16, 16))):
            with self.assertRaises(ValueError):
                decode_image(encoded)

    def test_parameter_validation(self):
        pipeline = OCRPipeline(FakeEngine())
        for params in ({"mode": "bad"}, {"min_confidence": float("nan")},
                       {"min_confidence": -1}, {"max_side": 500}, {"max_side": 800.5},
                       {"max_side": 2561}, {"rotation": 45}, {"split": "three-columns"},
                       {"split_position": float("nan")}):
            with self.assertRaises(ValueError):
                pipeline.process(image_bytes(), **params)

    def test_lock_released_after_decode_error(self):
        pipeline = OCRPipeline(FakeEngine())
        with self.assertRaises(ValueError):
            pipeline.process(b"bad")
        self.assertEqual(pipeline.process(image_bytes(), mode="none")["text"], "中文 OCR")

    def test_reject_concurrent_frames(self):
        pipeline = OCRPipeline(FakeEngine())
        pipeline._lock.acquire()
        try:
            with self.assertRaises(BusyError):
                pipeline.process(image_bytes())
        finally:
            pipeline._lock.release()

    def test_lock_released_after_inference_failure(self):
        class FailingEngine(FakeEngine):
            def recognize(self, image, min_confidence):
                raise OCRRuntimeError("test error")

        pipeline = OCRPipeline(FailingEngine())
        with self.assertRaises(OCRRuntimeError):
            pipeline.process(image_bytes(), mode="none")
        pipeline.engine = FakeEngine()
        self.assertTrue(pipeline.process(image_bytes(), mode="none")["lines"])

    def test_empty_ocr_returns_valid_map(self):
        class EmptyEngine(FakeEngine):
            def recognize(self, image, min_confidence):
                return []

        result = OCRPipeline(EmptyEngine()).process(image_bytes(), mode="none")
        self.assertEqual(result["lines"], [])
        self.assertEqual(result["text"], "")
        self.assertTrue(result["warnings"])

    def test_two_regions_have_unique_ids_and_original_photo_coordinates(self):
        result = OCRPipeline(FakeEngine()).process(
            image_bytes((1600, 800)), mode="none", split="pages", max_side=800)
        self.assertEqual(result["schema_version"], "2.0")
        self.assertTrue(result["document_id"])
        self.assertEqual([r["label"] for r in result["regions"]], ["左页", "右页"])
        self.assertEqual([d["region_id"] for d in result["lines"]], ["page-1", "page-2"])
        self.assertEqual([d["reading_order"] for d in result["lines"]], [1, 2])
        self.assertEqual(len({b["id"] for b in result["blocks"]}), 2)
        self.assertEqual(result["regions"][1]["line_ids"], ["line-2"])
        np.testing.assert_allclose(result["lines"][1]["bbox_source"], [830, 30, 150, 25])
        self.assertEqual(result["coordinates"]["rectified_space"], "region-local")
        self.assertEqual(result["transform"], result["regions"][0]["transform"])
        json.dumps(result, ensure_ascii=False, allow_nan=False)

    def test_rotation_split_and_exported_matrix_agree(self):
        # Original 800x1600 becomes 1600x800, split into two 800x800 pages.
        result = OCRPipeline(FakeEngine()).process(
            image_bytes((800, 1600)), mode="none", split="pages", rotation=90, max_side=800)
        self.assertEqual(result["source_size"], [800, 1600])
        self.assertEqual(result["rotated_size"], [1600, 800])
        for region, line in zip(result["regions"], result["lines"]):
            source = np.asarray(line["polygon_source"])
            transform = np.asarray(region["transform"]["source_to_page_matrix"])
            mapped = np.column_stack((source, np.ones(len(source)))) @ transform.T
            mapped = mapped[:, :2] / mapped[:, 2:]
            np.testing.assert_allclose(mapped[::9], line["polygon_rectified"], atol=.002)
        np.testing.assert_allclose(result["lines"][0]["bbox_source"], [30, 1419, 25, 150])
        np.testing.assert_allclose(result["lines"][1]["bbox_source"], [30, 619, 25, 150])

    def test_numpy_entry_point_and_snapshot(self):
        image = np.full((400, 800, 3), 255, np.uint8)

        class MutatingEngine(FakeEngine):
            def recognize(self, pixels, min_confidence):
                pixels[:] = 0
                return super().recognize(pixels, min_confidence)

        result = OCRPipeline(MutatingEngine()).process_image(image, mode="none")
        self.assertEqual(result["source_size"], [800, 400])
        self.assertTrue(np.all(image == 255))
        for bad in (None, image.astype(float), image[:, :, 0], image[:5]):
            with self.assertRaises(ValueError):
                OCRPipeline(FakeEngine()).process_image(bad)


if __name__ == "__main__":
    unittest.main()
