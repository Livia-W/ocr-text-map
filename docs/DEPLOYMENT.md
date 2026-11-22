# FeelyReader 部署

默认入口为 **[GitHub Pages 应用](https://livia-w.github.io/ocr-text-map/)**。浏览器版执行真实 Tesseract 中文/英文 OCR，可以独立使用；GitHub Pages 只发布静态文件，不运行 Python。

## 1. 源码与网站产物

| 位置 | 内容 |
| --- | --- |
| `main` | A/B/C/D/E 源码、Python 后端、测试和文档 |
| `dist/web` | 本地白名单构建结果；不是源码目录 |
| `gh-pages` 根目录 | 供 GitHub Pages 发布的静态产物 |

在源码目录使用 Python 3.11 构建，无需为静态构建安装 OCR 后端依赖：

```powershell
python -m scripts.build_web --output dist/web
```

省略参数时也输出到 `dist/web`。其他输出只能位于工作区 `dist` 的严格子目录，例如 `--output dist/preview`。构建先检查源文件、资源大小与必需模型，再在临时目录复制校验并替换产物；缺资源时不会先清空已有站点目录。

产物包含整合 HTML/CSS/JS、运行所需 `vendor/`、第三方说明 `THIRD_PARTY.md`、`.nojekyll` 和 `manifest.json`。清单记录版本及各文件的相对路径、字节数和 SHA-256；单个静态文件必须小于 100 MiB。

白名单包括 C 独立测试页 `blind-book-ocr-json-test.html` 和共享入口 `gesture-test.js`，不复制 `CNAME`、Python 后端、测试、其它旧演示、个人照片、`outputs/`、`.venv`、`.git` 或本机凭据目录。默认部署不依赖自定义域名。旧 `app原型` 分支中的 `CNAME` 不代表域名已注册；不要据此在 Pages 中填写自定义域名。

## 2. GitHub Pages 设置

将 `dist/web` 中的**内容**以正常提交发布到 `gh-pages` 分支根目录，保留 `main` 源码分支。更新时应使用完整构建产物，避免留下旧的运行脚本或 `CNAME`；不需要强制覆盖源码分支。

先提交源码，再运行发布脚本。脚本核对构建清单，使用隔离的 Git index，将静态产物以普通提交推送到 `gh-pages`；当前源码分支与工作树保持不变，不使用强推：

```powershell
python -m scripts.build_web
python -m scripts.publish_pages --check
python -m scripts.publish_pages
```

需要电脑现有的 GitHub 推送权限。若远端同时有新部署，非快进推送会停止；更新后重新构建并发布即可。

仓库 **Settings → Pages → Build and deployment**：Source 选择 **Deploy from a branch**，Branch 选择 **gh-pages**，目录选择 **/(root)**。默认入口不设置 Custom domain；等待该次部署成功后访问页面，使用 HTTPS。GitHub 的发布源约定见[官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。

发布后核对：

- 页面是 FeelyReader 整合入口，能选择照片、识别引擎和页面。
- 中文/英文模型、Web Worker、WASM 和 MediaPipe 资源实际加载成功。
- 上传清晰中文照片后返回真实文字与定位框；旋转和左右分区输出正确。
- 取消首次模型加载或识别后可以重新识别，没有旧结果覆盖新输入。
- 相机、TTS 和纸面追踪在目标设备检查；电脑自动测试不代表手机已验收。

`manifest.json` 可以用于对照发布版本。浏览器首次加载的模型文件较大，下载时间取决于网络；不要用演示文字替代下载失败或 OCR 失败。

## 3. 静态资源

静态运行需要以下资源，必须随构建产物一起发布：

| 目录 | 用途 |
| --- | --- |
| `vendor/opencv/` | A 页面检测、透视与参考跟踪 |
| `vendor/tesseract/` | Tesseract.js 主脚本、worker、WASM core、`lang/chi_sim.traineddata` 和 `lang/eng.traineddata` |
| `vendor/mediapipe/` | C 的 Hands 脚本、模型与运行资源 |

模型 URL 相对于 `document.baseURI`，支持 `/ocr-text-map/` 项目子路径。不要改成站点根目录 `/vendor/`，否则会请求到错误位置。当前 `gzip:false` 使用未压缩的 `.traineddata` 文件；仅保留同名 `.gz` 不能替代这些文件。第三方来源与许可见源码中的 `THIRD_PARTY.md` 及对应资源目录。

## 4. 可选 Python 3.11 服务

浏览器模式不需要这一节。需要 Python RapidOCR、B 内部透视校正或非线性曲面展开时，再部署 Python 服务：

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m mobile_ocr serve --host 127.0.0.1 --port 8000
```

保持终端运行。浏览器打开 `http://127.0.0.1:8000/` 使用本地整合应用；`/ocr-debug` 是 B 独立照片调试页，`/docs` 为 HTTP 接口文档。该本地整合页选择 Python 引擎时，接口留空使用同源 `api/ocr`。

外网后端应通过可信 HTTPS 提供 `POST /api/ocr`，在前端填写完整端点，例如 `https://your-backend.example/api/ocr`。可以使用 HTTPS 反向代理，或在开发服务器同时提供证书与私钥：

```powershell
.\.venv\Scripts\python.exe -m mobile_ocr serve --host 0.0.0.0 --port 8000 --ssl-certfile certs/server.pem --ssl-keyfile certs/server-key.pem
```

证书必须适用于实际访问地址并受到客户端信任。GitHub Pages 本身不会托管这个 Python 进程。手机的 `localhost` 指手机，不能用它连接电脑上的后端；本地开发优先直接访问服务提供的整合页，避免把 Pages 到本地网络的浏览器权限差异当成服务器故障。

### 跨来源允许列表

`FEELYREADER_ALLOWED_ORIGINS` 默认为 `https://livia-w.github.io`。Origin 只含协议、主机和端口，**不含 `/ocr-text-map/` 路径**。需要增加自己管理的前端来源时，在启动前设置逗号分隔列表：

```powershell
$env:FEELYREADER_ALLOWED_ORIGINS = "https://livia-w.github.io,https://your-frontend.example"
.\.venv\Scripts\python.exe -m mobile_ocr serve --host 0.0.0.0 --port 8000
```

macOS/Linux 的对应配置为：

```bash
FEELYREADER_ALLOWED_ORIGINS="https://livia-w.github.io,https://your-frontend.example" .venv/bin/python -m mobile_ocr serve --host 0.0.0.0 --port 8000
```

上面的服务监听命令不自行创建 HTTPS；外网访问仍需前述 TLS 或反向代理。CORS 控制浏览器跨来源调用，不代替部署方的认证或流量限制。API 接收原始图片 bytes，最大 8 MiB；完整字段与错误码见[集成契约](INTEGRATION.md)。

## 5. 排错与验收边界

| 现象 | 优先检查 |
| --- | --- |
| Pages 404、跳转到旧域名 | Pages 发布分支/目录、最新部署状态、是否残留旧 Custom domain 或 `CNAME` |
| OCR 模型或 WASM 404 | `vendor/` 是否完整发布、大小写、项目子路径、`.traineddata` 文件名 |
| 一直等待初始化 | 浏览器控制台和网络面板；取消后重试，检查模型请求而不是反复刷新提交 |
| 页面显示但相机打不开 | HTTPS、浏览器相机权限、是否在应用内嵌浏览器、相机是否被其他应用占用 |
| Python 请求失败 | 完整 `/api/ocr` 地址、HTTPS、允许的 Origin；直接检查后端 `/api/health` |
| 电脑本机可访问、手机超时 | 实际后端 IP、监听地址、主机入站规则及热点/网络隔离；这不影响默认浏览器 OCR |
| 照片能朗读但纸面手势不可用 | 是否重新采集 A 参考页，跟踪是否新鲜，采集批次和尺寸是否匹配 |
| 有文字但没有声音 | 设备语音能力、用户操作授权、系统音量和界面的语音错误状态 |

浏览器版不执行 B 的非线性曲面展开；A 的透视参考与曲面校正不是同一能力。跟踪有效仅表示通过当前几何规则，不保证真实纸面定位准确。最终验收需要真实手机、纸张、光线与遮挡场景，并观察长时间使用的温度、内存和响应。
