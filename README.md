# OCR Text Map — Module B

Python photo OCR and text-coordinate mapping for Chinese and English printed documents. This repository delivers **module B**: photo calibration, text recognition, line localization, basic reading order, perspective correction, and conservative text-baseline dewarping.

Read the full [中文使用说明](README.zh-CN.md), [integration contract](docs/INTEGRATION.md), and [contributing guide](CONTRIBUTING.md).

## Quick start

Use Python **3.10–3.12**. On Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m mobile_ocr serve
```

Open <http://127.0.0.1:8000>, select an existing photo, adjust rotation and the optional left/right split, then recognize it. The page is a validation tool for module B.

Recognize a photo from the command line:

```powershell
.\.venv\Scripts\python.exe -m mobile_ocr recognize "book.jpg" --rotation 90 --split pages --split-position 0.5 --mode auto --max-side 1920 --output "result.json" --image-output "rectified.jpg"
```

Two regions produce `rectified-1.jpg` and `rectified-2.jpg`. On macOS/Linux, use `.venv/bin/python` instead.

## Input and output

- Input: JPEG, PNG, or WebP bytes; Python callers can also supply an EXIF-normalized BGR NumPy image.
- Photo limits: 8 MiB encoded, 20 million decoded pixels. Processing size defaults to 1920 pixels per region, configurable from 640 to 2560.
- Calibration: clockwise 0/90/180/270-degree rotation, followed by no split, two pages, or two columns. The manual split position is a fraction of the rotated width.
- Output: `schema_version: "2.0"` document results containing `document_id`, `regions`, `lines`, `blocks`, text, and reversible coordinate transforms.
- `polygon_source` and `bbox_source` always refer to the original EXIF-normalized photo; rectified coordinates are local to each region.

The package uses RapidOCR/ONNX Runtime on CPU. Geometry and reading order are heuristics for horizontal printed documents, with explicit fallback when evidence is insufficient. Strong folds, vertical writing, handwriting, semantic layout analysis, character-level coordinates, and persistent tracking are outside the current contract.

Module A owns capture; C owns gestures; D owns reading/speech; E owns application integration. Those modules are not implemented by this repository. See the integration contract before consuming results.

## Validation

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node tests/test_photo_ui.cjs
```

Public repository: [Livia-W/ocr-text-map](https://github.com/Livia-W/ocr-text-map).
