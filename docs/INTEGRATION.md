# FeelyReader 集成契约

入口为仓库根目录 `index.html`。A、B、C、D 由 `reader-controller.js` 编排，`e-app.js` 提供 E 界面；Python 是可选后端。默认静态入口为 <https://livia-w.github.io/ocr-text-map/>，部署约定见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 1. 模块与生命周期

| 模块 | 接口与职责 |
| --- | --- |
| A | `window.BookReader`、`bookreader:captured`、`bookreader:page-updated`；相机、透视参考图及实时跟踪 |
| B 浏览器 | `window.FeelyBrowserOCR`；Tesseract.js `chi_sim+eng`，输出文字行和照片坐标 |
| B Python | `OCRPipeline.process()` / `process_image()`、`POST /api/ocr`；完整照片校正与 RapidOCR |
| C | `window.GestureEngine`；复用 A 视频，消费参考坐标中的文字行 |
| D | `window.ReadingManager`；语音、进度、高亮、历史和反馈 |
| E | 选择照片/引擎/参数/页面，展示结果，管理取消、旧结果和手势权限 |

修改输入、参数或参考时，整合控制器取消旧识别并使旧回调失效。结果只能更新与它对应的输入；切页、手动暂停和失去跟踪时清除待点读词。浏览器 OCR 同时只运行一个任务，成功任务复用 worker，取消会终止当前 worker，后续请求重新初始化。

## 2. A：照片与参考跟踪

```javascript
window.addEventListener('bookreader:captured', event => {
  const { blob, width, height, pages, metadata } = event.detail;
  // blob: 完整原始 JPEG。
  // pages: 每页 {blob, pageId, label, width, height, points, matrix, evidence}。
  // metadata.captureCount 标识本次参考采集批次。
});

const video = window.BookReader.getVideoElement();
const stopFrames = window.BookReader.subscribeVideoFrames(frame => {
  // frame.type 为 frame 或 state；视频元素是实时对象，不是冻结快照。
});
const stopTracking = window.BookReader.subscribePageTracking(envelope => {
  // envelope.pages[] 提供 pageId、valid、referenceCaptureCount、timestamp、
  // referenceSize、videoSize、currentVideoToReference、referenceToCurrentVideo。
});
// 页面退出或销毁控制器时调用 stopFrames()、stopTracking()。
```

`pages[].points` 是完整原图像素中的 TL/TR/BR/BL；`pages[].matrix` 为按行存储的 9 个数，将完整原图映射到该透视参考图。A 生成的是平面透视图，不代表已执行非线性曲面校正。

当前整合路径对每个 `pages[].blob` 单独识别，并固定 `rotation:0`、`split:none`，不再次拆分相机参考图。E 一次选择一个参考页，通过下拉列表切换。照片上传路径可以使用手动旋转及左右页/栏分区。

跟踪矩阵也为 9 个数：`referenceToCurrentVideo` 将参考页像素映射到当前视频固有像素；`currentVideoToReference` 为反向。对 `[x,y,1]` 乘矩阵后除以第三分量。跟踪 `timestamp` 使用 `performance.now()` 毫秒，不能与日志事件的 Unix 秒混用。

C 接受跟踪前必须同时满足：

- `valid` 为真，跟踪年龄小于 400 ms。
- `referenceCaptureCount` 等于所选参考的采集次数。
- `referenceSize` 与该参考尺寸一致，`videoSize` 与当前视频尺寸一致。
- 两个矩阵均可用，当前选择仍对应该参考页。

跟踪失效、后台、相机停止或参考切换时，停止点读并清除旧标记。上传照片或导入 JSON 没有这些 A 参考条件，不能用静态照片假设实时纸面坐标仍然有效。进一步的 A 字段说明见 [A_HANDOFF.md](../A_HANDOFF.md)。

## 3. B：两种运行方式

### 默认浏览器 OCR

