# OCR 与文字地图：B 模块

本项目只负责 **B：照片 OCR、页面校准与文字坐标映射**。输入一张照片，输出中文/英文文字行、基础阅读顺序、文字块，以及每行在原始照片和校正分区中的坐标，供 C/D/E 模块使用。

照片调试页用于检查 B 模块的旋转、分割、校正和定位结果。A 负责图像采集，C 负责手势，D 负责阅读与语音，E 负责应用集成；这些功能由对应模块实现。原有 C++/Qt 工程和防火墙脚本已移出交付目录，本仓库使用独立 Python 实现。

完整字段与坐标约定见 [模块集成契约](docs/INTEGRATION.md)，协作流程见 [贡献指南](CONTRIBUTING.md)。公开仓库为 [Livia-W/ocr-text-map](https://github.com/Livia-W/ocr-text-map)。

## 功能与范围

| 能力 | 实现 |
| --- | --- |
| 文字识别 | RapidOCR + ONNX Runtime，中文/英文印刷文字，CPU 推理 |
| 照片方向校准 | EXIF 方向归一化后，手动顺时针旋转 0、90、180、270 度 |
| 左右分离 | 不分割、左右两页、左右双栏；分割线可手动调整 |
| 页面校正 | 每个分区独立检测页面四边形、透视校正，并尝试轻中度横排文字基线展开 |
| 逐行定位 | 行文本、置信度、阅读顺序、文字块与两个坐标系中的多边形、包围矩形 |
| 基础排版 | 基于几何与空白的行片段合并、分块和阅读顺序启发式 |
| 坐标回映 | 文字行和分区范围回映到原始 EXIF 正向照片，保留变换矩阵与曲面网格 |
| 验证与导出 | 照片上传、校准预览、文字地图检查、TXT/JSON 导出及 CLI 校正图保存 |

## 安装和启动

使用 **Python 3.10、3.11 或 3.12**，在项目根目录执行。

Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m mobile_ocr serve
```

macOS / Linux：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m mobile_ocr serve
```

保持服务终端运行，在同一台电脑打开 <http://127.0.0.1:8000>。默认监听 `127.0.0.1:8000`；关闭终端或按 Ctrl+C 会停止服务。若浏览器提示连接失败，先检查启动终端，再访问 <http://127.0.0.1:8000/api/health>。

固定版本的 RapidOCR 包包含中文/英文 ONNX 模型。第一次识别会初始化模型；`/api/health` 中首次识别前的 `ready: false` 属于正常状态。安装依赖后，常规识别无需云端 OCR 服务。

## 照片校准与检查

1. 选择已有的 JPEG、PNG 或 WebP 照片。
2. 在“校准预览”中检查方向，用旋转按钮使文字方向基本水平。
3. 根据材料选择“不分割”“左右书页”或“左右双栏”。分割位置以旋转后的宽度计算，可调整至 10%–90%；分割后每区宽高至少为 32 像素。
4. 点击“识别文字”。每个分区分别进行缩放、透视/曲面校正和 OCR。
5. 查看原始照片或各校正分区，点击文字行或定位框检查坐标，并按需导出。

输入照片不在上传前缩小或重新编码。原始照片视图按 EXIF 正向显示；上方的手动旋转用于后续校准。调整照片或参数后，重新点击识别以生成对应结果。

左右分区的顺序始终是**旋转后左区在前、右区在后**。左右两页和双栏都只支持两个区域；分割线是人工提供的直线，不会自动寻找书脊或推断栏数。

## 命令行

单页识别：

```powershell
.\.venv\Scripts\python.exe -m mobile_ocr recognize "书页.jpg" --mode auto --output "文字地图.json" --image-output "校正页.jpg"
```

先顺时针旋转 90 度，再按旋转后宽度的 48% 分成左右页：

```powershell
.\.venv\Scripts\python.exe -m mobile_ocr recognize "双页.jpg" --rotation 90 --split pages --split-position 0.48 --max-side 1920 --output "文字地图.json" --image-output "校正页.jpg"
```

两个分区分别保存为 `校正页-1.jpg`、`校正页-2.jpg`。`--split columns` 使用同样的方式分离左右双栏。

| 参数 | 默认值与含义 |
| --- | --- |
| `--rotation` | `0`；顺时针 `0/90/180/270` 度，在分区前应用 |
| `--split` | `none`；`pages` 为左右页，`columns` 为左右双栏 |
| `--split-position` | `0.5`；旋转后宽度的分割比例，范围 `0.1–0.9` |
| `--mode` | `auto`；`none` 只缩放，`perspective` 仅透视，`auto` 另尝试曲面展开 |
| `--min-confidence` | `0.45`；置信度下限，范围 `0–1` |
| `--max-side` | `1920`；**每个分区**的处理最大边，范围 `640–2560`，不放大小图 |
| `--output` | UTF-8 JSON 路径；省略时写入标准输出 |
| `--image-output` | 校正 JPEG 输出路径；多区时自动使用 `-1.jpg`、`-2.jpg` 后缀 |

输入限制：JPEG、PNG、WebP 静态照片；编码文件最多 **8 MiB**，解码后最多 **2000 万像素**，宽高至少 **32 像素**。两区分别处理，`max_side` 不代表整张照片被提前压缩到该尺寸。

## Python 与 HTTP 接口

A 模块可以向 `OCRPipeline.process()` 传入照片编码 bytes，也可以向 `process_image()` 传入已归一化 EXIF 方向的 `uint8` BGR NumPy 图像。代码和 HTTP 示例见 [模块集成契约](docs/INTEGRATION.md)。同一实例一次处理一个请求，调用方等待当前请求结束后再提交下一张照片。

作为其他模块的 Python 依赖集成时，可以在本仓库目录执行 `python -m pip install -e .`，随后从任意工作目录导入 `mobile_ocr`。项目也支持构建 wheel，包含照片调试页静态资源。

启动服务后可访问自动生成的接口说明 <http://127.0.0.1:8000/docs>。

```powershell
curl.exe -X POST "http://127.0.0.1:8000/api/ocr?mode=auto&rotation=90&split=pages&split_position=0.48&max_side=1920" -H "Content-Type: image/jpeg" --data-binary "@双页.jpg" -o "result.json"
```

请求体为原始图片二进制；参数放在查询字符串中，使用下划线命名，如 `split_position`、`max_side`。接口采用 `{"error":"错误说明"}` 返回错误；常见状态为 `400` 图片或校准无效、`413` 文件过大、`415` 内容类型不支持、`422` 查询参数无效、`503` 正忙或引擎不可用。

## 输出和坐标

输出 `schema_version` 为字符串 **`"2.0"`**，以 `document_id` 区分每次处理。C/D/E 使用 `document_id`、`regions`、`lines`、`blocks` 进行对接。

| 字段 | 含义 |
| --- | --- |
| `source_size` | 原始 EXIF 正向照片的 `[width, height]` |
| `rotated_size` | 手动旋转后的整张照片尺寸 |
| `calibration` | `rotation_clockwise`、`split`、`split_position` 校准参数 |
| `regions[]` | 分区信息、校正图、裁剪范围、行编号和几何变换 |
| `lines[].region_id` | 该行属于哪个校正分区 |
| `lines[].polygon_source / bbox_source` | 原始 EXIF 正向照片坐标，已回映手动旋转、裁剪、透视及曲面展开 |
| `lines[].polygon_rectified / bbox_rectified` | 该行所属分区的校正图局部坐标 |
| `blocks[]` | 带 `region_id` 的启发式文字块及所属行 |
| `text` | 按输出阅读顺序组合的文本 |

坐标原点为左上角，x 向右、y 向下；单位为像素；矩形为 `[x, y, width, height]`。跨分区叠加文字框时使用 `polygon_source`。查看校正图时，先按 `region_id` 找到对应 `regions[]`，再使用局部 `polygon_rectified`。

顶层的 `rectified_image`、`rectified_size`、`transform` 为兼容字段，只对应**第一分区**。多分区消费方应使用 `regions[]`；不能用第一分区的变换解释另一分区的校正坐标。曲面展开为非线性变换，完整回映需要曲面网格和透视逆矩阵共同作用，详见集成契约。

## 验证

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node tests/test_photo_ui.cjs
```

Python 测试验证校准、几何、排版、处理流程与 HTTP 契约；Node 检查照片调试页的交互。Node 仅用于前端测试，不是 Python 服务的运行依赖。

可选的真实中文模型检查：

```powershell
.\.venv\Scripts\python.exe -m scripts.verify_chinese
```

该工具生成测试文字并运行真实 OCR；输出写入 `outputs/chinese-demo/`。默认字体不可用时，传入 `--font "中文字体路径.ttf"`。本地输出和个人照片不提交到仓库。

## 当前限制

- 方向和左右分割由用户指定；当前只处理左右两页或两栏。
- 各区页框检测需要足够清晰的边界；证据不足时保留区域范围并返回提示。
- 曲面展开基于至少三条可靠、覆盖足够宽度且弯曲方向一致的横排文字基线，适合轻中度弯曲的印刷页。它不恢复真实三维表面、遮挡、严重书脊折痕或强烈卷曲。
- 曲面和排版采用启发式。规律弯曲的非文字图案可能误触发；标题、表格、图文混排和复杂阅读顺序需要检查。当前没有语义版式模型。
- 输出粒度为文字行；不提供逐字坐标、持久跟踪、跨照片定位或地图拼接。
- 繁体、竖排、手写、反光及模糊照片的效果需要用目标材料验证。

## 目录

```text
mobile_ocr/
  calibration.py  旋转、左右分区与照片坐标变换
  geometry.py     每区透视、曲面展开与双向映射
  engine.py       中文/英文 OCR 引擎适配
  layout.py       行片段合并、分块与阅读顺序
  pipeline.py     B 模块处理流程与文字地图契约
  server.py       照片 API 与调试页服务
  __main__.py     CLI
  static/         照片校准与定位检查页面
docs/             模块集成契约
tests/            Python 与照片页面测试
scripts/          中文 OCR 验证工具
```

旧工程的本地备份为 `.local-backups/legacy-before-module-b.zip`，该目录被忽略，不属于公开交付内容。
