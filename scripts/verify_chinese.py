"""Generate a Chinese test page and exercise the actual OCR pipeline.

Run from the repository root: python -m scripts.verify_chinese
Pass --font /path/to/a/chinese/font.ttf when no system font is found.
"""

import argparse
import json
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont

from mobile_ocr.pipeline import OCRPipeline


def main():
    parser = argparse.ArgumentParser(description="生成中文测试页并验证真实 OCR 模型和坐标地图")
    parser.add_argument("--font", type=Path, help="包含中文字形的 TTF/TTC/OTF 字体")
    parser.add_argument("--output-dir", type=Path, default=Path("outputs/chinese-demo"))
    args = parser.parse_args()
    candidates = [args.font] if args.font else [
        Path("C:/Windows/Fonts/msyh.ttc"),
        Path("/System/Library/Fonts/PingFang.ttc"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    ]
    font_path = next((p for p in candidates if p and p.is_file()), None)
    if font_path is None:
        parser.error("未找到中文字体，请用 --font 指定中文 TTF/TTC/OTF 字体。")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (1000, 650), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(font_path), 36)
    texts = ["中文印刷文字识别", "输入照片与文字坐标映射", "逐行定位与页面曲面校正", "Chinese OCR 2026"]
    for index, text in enumerate(texts):
        draw.text((70, 60 + index * 100), text, font=font, fill="black")
    source_path = args.output_dir / "chinese.png"
    image.save(source_path)
    result = OCRPipeline().process(source_path.read_bytes(), mode="auto")
    recognized = result["text"].replace(" ", "")
    missing = [text for text in texts if text.replace(" ", "") not in recognized]
    result_path = args.output_dir / "text-map.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    if missing:
        raise SystemExit("OCR 验证失败，未找到：" + ", ".join(missing))
    # A sideways photo of two pages must be rotated before separation. This
    # exercises the real models as well as the complete source-coordinate chain.
    right = Image.new("RGB", image.size, "white")
    right_texts = ["右页独立文字识别", "左右书页分离校准", "旋转之后坐标仍然准确", "Right page 2026"]
    right_draw = ImageDraw.Draw(right)
    for index, text in enumerate(right_texts):
        right_draw.text((70, 60 + index * 100), text, font=font, fill="black")
    spread = Image.new("RGB", (image.width * 2, image.height), "white")
    spread.paste(image, (0, 0))
    spread.paste(right, (image.width, 0))
    sideways = spread.transpose(Image.Transpose.ROTATE_90)
    spread_path = args.output_dir / "two-pages-sideways.png"
    sideways.save(spread_path)
    spread_result = OCRPipeline().process(
        spread_path.read_bytes(), mode="none", rotation=90, split="pages")
    if len(spread_result["regions"]) != 2:
        raise SystemExit("双页验证失败：未产生左右两个区域。")
    for region, expected_texts in zip(spread_result["regions"], (texts, right_texts)):
        recognized_region = "".join(line["text"] for line in spread_result["lines"]
                                    if line["region_id"] == region["id"]).replace(" ", "")
        missing_region = [text for text in expected_texts if text.replace(" ", "") not in recognized_region]
        if missing_region:
            raise SystemExit(f"双页验证失败（{region['label']}）：" + ", ".join(missing_region))
    (args.output_dir / "two-pages-text-map.json").write_text(
        json.dumps(spread_result, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print("真实中文/英文 OCR 验证通过：")
    print(result["text"])
    print(f"{len(result['lines'])} 行，处理 {result['timing_ms']['total']} ms")
    print(f"测试页：{source_path}\n文字地图：{result_path}")
    print(f"90° 旋转与双页真实 OCR 验证通过：{len(spread_result['lines'])} 行")


if __name__ == "__main__":
    main()
