# FeelyReader

FeelyReader brings book-page capture, Chinese/English OCR, tracked finger reading and speech into one browser interface.

Open the default web entry: **[GitHub Pages](https://livia-w.github.io/ocr-text-map/)**. No Python server is required for the default browser OCR engine. See [中文说明](README.zh-CN.md), the [integration contract](docs/INTEGRATION.md), and [deployment instructions](docs/DEPLOYMENT.md).

## Use the browser app

1. Open the HTTPS page in a browser, then upload a JPEG/PNG/WebP photo or enable the camera and capture a page.
2. Select the orientation, optional left/right pages or columns, and split position. Start recognition. The first browser run downloads the OCR runtime and Chinese/English models.
3. Select a recognized page, click a text line, or use the reading controls. Adjust speech speed and save highlights as needed.
4. For paper gestures, keep the camera running, capture a valid page reference, and enable gestures. Finger reading and two-finger selections require fresh, matching page tracking. Uploaded photos and imported JSON alone cannot enable physical paper gestures.

Browser OCR genuinely runs **Tesseract.js 6.0.1 with `chi_sim+eng`** on the device. Photos are not sent to an OCR server in this mode. Selecting the optional Python engine sends the photo to the configured endpoint. Speech uses the browser/system voices; availability varies by device.

A supplies separate perspective reference images for camera captures; the controller sends each reference to B without another manual rotation or split. Photo-upload settings apply to uploaded images. Select one active reference page at a time from the page list.

## Integrated modules

| Module | Implementation |
| --- | --- |
| A — Capture | Camera preview, page detection, perspective reference images, and reference-to-live-video tracking |
| B — OCR | Browser Tesseract adapter by default; optional Python RapidOCR pipeline; rotation, two-region splits, lines, blocks, source coordinates |
| C — Gestures | Shared camera input, tracked pointing and two-finger selection |
| D — Reading | Browser TTS, pause/resume, reading progress, feedback, local highlights/history |
| E — Application | Integrated UI and lifecycle orchestration in `e-app.js` and `reader-controller.js` |

The earlier `app原型` branch supplied a `CNAME` file, not a complete E implementation. The E interface described here is the integration UI in this repository. A `CNAME` file does not establish registration or ownership of a custom domain; the default deployment uses the GitHub Pages URL above.

## OCR engines and limits

| Capability | Browser default | Optional Python |
| --- | --- | --- |
| Chinese/English text and line coordinates | Tesseract.js | RapidOCR + ONNX Runtime |
| Clockwise rotation and left/right splits | Yes | Yes |
| Additional page perspective correction inside B | No; A can provide perspective-warped references | Yes, with reliable boundaries |
| Nonlinear curved-page correction | No; returns a limitation warning | Conservative horizontal-baseline unbending |
| Running on GitHub Pages | Yes | Python must run separately |

Inputs are limited to **8 MiB encoded, 20 million pixels**, with both dimensions at least 32 pixels. Each split region must also be at least 32 × 32 pixels. Processing defaults to a maximum side of 1920 per region, configurable from 640 to 2560. JSON uses schema `"2.0"`; original-photo coordinates refer to the EXIF-oriented image before manual rotation. Rectified coordinates are local to a region.

Paper gestures are accepted only when tracking is valid and less than 400 ms old, with matching capture count, reference dimensions and video dimensions. Coordinates are invalidated on tracking loss, reference changes and lifecycle changes. Word positions are estimated from recognized lines; they are not verified character boxes. Physical pointing precision, lighting, occlusion, heat and long-session performance require device testing.

## Optional Python 3.11 backend

From a source checkout on Windows PowerShell:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m mobile_ocr serve --host 127.0.0.1 --port 8000
```

On macOS/Linux, use `python3.11 -m venv .venv` and `.venv/bin/python` for the remaining commands. Keep the server terminal running.

- Integrated application: `http://127.0.0.1:8000/`
- Independent B photo debugging UI: `http://127.0.0.1:8000/ocr-debug`
- Health/API docs: `/api/health` and `/docs`

For local same-origin use, choose the Python engine and leave the endpoint empty. From GitHub Pages, provide the full HTTPS OCR endpoint, for example `https://your-backend.example/api/ocr`. GitHub Pages does not execute Python. External backends must use HTTPS and allow the page's origin; `FEELYREADER_ALLOWED_ORIGINS` defaults to `https://livia-w.github.io`. See [deployment](docs/DEPLOYMENT.md) for configuration.

Single-photo CLI example:

```powershell
.\.venv\Scripts\python.exe -m mobile_ocr recognize "book.jpg" --rotation 90 --split pages --split-position 0.48 --mode auto --max-side 1920 --output result.json --image-output rectified.jpg
```

Two regions produce `rectified-1.jpg` and `rectified-2.jpg`. See [INTEGRATION.md](docs/INTEGRATION.md) for the raw-image HTTP API and reversible coordinate transforms.

## Build and verify

The `main` branch keeps the source. GitHub Pages publishes the **`gh-pages` branch root**, containing only static runtime files selected by the build script:

```powershell
python -m scripts.build_web --output dist/web
```

Publish the resulting directory contents, including the required `vendor/` runtime and language assets. Do not publish the entire source checkout. See [DEPLOYMENT.md](docs/DEPLOYMENT.md).

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node --test tests/test_browser_ocr.cjs tests/test_reader_controller.cjs tests/test_reading_manager.cjs tests/test_gesture_mapping.cjs tests/test_reader_ui.cjs
node tests/test_photo_ui.cjs
```

Node tests use controlled environments to check contracts, cancellation, coordinate mapping and application state. They do not prove camera accuracy or physical gesture precision. Real browser OCR, permissions and speech must also be checked on the target devices.
