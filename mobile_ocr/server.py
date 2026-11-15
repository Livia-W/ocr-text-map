"""Local photo OCR API and its browser debugging interface."""

from enum import IntEnum
import os
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.requests import ClientDisconnect

from . import __version__
from .pipeline import BusyError, OCRPipeline, OCRRuntimeError


MAX_IMAGE_BYTES = 8 * 1024 * 1024
STATIC_DIRECTORY = Path(__file__).resolve().parent / "static"
WEB_DIRECTORY = Path(__file__).resolve().parent.parent
WEB_ASSETS = {
    "index.html", "styles.css", "app.js", "camera.js", "opencv-loader.js",
    "page-detector.js", "page-output.js", "page-content.js", "stability.js", "live-bridge.js",
    "gesture-engine.js", "reading_manager.js", "browser-ocr.js", "reader-controller.js", "e-app.js",
}
ACCEPTED_CONTENT_TYPES = {
    "image/jpeg", "image/png", "image/webp", "application/octet-stream", "",
}


class ClockwiseRotation(IntEnum):
    NONE = 0
    QUARTER = 90
    HALF = 180
    THREE_QUARTERS = 270


def _error(message: str, status_code: int) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status_code)


def create_app(pipeline: Any = None) -> FastAPI:
    """Create the service without loading OCR models or downloading weights."""
    app = FastAPI(title="照片 OCR 与版面分析调试", version=__version__)
    app.state.pipeline = pipeline if pipeline is not None else OCRPipeline()
    allowed_origins = [origin.strip() for origin in os.getenv(
        "FEELYREADER_ALLOWED_ORIGINS", "https://livia-w.github.io").split(",") if origin.strip()]
    if allowed_origins:
        app.add_middleware(CORSMiddleware, allow_origins=allowed_origins,
                           allow_methods=["GET", "POST"], allow_headers=["Content-Type"],
                           allow_credentials=False)

    @app.middleware("http")
    async def prevent_caching(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "public, max-age=86400" if request.url.path.startswith("/vendor/") else "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        fields = sorted({str(item["loc"][-1]) for item in exc.errors()})
        return _error("请求参数不正确：" + "、".join(fields), 422)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        if exc.status_code == 404:
            return _error("请求的资源不存在。", 404)
        if exc.status_code == 405:
            return _error("此地址不支持当前请求方法。", 405)
        return _error("请求未能完成。", exc.status_code)

    @app.get("/api/health")
    async def health():
        return {
            "status": "ok",
            "engine": "rapidocr",
            "ready": app.state.pipeline.ready,
            "version": __version__,
        }

    @app.post(
        "/api/ocr",
        summary="识别一张照片",
        description="请求体为 JPEG、PNG 或 WebP 原始二进制，最大 8 MiB。先顺时针旋转，再按旋转后宽度比例分区；每个分区独立校正和识别。",
        openapi_extra={
            "requestBody": {
                "required": True,
                "content": {
                    kind: {"schema": {"type": "string", "format": "binary"}}
                    for kind in ("image/jpeg", "image/png", "image/webp")
                },
            }
        },
    )
    async def recognize(
        request: Request,
        mode: Literal["none", "perspective", "auto"] = "auto",
        min_confidence: float = Query(default=0.45, ge=0, le=1),
        max_side: int = Query(default=1920, ge=640, le=2560, description="每个分区处理图像的最大边长（像素）"),
        rotation: ClockwiseRotation = Query(default=ClockwiseRotation.NONE, description="顺时针旋转角度"),
        split: Literal["none", "pages", "columns"] = Query(default="none", description="不分区、左右页或左右双栏"),
        split_position: float = Query(default=0.5, ge=0.1, le=0.9, description="分界线在旋转后图像宽度上的比例"),
    ):
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type not in ACCEPTED_CONTENT_TYPES:
            return _error("请发送 JPEG、PNG 或 WebP 图像的原始二进制数据。", 415)

        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                length = int(content_length)
            except ValueError:
                return _error("图像数据长度无效。", 400)
            if length < 0:
                return _error("图像数据长度无效。", 400)
            if length > MAX_IMAGE_BYTES:
                return _error("原始照片不能超过 8 MiB，请压缩图片后重试。", 413)

        body = bytearray()
        try:
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_IMAGE_BYTES:
                    return _error("原始照片不能超过 8 MiB，请压缩图片后重试。", 413)
                body.extend(chunk)
        except ClientDisconnect:
            return _error("图像上传已中断，请重新上传照片。", 400)
        if not body:
            return _error("图像数据为空，请选择照片后重试。", 400)

        try:
            result = await run_in_threadpool(
                app.state.pipeline.process,
                bytes(body),
                mode=mode,
                min_confidence=min_confidence,
                max_side=max_side,
                rotation=int(rotation),
                split=split,
                split_position=split_position,
            )
        except BusyError:
            return _error("上一张照片仍在处理中，请稍后重试。", 503)
        except ValueError as exc:
            return _error(str(exc) or "图像数据无效，请重新上传照片。", 400)
        except OCRRuntimeError as exc:
            return _error(str(exc) or "识别引擎暂时不可用，请检查依赖和模型。", 503)
        return JSONResponse(result)

    @app.get("/", include_in_schema=False)
    async def index():
        if (WEB_DIRECTORY / "index.html").is_file():
            return FileResponse(WEB_DIRECTORY / "index.html")
        index_path = STATIC_DIRECTORY / "index.html"
        if not index_path.is_file():
            return _error("照片调试页面文件缺失，请检查安装目录。", 503)
        return FileResponse(index_path)

    app.mount("/static", StaticFiles(directory=STATIC_DIRECTORY, check_dir=False), name="static")

    @app.get("/ocr-debug", include_in_schema=False)
    async def debug_index():
        return FileResponse(STATIC_DIRECTORY / "index.html")

    @app.get("/{asset_path:path}", include_in_schema=False)
    async def web_asset(asset_path: str):
        # Never mount the repository root: .env, .git and local outputs must not
        # become public when the optional Python server serves the application.
        if asset_path in WEB_ASSETS:
            path = WEB_DIRECTORY / asset_path
        elif asset_path.startswith("vendor/"):
            path = (WEB_DIRECTORY / asset_path).resolve()
            vendor = (WEB_DIRECTORY / "vendor").resolve()
            if not path.is_relative_to(vendor) or any(part.startswith(".") for part in Path(asset_path).parts):
                return _error("请求的资源不存在。", 404)
        else:
            return _error("请求的资源不存在。", 404)
        return FileResponse(path) if path.is_file() else _error("请求的资源不存在。", 404)
    return app


app = create_app()
