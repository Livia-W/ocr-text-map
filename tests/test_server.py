"""HTTP contract checks that do not require OCR weights or network access."""

import base64
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from mobile_ocr import __version__
from mobile_ocr.__main__ import main
from mobile_ocr.pipeline import BusyError, OCRRuntimeError
from mobile_ocr.server import MAX_IMAGE_BYTES, STATIC_DIRECTORY, create_app


class FakePipeline:
    def __init__(self):
        self.ready = False
        self.calls = []
        self.error = None

    def process(self, encoded, *, mode="auto", min_confidence=0.45, max_side=1920, rotation=0, split="none", split_position=0.5):
        kwargs = {
            "mode": mode, "min_confidence": min_confidence, "max_side": max_side,
            "rotation": rotation, "split": split, "split_position": split_position,
        }
        self.calls.append((encoded, kwargs, threading.get_ident()))
        if self.error:
            raise self.error
        self.ready = True
        return {"text": "中文测试", "lines": [], "rectified_image": ""}


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.pipeline = FakePipeline()
        self.client = TestClient(create_app(self.pipeline))

    def tearDown(self):
        self.client.close()

    def test_health_does_not_load_or_run_model(self):
        result = self.client.get("/api/health")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json(), {"status": "ok", "engine": "rapidocr", "ready": False, "version": __version__})
        self.assertEqual(self.pipeline.calls, [])
        self.assertEqual(result.headers["cache-control"], "no-store")

    def test_raw_photo_and_parameters_reach_pipeline(self):
        result = self.client.post(
            "/api/ocr?mode=perspective&min_confidence=0.6&max_side=2560&rotation=90&split=pages&split_position=0.4",
            content=b"raw-jpeg-test-photo",
            headers={"Content-Type": "image/jpeg"},
        )
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["text"], "中文测试")
        encoded, options, thread_id = self.pipeline.calls[0]
        self.assertEqual(encoded, b"raw-jpeg-test-photo")
        self.assertEqual(options, {"mode": "perspective", "min_confidence": 0.6, "max_side": 2560, "rotation": 90, "split": "pages", "split_position": 0.4})
        self.assertIs(type(options["rotation"]), int)
        self.assertNotEqual(thread_id, threading.get_ident())
        self.assertEqual(result.headers["cache-control"], "no-store")

    def test_defaults(self):
        result = self.client.post("/api/ocr", content=b"png", headers={"Content-Type": "image/png"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.pipeline.calls[0][1], {"mode": "auto", "min_confidence": 0.45, "max_side": 1920, "rotation": 0, "split": "none", "split_position": 0.5})

    def test_empty_photo(self):
        result = self.client.post("/api/ocr", content=b"")
        self.assertEqual(result.status_code, 400)
        self.assertIn("error", result.json())
        self.assertEqual(self.pipeline.calls, [])

    def test_bad_image(self):
        self.pipeline.error = ValueError("无法解码图像。")
        result = self.client.post("/api/ocr", content=b"invalid")
        self.assertEqual(result.status_code, 400)
        self.assertEqual(result.json(), {"error": "无法解码图像。"})

    def test_unsupported_content_type(self):
        result = self.client.post("/api/ocr", json={"image": "unsupported"})
        self.assertEqual(result.status_code, 415)
        self.assertEqual(self.pipeline.calls, [])

    def test_declared_oversized_photo(self):
        result = self.client.post("/api/ocr", content=b"small", headers={"Content-Length": str(MAX_IMAGE_BYTES + 1)})
        self.assertEqual(result.status_code, 413)
        self.assertEqual(self.pipeline.calls, [])

    def test_streamed_size_limit_without_content_length(self):
        with patch("mobile_ocr.server.MAX_IMAGE_BYTES", 16):
            result = self.client.post("/api/ocr", content=iter([b"first-photo-", b"extra-data"]))
        self.assertEqual(result.status_code, 413)
        self.assertEqual(self.pipeline.calls, [])

    def test_invalid_content_length(self):
        for length in ("-1", "not-a-number"):
            with self.subTest(length=length):
                result = self.client.post("/api/ocr", content=b"x", headers={"Content-Length": length})
                self.assertEqual(result.status_code, 400)
        self.assertEqual(self.pipeline.calls, [])

    def test_busy_and_runtime_errors(self):
        for error in (BusyError("busy"), OCRRuntimeError("模型不可用。")):
            with self.subTest(error=type(error).__name__):
                self.pipeline.error = error
                result = self.client.post("/api/ocr", content=b"x")
                self.assertEqual(result.status_code, 503)
                self.assertIn("error", result.json())
                self.assertEqual(result.headers["cache-control"], "no-store")

    def test_query_validation(self):
        for query in (
            "mode=unknown", "min_confidence=-1", "min_confidence=nan", "min_confidence=1.1",
            "max_side=639", "max_side=2561", "max_side=text",
            "rotation=-90", "rotation=45", "rotation=360", "rotation=text",
            "split=page", "split=unknown", "split_position=0.09", "split_position=0.91",
            "split_position=nan", "split_position=inf", "split_position=text",
        ):
            with self.subTest(query=query):
                result = self.client.post("/api/ocr?" + query, content=b"x")
                self.assertEqual(result.status_code, 422)
                self.assertIn("error", result.json())
        self.assertEqual(self.pipeline.calls, [])

    def test_parameter_boundaries_and_all_rotations(self):
        for angle, split, position, side in (
            (0, "none", 0.1, 640), (90, "pages", 0.9, 2560),
            (180, "columns", 0.1, 1920), (270, "columns", 0.9, 2560),
        ):
            with self.subTest(rotation=angle, split=split):
                result = self.client.post(
                    f"/api/ocr?rotation={angle}&split={split}&split_position={position}&max_side={side}",
                    content=b"jpeg",
                )
                self.assertEqual(result.status_code, 200)
                options = self.pipeline.calls[-1][1]
                self.assertEqual((options["rotation"], options["split"], options["split_position"], options["max_side"]), (angle, split, position, side))

    def test_openapi_documents_binary_photo_input(self):
        schema = self.client.get("/openapi.json").json()
        operation = schema["paths"]["/api/ocr"]["post"]
        self.assertEqual(set(operation["requestBody"]["content"]), {"image/jpeg", "image/png", "image/webp"})
        parameters = {item["name"]: item["schema"] for item in operation["parameters"]}
        self.assertEqual(parameters["max_side"]["default"], 1920)
        self.assertEqual(parameters["max_side"]["maximum"], 2560)
        self.assertEqual(parameters["split_position"]["minimum"], 0.1)
        self.assertEqual(parameters["split_position"]["maximum"], 0.9)

    def test_no_cross_origin_policy_is_added(self):
        result = self.client.options("/api/ocr", headers={"Origin": "https://unrelated.example", "Access-Control-Request-Method": "POST"})
        self.assertNotIn("access-control-allow-origin", result.headers)

    def test_static_index_if_available(self):
        if not (STATIC_DIRECTORY / "index.html").is_file():
            self.skipTest("静态页面正在由另一任务实现。")
        result = self.client.get("/")
        self.assertEqual(result.status_code, 200)
        self.assertIn("text/html", result.headers["content-type"])
        self.assertEqual(result.headers["cache-control"], "no-store")


class CliTests(unittest.TestCase):
    def test_unicode_paths_and_image_export(self):
        image_bytes = b"jpeg-image-data"
        expected = {
            "text": "中文页面",
            "rectified_image": "data:image/jpeg;base64," + base64.b64encode(image_bytes).decode("ascii"),
        }
        pipeline = Mock()
        pipeline.process.return_value = expected
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "输入图片.png"
            output = root / "文字地图.json"
            image_output = root / "校正页面.jpg"
            source.write_bytes(b"source-png-data")
            with patch("mobile_ocr.pipeline.OCRPipeline", return_value=pipeline), redirect_stderr(StringIO()):
                code = main(["recognize", str(source), "--output", str(output), "--image-output", str(image_output), "--mode", "none", "--max-side", "960"])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), expected)
            self.assertIn("中文页面", output.read_text(encoding="utf-8"))
            self.assertEqual(image_output.read_bytes(), image_bytes)
        pipeline.process.assert_called_once_with(b"source-png-data", mode="none", min_confidence=0.45, max_side=960, rotation=0, split="none", split_position=0.5)

    def test_multiple_regions_export_all_images_and_new_parameters(self):
        payloads = [b"left-jpeg", b"right-jpeg"]
        expected = {
            "text": "左页\n右页",
            "rectified_image": base64.b64encode(b"legacy-first-page").decode("ascii"),
            "regions": [
                {"rectified_image": "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii")}
                for image in payloads
            ],
        }
        pipeline = Mock()
        pipeline.process.return_value = expected
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "左右页.png"
            output = root / "结果.json"
            image_output = root / "校正页面.png"
            source.write_bytes(b"original-photo")
            with patch("mobile_ocr.pipeline.OCRPipeline", return_value=pipeline), redirect_stderr(StringIO()):
                code = main([
                    "recognize", str(source), "--output", str(output), "--image-output", str(image_output),
                    "--rotation", "270", "--split", "pages", "--split-position", "0.4", "--max-side", "2560",
                ])
            self.assertEqual(code, 0)
            self.assertFalse(image_output.exists())
            self.assertEqual((root / "校正页面-1.jpg").read_bytes(), payloads[0])
            self.assertEqual((root / "校正页面-2.jpg").read_bytes(), payloads[1])
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), expected)
        pipeline.process.assert_called_once_with(b"original-photo", mode="auto", min_confidence=0.45, max_side=2560, rotation=270, split="pages", split_position=0.4)

    def test_single_region_preserves_image_output_name_and_defaults(self):
        pipeline = Mock()
        pipeline.process.return_value = {"regions": [{"rectified_image": base64.b64encode(b"one-jpeg").decode("ascii")}]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "照片.png"
            output = root / "指定文件.jpg"
            source.write_bytes(b"photo")
            with patch("mobile_ocr.pipeline.OCRPipeline", return_value=pipeline), redirect_stderr(StringIO()), redirect_stdout(StringIO()):
                code = main(["recognize", str(source), "--image-output", str(output)])
            self.assertEqual(code, 0)
            self.assertEqual(output.read_bytes(), b"one-jpeg")
            self.assertFalse((root / "指定文件-1.jpg").exists())
        pipeline.process.assert_called_once_with(b"photo", mode="auto", min_confidence=0.45, max_side=1920, rotation=0, split="none", split_position=0.5)

    def test_missing_region_image_reports_error_without_exporting_first_only(self):
        pipeline = Mock()
        pipeline.process.return_value = {"regions": [
            {"rectified_image": base64.b64encode(b"one-jpeg").decode("ascii")}, {},
        ]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "照片.png"
            source.write_bytes(b"photo")
            with patch("mobile_ocr.pipeline.OCRPipeline", return_value=pipeline), redirect_stderr(StringIO()) as errors:
                code = main(["recognize", str(source), "--image-output", str(root / "页面.jpg")])
            self.assertEqual(code, 1)
            self.assertIn("未包含校正图像", errors.getvalue())
            self.assertFalse((root / "页面-1.jpg").exists())

    def test_invalid_rotation_split_and_resolution_are_rejected(self):
        for options in (
            ["--rotation", "45"], ["--rotation", "360"], ["--split", "unknown"],
            ["--split-position", "0.09"], ["--split-position", "0.91"], ["--split-position", "nan"],
            ["--max-side", "639"], ["--max-side", "2561"],
        ):
            with self.subTest(options=options), redirect_stderr(StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    main(["recognize", "photo.jpg", *options])
                self.assertEqual(raised.exception.code, 2)

    def test_missing_input_reports_error(self):
        with tempfile.TemporaryDirectory() as directory, redirect_stderr(StringIO()) as errors:
            code = main(["recognize", str(Path(directory) / "不存在.png")])
        self.assertEqual(code, 1)
        self.assertIn("识别失败", errors.getvalue())

    def test_tls_parameters_must_be_paired(self):
        for arguments in (["--ssl-certfile", "cert.pem"], ["--ssl-keyfile", "key.pem"]):
            with self.subTest(arguments=arguments), redirect_stderr(StringIO()) as errors:
                with self.assertRaises(SystemExit) as raised:
                    main(["serve", *arguments])
                self.assertEqual(raised.exception.code, 2)
                self.assertIn("必须同时提供", errors.getvalue())

    def test_help_does_not_initialize_model(self):
        with patch("mobile_ocr.pipeline.OCRPipeline") as pipeline, redirect_stdout(StringIO()) as output:
            with self.assertRaises(SystemExit) as raised:
                main(["--help"])
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("中文照片 OCR", output.getvalue())
        pipeline.assert_not_called()


if __name__ == "__main__":
    unittest.main()
