# B 模块集成契约

B 将一张照片转换为带坐标的文字地图。模块边界如下：

| 模块 | 负责范围 | 与 B 的关系 |
| --- | --- | --- |
| A：采集 | 取得照片或已归一化方向的图像 | 向 B 提供照片 bytes 或 BGR 数组 |
| B：OCR 与文字地图 | 方向/分区校准、每区校正、OCR、文字行和基础阅读顺序 | 输出本契约中的文档结果 |
| C：手势 | 手势检测与选区逻辑 | 消费 `document_id`、原始照片坐标及文字行 |
| D：阅读 | 阅读状态、语音与交互策略 | 消费阅读顺序、文字行和文字块 |
| E：应用 | 屏幕、文件与模块编排 | 显示照片/分区，负责屏幕坐标换算和调用生命周期 |

仓库附带照片调试页用于验证 B 的输入输出。其他模块通过 Python 接口或 HTTP 接口对接。

## 1. 输入

### 编码照片 bytes

```python
from pathlib import Path
from mobile_ocr.pipeline import OCRPipeline

pipeline = OCRPipeline()
result = pipeline.process(
    Path("双页.jpg").read_bytes(),
    mode="auto",
    min_confidence=0.45,
    max_side=1920,
    rotation=90,
    split="pages",
    split_position=0.48,
)
```

支持 JPEG、PNG、WebP 静态照片，最多 8 MiB、2000 万像素，宽高至少 32 像素。B 会先按 EXIF 归一化方向，再执行显式校准。返回的原始照片坐标以 **EXIF 正向后的图像**为基准，而不是 JPEG 文件可能存储的横向像素排列。

### BGR NumPy 图像

```python
import numpy as np
from mobile_ocr.pipeline import OCRPipeline

# A 提供的 frame 必须已经按显示方向归一化；此处仅示意形状。
frame = np.full((1200, 1600, 3), 255, dtype=np.uint8)
pipeline = OCRPipeline()
result = pipeline.process_image(
    frame,
    rotation=0,
    split="columns",
    split_position=0.5,
    mode="auto",
    max_side=1920,
)
```

数组必须是 `uint8`、`height × width × 3`、BGR 通道顺序，宽高至少 32 像素，最多 2000 万像素。NumPy 输入没有 EXIF 元数据；A 应在调用前完成方向归一化。8 MiB 限制针对编码照片，不限制合法解码数组的内存字节数。B 会复制数组作为本次处理的快照。

建议在进程内复用一个 `OCRPipeline`，以复用模型。一次只提交一张照片，同一实例忙时抛出 `BusyError`；输入无效时抛出 `ValueError`，模型初始化或推理失败时抛出 `OCRRuntimeError`。

## 2. 校准与处理顺序

1. 解码并归一化 EXIF 方向，或验证 A 提供的 BGR 数组。
2. 按 `rotation` 顺时针旋转整张照片。
3. 按旋转后宽度的 `split_position` 拆成左右两个区域，或保留整张。
4. 每区独立缩放、检测页框、透视校正，并根据 `mode` 尝试曲面展开。
5. 每区 OCR、合并行片段、分析基础阅读顺序，最后组合为文档结果并回映照片坐标。

| 参数 | 默认值 | 有效值与语义 |
| --- | --- | --- |
| `rotation` | `0` | 顺时针 `0/90/180/270`，分区前应用 |
| `split` | `none` | `none` 整张；`pages` 左右两页；`columns` 左右双栏 |
| `split_position` | `0.5` | `0.1–0.9`，相对于旋转后整张宽度 |
| `mode` | `auto` | `none` 只缩放；`perspective` 透视；`auto` 透视并尝试基线展开 |
| `min_confidence` | `0.45` | `0–1` |
| `max_side` | `1920` | `640–2560`，每个分区的处理最大边，不放大小图 |

`pages` 和 `columns` 都使用一条人工指定的纵向分割线。分割边界为 `round(rotated_width * split_position)`；左右两区完整覆盖旋转后的图像且不重叠。每区宽高至少 32 像素。返回顺序为旋转后左区、右区，区内采用横排阅读顺序启发式。

## 3. HTTP

本地运行：

```bash
python -m mobile_ocr serve
```

`GET /api/health` 返回服务状态、引擎、版本和 `ready`。该请求不会触发模型加载。

`POST /api/ocr` 使用图片原始二进制作为请求体，参数位于查询字符串：