```javascript
const ocr = new FeelyBrowserOCR();
const cancel = new AbortController();
const result = await ocr.recognize(photoBlob, {
  rotation: 90, split: 'pages', split_position: 0.48,
  mode: 'auto', max_side: 1920, min_confidence: 0.45
}, {
  signal: cancel.signal,
  onProgress: fraction => console.log(fraction) // 0..1
});
// cancel.abort() 取消；页面销毁时 ocr.destroy()。
```

Tesseract.js 6.0.1 真实加载 `chi_sim+eng` 并读取 `blocks → paragraphs → lines`，不是只输出文本。浏览器支持 EXIF 正向解码、顺时针旋转、左右分区和每区缩放。`mode: auto/perspective` 会明确提示未执行 B 内部的透视或曲面校正；`perspective_applied`、`curvature_applied` 为假，`curvature_mesh` 为 null。A 已提供的透视参考可以直接作为 B 输入。

### 可选 Python

```python
from pathlib import Path
from mobile_ocr.pipeline import OCRPipeline

pipeline = OCRPipeline()  # 建议在进程内复用
result = pipeline.process(
    Path('双页.jpg').read_bytes(),
    rotation=90, split='pages', split_position=0.48,
    mode='auto', max_side=1920, min_confidence=0.45,
)
```

也可调用 `pipeline.process_image(image, **options)`：`image` 必须是已按显示方向归一化的 `uint8`、`height × width × 3` BGR NumPy 数组。B 会复制数组；数组没有 EXIF，调用方不得期待 B 再次自动修正方向。

编码输入支持 JPEG/PNG/WebP，最大 8 MiB、2000 万像素，宽高至少 32 像素。8 MiB 限制针对编码照片，不限制合法解码数组的内存字节数。Python 实例忙时抛 `BusyError`，无效输入抛 `ValueError`，模型初始化/推理失败抛 `OCRRuntimeError`。浏览器并发返回名为 `BusyError` 的错误，取消返回 `AbortError`；错误信息不应被当作空白页结果。

### 参数与处理顺序

| 参数 | 默认值 | 语义 |
| --- | --- | --- |
| `rotation` | `0` | 顺时针 `0/90/180/270`，在分区前执行 |
| `split` | `none` | 整张 `none`；左右页 `pages`；左右双栏 `columns` |
| `split_position` | `0.5` | 旋转后宽度的 `0.1–0.9` 比例 |
| `max_side` | `1920` | 每区处理最大边 `640–2560`，不放大小图 |
| `min_confidence` | `0.45` | 保留文字行的最低分值，范围 `0–1` |
| `mode` | `auto` | Python：`none` 只缩放、`perspective` 透视、`auto` 透视并尝试基线展开；浏览器返回校正能力提示 |

顺序为 EXIF 正向解码 → 手动旋转 → 左右裁剪 → 每区缩放/校正/OCR → 回映输入照片坐标。分割边界为 Python `round(rotated_width * split_position)`，浏览器保持相同的半数取偶规则。两区完整覆盖旋转后照片且不重叠，每区至少 32 × 32 像素；阅读组合顺序为左区、右区。当前仅支持左右两个区域和横排阅读顺序。

### Python HTTP

```bash
python -m mobile_ocr serve
```

根路由 `/` 是整合应用；`/ocr-debug` 是 B 独立照片调试页；`/docs` 提供 API 文档。`GET /api/health` 返回状态、引擎、版本和 `ready`，不会触发模型加载。

```powershell
curl.exe -X POST "http://127.0.0.1:8000/api/ocr?rotation=90&split=pages&split_position=0.48&mode=auto&min_confidence=0.45&max_side=1920" -H "Content-Type: image/jpeg" --data-binary "@双页.jpg" -o result.json
```

请求体直接为原始图片 bytes，不使用 multipart 或 JSON base64。内容类型为 `image/jpeg`、`image/png`、`image/webp`。错误响应为 `{"error":"说明"}`：400 输入/校准无效，413 超过 8 MiB，415 内容类型不支持，422 查询参数无效，503 实例忙或引擎不可用。调用方应等待或退避重试，不反复并发提交。

