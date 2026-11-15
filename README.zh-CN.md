# FeelyReader · 采集、识字、点读与朗读

浏览器入口：**[打开 GitHub Pages 应用](https://livia-w.github.io/ocr-text-map/)**。

项目已整合 A 书页采集、B 中文/英文 OCR、C 纸面手势、D 朗读管理与 E 应用界面。默认在浏览器运行真实 OCR，不需要启动 Python。接口和部署细节分别见 [集成契约](docs/INTEGRATION.md) 与 [部署说明](docs/DEPLOYMENT.md)。

## 开始使用

1. 在浏览器直接打开上方 HTTPS 地址。选择已有照片，或开启相机并拍摄书页；需要相机时允许浏览器权限。
2. 调整方向，可按 90° 旋转；按需要选择左右书页或左右双栏，调整分割线，再点击识别。
3. 首次浏览器识别需要下载运行库及中文/英文模型。完成后选择页面，点击文字行或使用朗读、暂停、上一行、下一行和语速控制。
4. 保存高亮选区、查看本机阅读记录，或导出文字与文字地图 JSON。
5. 使用纸面手势时，保持相机开启，采集有效参考页，再开启手势。单指用于点读，双指用于框选命中的文字行并保存。

上传照片和导入 JSON 可以点击朗读；它们本身没有实时纸面参考跟踪，不能据此启用纸面点读。相机采集、识别与追踪失败会显示状态，需要重新摆放或采集。

A 已按页导出透视参考图，控制器逐页送入 B 时使用 `rotation:0`、`split:none`；上传照片的方向/分区设置不再次应用到相机参考。一次选择一个参考页，可通过页面下拉列表切换。

## 模块与实现

| 模块 | 当前职责 |
| --- | --- |
| A：采集 | 实时相机、书页检测、逐页透视参考图、参考页到当前视频的跟踪 |
| B：OCR 与文字地图 | 默认浏览器 Tesseract；可选 Python RapidOCR；方向/左右分区校准、文字行、文字块及坐标 |
| C：手势 | 复用 A 视频，结合有效参考跟踪进行单指点读和双指选区 |
| D：阅读 | 浏览器/系统 TTS、暂停与恢复、语速、阅读进度、反馈、高亮和历史 |
| E：应用 | `e-app.js` 与 `reader-controller.js` 提供整合界面及调用生命周期 |

原 `app原型` 分支只有 `CNAME` 文件，没有完整 E 功能提交；当前 E 为本仓库的整合实现。`CNAME` 文件不代表已经注册或持有对应域名，当前默认入口使用上述 GitHub Pages 地址。

## 两种识别方式

默认引擎为 **Tesseract.js 6.0.1，语言 `chi_sim+eng`**。它真实执行中文/英文识别，并读取文字行坐标。照片在本机浏览器处理；运行库和模型由静态站点下载。选择 Python 引擎后，照片会发送到用户填写的识别接口。

| 能力 | 浏览器默认引擎 | 可选 Python 服务 |
| --- | --- | --- |
| 中文/英文、文字行和置信度 | Tesseract.js | RapidOCR + ONNX Runtime |
| 顺时针旋转、左右页/栏分割 | 支持 | 支持 |
| B 内部额外透视校正 | 不提供；A 可以先输出已透视校正的参考页 | 检测到可靠页框时提供 |
| 非线性曲面展开 | 不提供，会返回能力提示 | 基于可靠横排文字基线保守展开 |
| 在 GitHub Pages 上直接运行 | 支持 | 需要单独运行 Python 后端 |

输入为 JPEG、PNG 或 WebP，最大 **8 MiB、2000 万像素**，宽高至少 32 像素；左右分割后每区宽高也至少为 32 像素。每区处理最大边默认 1920，可选 640–2560。浏览器和 Python 均先按 EXIF 归一化方向，再应用手动旋转和分区。

结果使用 `schema_version: "2.0"`、`document_id`、`regions`、`lines`、`blocks`。`polygon_source` 指向本次输入的 EXIF 正向照片；手动旋转、分区、校正图的局部坐标通过变换回映到该照片。多分区结果必须按 `region_id` 选择图像，不能把第一分区的兼容字段用于其他分区。

## 纸面跟踪与阅读边界

C 只接受 **有效且小于 400 ms 的跟踪结果**，并核对采集次数、参考页尺寸和当前视频尺寸。失去跟踪、更换参考或页面生命周期变化后，旧位置不能继续用于点读。普通照片模式仍可点击地图或文字行朗读。

词的位置由文字行与分词结果估算，不是模型验证过的逐字框。当前不能承诺毫米级纸面定位、任意书本识别、可靠语义翻页或遮挡后继续精确点读。强反光、严重弯曲、复杂版式、相似页面、模糊和低光需要用目标设备验收。TTS 使用设备语音能力；反馈打断后从当前行或短句开头恢复。

高亮、阅读历史和进度保存在当前浏览器的本地存储中，不是跨设备账户数据。清理站点数据或更换浏览器后不会自动恢复。

## 可选 Python 3.11 后端

Windows PowerShell，在源码目录执行：

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m mobile_ocr serve --host 127.0.0.1 --port 8000
```

macOS/Linux 使用 `python3.11 -m venv .venv`，后续命令中的解释器换为 `.venv/bin/python`。当前 Python 包支持 3.10–3.12，推荐 3.11；不支持 3.13 及以上。

保持服务终端运行，看到 `Uvicorn running ...` 后再访问：

| 地址 | 用途 |
| --- | --- |
| `http://127.0.0.1:8000/` | A/B/C/D/E 整合应用 |
| `http://127.0.0.1:8000/ocr-debug` | B 独立照片调试页 |
| `http://127.0.0.1:8000/api/health` | 服务健康状态，`ready:false` 表示模型尚未首次加载 |
| `http://127.0.0.1:8000/docs` | Python HTTP API 文档 |

在该本地页面选择 Python 引擎时，接口留空会使用同源 `/api/ocr`。从 GitHub Pages 调用后端时，需要填写完整的 **HTTPS `/api/ocr` 地址**。Pages 不会运行 Python；外网后端须自行部署并提供 HTTPS，跨来源允许列表由 `FEELYREADER_ALLOWED_ORIGINS` 配置，默认是 `https://livia-w.github.io`，不能把仓库路径写进 Origin。

手机的 `localhost` 指手机自己。电脑上的本地服务不会因 GitHub Pages 发布而自动变成可供手机访问的云服务。具体连接和发布方式见 [部署说明](docs/DEPLOYMENT.md)。

单张照片命令行：

```powershell
.\.venv\Scripts\python.exe -m mobile_ocr recognize "双页.jpg" --rotation 90 --split pages --split-position 0.48 --mode auto --max-side 1920 --output "文字地图.json" --image-output "校正页.jpg"
```

两区会分别导出 `校正页-1.jpg`、`校正页-2.jpg`。HTTP 请求体直接传图片 bytes，不使用 multipart，详见 [集成契约](docs/INTEGRATION.md)。

## 构建与验证

`main` 保留完整源码；GitHub Pages 从 **`gh-pages` 分支根目录**发布白名单静态产物：

```powershell
python -m scripts.build_web --output dist/web
```

发布 `dist/web` 中的内容及所需 `vendor/` 资源，不将源码工作目录整体当成网站。部署配置、模型文件和后端 CORS 见 [部署说明](docs/DEPLOYMENT.md)。

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node --test tests/test_browser_ocr.cjs tests/test_reader_controller.cjs tests/test_reading_manager.cjs tests/test_gesture_mapping.cjs tests/test_reader_ui.cjs
node tests/test_photo_ui.cjs
```

Python 测试验证 B 的几何、排版、输入和 API；Node 受控环境验证浏览器接口、取消、坐标、朗读状态及整合 UI。测试用的替身只用于回归，不是产品识别结果。真实浏览器还需要检查模型下载、相机权限、EXIF 显示、语音及识别。实体纸面手势、不同光线、发热与持续运行性能需要真机验收，不能由自动测试替代。