```bash
curl -X POST 'http://127.0.0.1:8000/api/ocr?rotation=90&split=pages&split_position=0.48&mode=auto&min_confidence=0.45&max_side=1920' \
  -H 'Content-Type: image/jpeg' \
  --data-binary '@book.jpg' \
  -o result.json
```

PowerShell 使用 `curl.exe`，或参考中文 README 中的单行示例。`Content-Type` 可为 `image/jpeg`、`image/png`、`image/webp`；请求体直接传图片 bytes。接口说明位于 `/docs`。

| 状态 | 含义 | 调用方处理 |
| --- | --- | --- |
| `200` | 已完成，返回文档结果 | 检查文字、几何回退和区域信息 |
| `400` | 图片损坏、格式/尺寸或校准参数不符合要求 | 修正输入 |
| `413` | 请求体超过 8 MiB | 压缩编码图片后重新提交 |
| `415` | 请求内容类型不支持 | 使用受支持的图片内容类型 |
| `422` | 查询参数无效 | 修正参数范围或枚举 |
| `503` | 实例正忙，或 OCR 引擎不可用 | 忙时等待并退避重试；引擎故障时检查服务日志 |

错误响应形如 `{"error":"说明"}`。调用方应等待当前识别完成；该接口不提供后台任务队列或持久任务记录。

## 4. 输出结构

消费方以 `document_id`、`regions`、`lines`、`blocks` 作为集成入口。辅助字段用于校验、导出和调试。

| 顶层字段 | 含义 |
| --- | --- |
| `schema_version` | 输出结构版本，值为字符串 `"2.0"` |
| `document_id` | 本次处理结果的标识 |
| `source_size` | EXIF 正向原始照片的 `[width, height]` |
| `rotated_size` | 显式校准旋转后整张照片尺寸 |
| `calibration` | `{rotation_clockwise, split, split_position}` |
| `regions` | 校正分区列表 |
| `lines` | 全文文字行，包含分区关联和阅读顺序 |
| `blocks` | 文字块，包含分区关联和所属行 |
| `text` | 按输出阅读顺序组合的文本 |
| `coordinates` | 本结果的坐标约定，见下方示例 |
| `warnings` | 页框、曲面等回退和局限提示 |
| `timing_ms` | 解码、几何、OCR、总耗时，单位毫秒 |

`coordinates` 的内容为：

```json
{
  "unit": "pixel",
  "origin": "top-left",
  "x_axis": "right",
  "y_axis": "down",
  "bbox_format": "x,y,width,height",
  "source_orientation": "EXIF-transposed",
  "scope": "single-photo",
  "text_location_level": "line",
  "rectified_space": "region-local"
}
```

对 NumPy 输入，`source_orientation` 表示调用方已归一化的方向约定，B 不再从数组读取 EXIF。

### 分区 `regions[]`

| 字段 | 含义 |
| --- | --- |
| `id` | `page-1/page-2` 或 `column-1/column-2`；未拆分时为 `page-1` |
| `label` | 分区中文标签 |
| `kind` | `page` 或 `column` |
| `rectified_size` | 本分区校正图的 `[width, height]` |
| `rectified_image` | 本分区校正 JPEG 的 data URL |
| `polygon_source` | 旋转后裁剪分区的四角回映到原始照片；表示裁剪范围 |
| `line_ids` | 属于本分区的全局行编号 |
| `calibration` | 旋转、裁剪范围及照片↔分区的校准元数据 |
| `transform` | 原始照片↔本区透视平面与曲面校正图的几何变换 |
| `warnings` | 本区页框、曲面或识别提示 |

分区的 `polygon_source` 表示校准裁剪覆盖范围，自动页框校正可能在该范围内进一步裁剪。`calibration.bounds_rotated` 格式为 `[x, y, width, height]`，指旋转后整张照片中的裁剪区域；其 `source_size`、`rotated_size`、`region_size` 都是 `[width, height]`。

### 文字行 `lines[]`

| 字段 | 含义 |
| --- | --- |
| `id` | 本文档结果内唯一的 `line-N` 编号 |
| `region_id` | 所属分区 `regions[].id` |
| `block_id` | 所属文字块编号 |
| `reading_order` | 从 1 开始的全文阅读顺序 |
| `text` | 行文本 |
| `confidence` | 行识别置信度 |
| `polygon_source` | 原始 EXIF 正向照片上的边缘采样多边形 |
| `bbox_source` | 上述多边形的包围矩形 |
| `polygon_rectified` | 所属分区校正图中的局部识别四边形 |
| `bbox_rectified` | 上述四边形的包围矩形 |