Pages 页面不包含 Python 服务。从 Pages 调用时填写完整 HTTPS `/api/ocr` 地址，服务配置 `FEELYREADER_ALLOWED_ORIGINS`，默认允许 `https://livia-w.github.io`。同源本地页面可留空使用本地接口；详见 [部署说明](DEPLOYMENT.md)。

## 4. B 文档结果

浏览器与 Python 共用下列结构。引擎、排版方法、能力提示和具体识别结果可以不同。

| 顶层字段 | 含义 |
| --- | --- |
| `schema_version` | 字符串 `"2.0"` |
| `document_id` | 本次文档结果标识；行编号仅在该结果内有效 |
| `engine` | 浏览器 `tesseract.js-6.0.1`，或 Python RapidOCR 标识 |
| `source_size` | EXIF 正向、手动旋转前的输入照片 `[width,height]` |
| `rotated_size` | 手动旋转后整张照片尺寸 |
| `calibration` | `{rotation_clockwise,split,split_position}` |
| `regions` | 各分区图像、裁剪范围、行编号、校准矩阵和几何变换 |
| `lines` / `blocks` | 全局唯一编号的文字行和文字块，均包含 `region_id` |
| `text` | 按输出阅读顺序组合的行文本 |
| `warnings` / `timing_ms` | 能力/回退提示和解码、几何、OCR、总耗时 |

每个 `regions[]` 包含 `id`、`label`、`kind`、`line_ids`、`polygon_source`、`rectified_size`、JPEG data URL `rectified_image`、`calibration`、`transform` 和 `warnings`。未拆分时为 `page-1`；拆分使用 `page-1/page-2` 或 `column-1/column-2`。`polygon_source` 表示校准裁剪的范围，不等于自动检测到的最终纸张边界。

每个 `lines[]` 包含 `id`、`reading_order`、`region_id`、`block_id`、`text`、`confidence`、`polygon_source`、`bbox_source`、`polygon_rectified`、`bbox_rectified`。多边形单位为像素；矩形格式为 `[x,y,width,height]`。行置信度不是整行完全无错的概率，也不能保证没有漏字；两种引擎的分值不应作为相同标尺比较。

`blocks[]` 包含 `id`、`region_id`、`type`、`line_ids`、`bbox`、`coordinate_space`。`bbox` 属于该分区校正图，`coordinate_space` 为 `rectified`。Python 的标题判断是几何启发式，浏览器使用 Tesseract 的块/段/行输出顺序；均不宣称语义版式理解。

顶层 `rectified_image`、`rectified_size`、`transform` 只是 `regions[0]` 的兼容视图。多区调用方必须用 `line.region_id` 找对应分区，不能用第一分区变换解释其余文字。旧 `frame_id` 已由 `document_id` 替代。

## 5. 坐标链

所有像素空间原点左上，x 向右、y 向下。B 的矩阵为嵌套 3×3 数组；A 的直播跟踪矩阵为按行存储的 9 个数，适配时不要混淆格式。

| 空间 | 基准 |
| --- | --- |
| B `source` | 本次输入照片的 EXIF 正向像素，尚未手动旋转 |
| B `rotated` / region | 手动旋转后的整张照片，及其左右裁剪局部空间 |
| B 透视平面 | 每区缩放/透视校正后、曲面展开前的平面 |
| B `rectified` | 每区最终校正图，必须结合 `region_id` 使用 |
| A `reference` | A 导出的逐页透视图；整合流程逐页将它交给 B，因此等同于该次 B 的 `source` |
| A `currentVideo` | 当前视频的固有、非镜像像素 |
| screen | CSS 显示坐标；还需要考虑 `object-fit:contain` 和留白 |

B `regions[].calibration.source_to_region_matrix` 已组合手动旋转和裁剪，逆矩阵为 `region_to_source_matrix`。90° 顺时针的像素映射为 `x'=source_height-1-y, y'=x`。

