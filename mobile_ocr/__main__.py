"""Chinese command-line entry point: python -m mobile_ocr."""

import argparse
import base64
import binascii
import json
from pathlib import Path
import sys

from . import __version__


def _confidence(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("置信度必须是 0 到 1 之间的数字。") from exc
    if not 0 <= parsed <= 1:
        raise argparse.ArgumentTypeError("置信度必须在 0 到 1 之间。")
    return parsed


def _max_side(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("最大边长必须是整数。") from exc
    if not 640 <= parsed <= 2560:
        raise argparse.ArgumentTypeError("最大边长必须在 640 到 2560 像素之间。")
    return parsed


def _split_position(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("分界线位置必须是 0.1 到 0.9 之间的数字。") from exc
    if not 0.1 <= parsed <= 0.9:
        raise argparse.ArgumentTypeError("分界线位置必须在 0.1 到 0.9 之间。")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m mobile_ocr", description="中文照片 OCR、分区与页面校正", add_help=False)
    parser.add_argument("-h", "--help", action="help", help="显示帮助信息并退出")
    parser.add_argument("--version", action="version", version=__version__, help="显示版本号并退出")
    subparsers = parser.add_subparsers(dest="command", required=True, title="命令")

    serve = subparsers.add_parser("serve", help="启动照片调试页面与识别 API 开发服务", add_help=False)
    serve.add_argument("-h", "--help", action="help", help="显示帮助信息并退出")
    serve.add_argument("--host", default="127.0.0.1", help="监听地址，局域网使用 0.0.0.0")
    serve.add_argument("--port", type=int, default=8000, help="监听端口，默认 8000")
    serve.add_argument("--ssl-certfile", type=Path, help="HTTPS 证书文件")
    serve.add_argument("--ssl-keyfile", type=Path, help="HTTPS 私钥文件，需与证书同时提供")

    recognize = subparsers.add_parser("recognize", help="识别单张照片并导出结果 JSON", add_help=False)
    recognize.add_argument("-h", "--help", action="help", help="显示帮助信息并退出")
    recognize.add_argument("image", type=Path, help="待识别图片，可使用中文路径")
    recognize.add_argument("--output", type=Path, help="JSON 输出文件；省略时输出到标准输出")
    recognize.add_argument("--image-output", type=Path, help="保存校正后的 JPEG；多分区输出为文件名-1.jpg、文件名-2.jpg")
    recognize.add_argument("--mode", choices=("none", "perspective", "auto"), default="auto", help="校正方式：关闭、透视、自动曲面校正")
    recognize.add_argument("--min-confidence", type=_confidence, default=0.45, help="最低识别置信度，范围 0 到 1")
    recognize.add_argument("--max-side", type=_max_side, default=1920, help="每个分区处理图像最大边长，范围 640 到 2560")
    recognize.add_argument("--rotation", type=int, choices=(0, 90, 180, 270), default=0, help="顺时针旋转角度，分区前执行")
    recognize.add_argument("--split", choices=("none", "pages", "columns"), default="none", help="分区方式：不分区、左右页、左右双栏")
    recognize.add_argument("--split-position", type=_split_position, default=0.5, help="分界线在旋转后图像宽度上的比例，范围 0.1 到 0.9")
    return parser


def _rectified_bytes(result: dict) -> bytes:
    image = result.get("rectified_image")
    if not isinstance(image, str) or not image:
        raise ValueError("识别结果未包含校正图像，无法保存图片。")
    if image.startswith("data:"):
        header, separator, image = image.partition(",")
        if not separator or ";base64" not in header:
            raise ValueError("识别结果中的校正图像格式无效。")
    try:
        return base64.b64decode(image, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("识别结果中的校正图像编码无效。") from exc


def _image_outputs(result: dict, destination: Path) -> list[tuple[Path, bytes]]:
    regions = result.get("regions")
    if regions is None or regions == []:
        return [(destination, _rectified_bytes(result))]
    if not isinstance(regions, list) or any(not isinstance(region, dict) for region in regions):
        raise ValueError("识别结果中的分区图像格式无效。")
    if len(regions) == 1:
        return [(destination, _rectified_bytes(regions[0]))]
    return [
        (destination.with_name(f"{destination.stem}-{index}.jpg"), _rectified_bytes(region))
        for index, region in enumerate(regions, 1)
    ]


def main(argv: list[str] | None = None) -> int:
    # Use UTF-8 for redirected output as well as Windows console sessions.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "serve":
        if bool(args.ssl_certfile) != bool(args.ssl_keyfile):
            parser.error("--ssl-certfile 和 --ssl-keyfile 必须同时提供。")
        if not 1 <= args.port <= 65535:
            parser.error("端口必须在 1 到 65535 之间。")
        for file_path in (args.ssl_certfile, args.ssl_keyfile):
            if file_path is not None and not file_path.is_file():
                parser.error(f"HTTPS 文件不存在：{file_path}")
        try:
            import uvicorn

            from .server import create_app

            uvicorn.run(
                create_app(),
                host=args.host,
                port=args.port,
                ssl_certfile=str(args.ssl_certfile) if args.ssl_certfile else None,
                ssl_keyfile=str(args.ssl_keyfile) if args.ssl_keyfile else None,
            )
        except (ImportError, OSError, RuntimeError) as exc:
            print(f"服务启动失败：{exc}", file=sys.stderr)
            return 1
        return 0

    try:
        from .pipeline import OCRPipeline, OCRRuntimeError
    except ImportError as exc:
        print(f"识别依赖不可用，请先安装 requirements.txt：{exc}", file=sys.stderr)
        return 1
    try:
        encoded = args.image.read_bytes()
        result = OCRPipeline().process(
            encoded,
            mode=args.mode,
            min_confidence=args.min_confidence,
            max_side=args.max_side,
            rotation=args.rotation,
            split=args.split,
            split_position=args.split_position,
        )
        serialized = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
        images = _image_outputs(result, args.image_output) if args.image_output else []
        if args.output:
            args.output.write_text(serialized, encoding="utf-8")
            print(f"已保存识别结果：{args.output}", file=sys.stderr)
        else:
            sys.stdout.write(serialized)
        for image_path, image_bytes in images:
            image_path.write_bytes(image_bytes)
            print(f"已保存校正图像：{image_path}", file=sys.stderr)
    except (OSError, ValueError, OCRRuntimeError) as exc:
        print(f"识别失败：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