### 文字块 `blocks[]`

块包含本文档内唯一的 `id`、`region_id`、`type`、`line_ids`、`bbox` 和 `coordinate_space`。`type` 为启发式 `heading` 或 `text`；`bbox` 在该分区校正图中，`coordinate_space` 为 `"rectified"`。块类别和排列来自几何启发式，不是语义结构标注。

编号的作用域是本次 `document_id`。另一张照片或同一照片重跑后产生的新结果，行编号不能用作持久文字锚点。消费方可使用 `(document_id, line_id)` 标识一次结果中的文字行。

### 兼容字段

顶层 `rectified_image`、`rectified_size`、`transform` 仅对应 `regions[0]`，供旧的单区消费方过渡。多区调用方应明确使用 `regions[]`，并通过 `line.region_id` 选择图像和变换。旧的 `frame_id` 已移除，统一使用 `document_id`。

## 5. 坐标约定与回映

所有几何坐标的原点为左上角，x 向右、y 向下，单位为像素。尺寸表示为 `[width, height]`，包围矩形表示为 `[x, y, width, height]`。

| 坐标空间 | 基准 |
| --- | --- |
| `source` | EXIF 正向、尚未进行手动旋转的原始照片 |
| `rotated` | 用户顺时针旋转后的整张照片 |
| 区域校准坐标 | `rotated` 中的裁剪区局部坐标 |
| 透视平面 | 每区缩放和透视校正后的平面 |
| `rectified` | 每区曲面展开后的校正图局部坐标 |

原始照片叠加或跨区查找使用 `polygon_source`。区内校正图叠加使用 `polygon_rectified`，并按 `region_id` 选择分区。E 应自行处理图像显示时的缩放、留白和屏幕坐标；B 的坐标不包含显示布局、设备像素比或手势屏幕坐标。

### 校准矩阵

`regions[].calibration` 中的 `source_to_region_matrix` 已组合顺时针旋转与裁剪平移；`region_to_source_matrix` 为其逆矩阵。90 度顺时针的像素映射是 `x' = source_height - 1 - y, y' = x`。

### 透视与曲面变换

`regions[].transform.source_to_page_matrix` 已组合 **原始照片旋转、裁剪、缩放和透视校正**，直接将原始照片坐标映射到该区透视平面。`page_to_source_matrix` 为其逆矩阵，不能再叠加一次校准旋转或裁剪。

变换中的 `source_size` 是原始照片尺寸，`region_source_size` 是旋转裁剪后的本区尺寸，`rectified_size` 是本区校正图尺寸。`perspective_applied`、`curvature_applied` 表示实际是否执行相应校正；返回的 `warnings` 说明回退情况。

`curvature_mesh` 为校正图到透视平面的纵向逆映射，未做曲面校正时为 `null`：

1. 对校正图中的点 `(x, y)`，在 `mesh.x` 上对每一行 `mesh.source_y` 插值，得到该 x 位置的各条原始基线高度。
2. 以 `mesh.target_y` 为节点，对 y 分段线性插值，得到透视平面中的 `y_page`；x 不变。
3. 对 `(x, y_page, 1)` 应用 `page_to_source_matrix`，并除以齐次坐标，得到原始照片中的点。

没有曲面网格时跳过前两步。正向变换先应用 `source_to_page_matrix`，再反解该单调纵向网格。曲面变换是非线性的，不能只靠一个 3×3 矩阵完成。

B 已为文字行生成回映后的边缘采样多边形。消费方绘制 `polygon_source` 时保留全部顶点；只映射四个角会把弯曲边界错误画成直线。

## 6. 集成检查

- A 与 E 使用和 `source_size` 相同的 EXIF 正向照片，避免重复应用 EXIF 或手动旋转。
- C 在同一份照片坐标中查找 `polygon_source`，使用 `document_id` 防止串用另一张照片的行。
- D 按 `reading_order` 和 `line_ids` 处理本文档文字，不把行编号当作跨照片追踪标识。
- E 按 `region_id` 选择校正图与局部坐标，并展示需要用户检查的回退提示。
- 联调样本应覆盖单页、90 度旋转、非中点双页/双栏、页框不清晰和曲面证据不足的情况。

当前范围为左右两页/两栏、横排印刷文字和轻中度曲面；没有逐字坐标、语义版式模型、手势、语音或持久跟踪。照片调试页是 B 的验证入口，最终应用行为由 E 编排。