B `regions[].transform.source_to_page_matrix` 已进一步组合缩放和透视，直接把 B 原图映射到本区透视平面；`page_to_source_matrix` 为逆矩阵。`source_size` 是 B 原图尺寸，`region_source_size` 是本区旋转裁剪后尺寸，`rectified_size` 是本区输出尺寸。不要重复应用校准旋转或裁剪。

Python 曲面展开时 `curvature_mesh` 为单调纵向逆映射，回映步骤为：

1. 按 `mesh.x`，在每条 `mesh.source_y` 上对校正点的 x 插值。
2. 以 `mesh.target_y` 为节点，对校正点 y 插值得到 `y_page`；x 不变。
3. 对 `(x,y_page,1)` 应用 `page_to_source_matrix` 并除以齐次分量。

网格为 null 时跳过前两步。正向先应用 `source_to_page_matrix`，再反解网格。只用一个单应性矩阵不能替代非线性曲面回映。B 已返回 `polygon_source`，消费方应保留全部边缘采样点。

### 接入 C

整合控制器把 C 的文字地图统一到 A 参考坐标：使用 B 的 `bbox_source/polygon_source`，地图尺寸设为 B `source_size`。手指从视频归一化位置转为 `currentVideo` 像素，经 A `currentVideoToReference` 映射到参考图；反向画框使用 `referenceToCurrentVideo`，再换成屏幕坐标。

因此无需把 B 非线性变换再次叠加到已经回映的 `polygon_source` 上。若自行改用 B 的 `rectified` 图作为 C 地图，则必须同时实现曲面、透视、裁剪与视频跟踪的完整链。C 的词位置是行内估算，不能称为模型测得的逐字坐标。

## 6. D 与 E

整合页在加载 `reading_manager.js` 前设置 `window.FEELYREADER_NO_AUTO_TTS = true`，避免默认实例与控制器实例争抢同一语音队列。独立使用时仍保留兼容的 `window.BookReaderTTS`。

```javascript
const reader = new ReadingManager({
  autoListenA: false,
  initialMap: { document_id: 'empty', lines: [] }
});
reader.loadOcrMap(result, { silent: true });
const unsubscribe = reader.onStateChange(state => console.log(state.status));
// reader.play(), pause(true), resume(), prevLine(), nextLine(), setSpeed(rate)
// reader.onTapWord(text, lineId), onSlideWords(text, pixelsPerSecond)
// reader.onSelectRegion(text, lineIds), getHighlights(), getHistory()
// 销毁时：unsubscribe(); reader.destroy();
```

`loadOcrMap` 识别 `document_id`，清除旧语音/反馈；换页等待 OCR 时不保留可朗读旧行。反馈状态为 `feedback`，结束后恢复原正文动作或暂停状态；恢复从当前行/短句开头开始。设备不支持或拒绝 TTS 时返回状态中的 `lastError`，不模拟朗读完成。

C 同一次词焦点还可能产生语音注释，不能把两条通道都接成重复正文播报。控制器只接一次词焦点并聚合短时间内的连续词；暂停/恢复注释单独处理。手动暂停时同时屏蔽 C 的新词派发。双指选区按命中的文字行保存，当前不承诺逐字范围精度。

高亮、历史和进度使用浏览器本地存储。E 使用文本节点显示 OCR/导入数据，不能把它们直接写入 `innerHTML`。导入 JSON 不会自动获得纸面跟踪资格；切换输入或页面后不能沿用旧文档的行编号作为持久锚点。

## 7. 验证边界

Node 受控测试覆盖模块接口、取消、坐标映射、跟踪时效/尺寸/采集批次、TTS 生命周期和 UI 状态；Python 测试覆盖完整 B 流程。真实浏览器检查需另外覆盖模型资源、中文 OCR、EXIF、相机权限和语音。纸面点读精度、双指遮挡、反光、真实翻页、耗电发热和持续运行性能仍需目标手机实测，不能由替身测试推断。
