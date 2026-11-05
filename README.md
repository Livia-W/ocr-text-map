# BookReader 书页拍摄原型

## 当前版本：自动页面检测（实验性）

### BR-CONTENT-4：页面内容身份与重复采集抑制（最新）

本节优先于下方旧阶段记录。OpenCV 加载、单页/双页检测算法没有修改；新增 `page-content.js`，构建号为 `BR-CONTENT-4`。自动开关仍默认关闭，开启后首次有效书页稳定约 1.5 秒即采集。手动及自动拍摄完成都继续实时预览，只有停止按钮、后台或离开页面才释放相机。

每次低频检测后，按页面四角从检测缩略图透视对齐为 96×128 灰度图，生成局部均值/方差归一化的文字墨迹描述；只比较页内区域，并在中心区域尝试 ±2 像素平移，减轻亮度、对比度和轻微对齐误差。相机画面背景不参与页面身份比较。原有边界与页内稳定门槛仍约 1.5 秒。移动、检测丢失、采样间断及显式手部遮挡都会取消候选确认，不删除已采集参考。

首次采集分配 P1，后续未知内容依次编号。单页/双页数量变化时先匹配已知内容，不把左/右位置直接当成页面编号。相同内容保持 ID，不拍摄；变化不确定时保留原底图；明显且分布较广的内容变化还需连续确认至少 1200ms、3 个稳定样本才拍摄，因此新页实际等待可能超过 1.5 秒。所有内容阈值集中在 `CONTENT_CONFIG`。局部短暂遮挡不会直接视为翻页；没有手部识别时，长期遮挡仍可能误触发。

采集成功后保存每页 Blob 参考图、对齐特征、ID、尺寸和转换信息；参考状态跨相机停止/重新开启及自动开关切换保留，重开相机也保留上一次底图。为限制手机内存，最多保存 4 个最近参考；更早被淘汰的页再次出现可能得到新编号。刷新或关闭页面会清空内存状态。采集次数按成功采集含有效页面的批次计数，双页一批计一次；手动拍摄可覆盖自动抑制，同页手动拍摄增加次数但不增加 ID，也不触发新页事件。无有效页的手动原图不计入书页采集次数。

界面显示页面编号、采集次数及“等待书页”“页面移动中”“当前页已采集”“新页面已采集”；变化不确定、确认中及遮挡暂停时另有明确状态。

#### B/C 整合接口

```javascript
// C 尚未接入时，默认没有遮挡信号，不代表已证明不存在手部。
window.BookReader.setHandOccluded(true);  // 暂停，取消正在确认或异步输出的自动采集
window.BookReader.setHandOccluded(false); // 重新稳定与比较
// 也可通过事件输入，重复发送相同值不会重复重置计时。
window.dispatchEvent(new CustomEvent('bookreader:hand-occlusion', {
  detail: { occluded: true }
}));

window.addEventListener('bookreader:page-updated', event => {
  const { pageId, referenceImage, label, width, height,
    points, matrix, captureCount, automatic } = event.detail;
  // 每个新编号触发一次；referenceImage 为透视校正页图 Blob。
  // 这是内容更新事件，并不声称识别了翻页动作。
});

const references = window.BookReader.getReferences();
// {id, referenceImage, content, label, points, matrix, width, height}[]
// content 是供内部匹配的低分辨率特征，返回时复制特征数组。
```

原有 `bookreader:captured` 事件继续提供原图与逐页输出；`pages[].pageId` 和 JSON `pageIds/captureCount` 为新增字段。原始坐标及矩阵约定不变。参考页底图只在成功编码后提交，自动采集等待编码期间收到遮挡或会话切换会放弃该次提交。没有添加 OCR、朗读或手动框选。

#### 验证与限制

新增 `tests/page-content.test.cjs`，覆盖首次采集、同页抑制、亮度/小平移、短遮挡后原页恢复、持续新内容、遮挡输入、单/双页切换、重复遮挡信号以及参考数量上限；新增 `tests/capture-content.test.cjs` 验证应用实际拍摄函数不释放相机、新编号事件和编码期间遮挡取消；真实 OpenCV 回归新增对齐页图随相机中页面平移后仍匹配的测试。测试是合成样例与环境替身，不能等同于 iPhone 实测。共 32 项通过。所有测试运行命令：`node --test tests/*.test.cjs`。

本方法不是页码 OCR 或语义翻页识别：内容高度相似的页面可能漏采；长时间遮挡、严重反光、失焦、弯曲导致的对齐错误可能误采；C 未接入时不能可靠排除所有手部。极小排版修改可能处于不确定区而不更新，双页高度相似也可能匹配错误。最近参考数量有限，且不跨刷新保存。

iPhone 待验收：首次放书、静止不重复、手伸入/移开回原页、真实翻页、自动曝光、轻微书本移动、单/双页互换、停止重开后原页仍不重复、开关与后台切换、编码中遮挡/关开自动模式、B/C 事件字段及持续运行内存和发热。

此次上传：新增 `page-content.js`；修改 `index.html`、`app.js`、`stability.js`；更新 README.md。开发测试新增 `tests/page-content.test.cjs`、`tests/capture-content.test.cjs`，修改 `tests/single-page.test.cjs`，测试目录无需部署。其余现有文件继续保留，OpenCV 加载器与 vendor 不用重新上传。

### BR-DIAG-3：真机检测排查版本

页面标题下显示构建号 `BR-DIAG-3 · 2026-10-29`。检测调试默认展开，可收起；显示当前分析帧号、时间、尺寸、边缘/亮度区域轮廓总数、面积太小/太大的数量、面积通过数、四角几何通过数，以及每条轮廓的面积和未通过原因。纹理显示文字带数、墨迹比例、细节边缘比例与阈值方法。处理缩略图是真实当前检测帧的闭运算边缘图，叠加候选边界；不是演示图片。画布与轮廓资源逐轮复用或释放。

针对低对比度边缘断开与局部阴影：边缘闭运算由 3×3 改为 7×7；补充 Otsu 亮度区域轮廓作为独立候选来源，再经过相同几何和文字门槛。它不再要求原始 Canny 边缘本身完整闭合，但最终仍需能够可靠拟合页面四角。页内纹理改为局部 Gaussian 自适应阈值（窗口 31、偏移 8），取消亮度 155 的固定墨迹判断；细节改为局部二值边缘转换计数。仍要求至少 5 个文字带、合理墨迹比例及细节比例。检测最长边 960，减少竖屏小字号汉字在全帧缩小过程中的细节损失；性能需真机确认。稳定时间仍为 1500ms。

验证：新增真实 OpenCV 的阴影低对比度测试（整页亮度都低于 155，旧规则将全部判为墨迹，新方法可通过），新增面积阶段计数及两条候选路径的可观测性测试，既有单页/双页/弯边/透视/空白拒绝回归通过。总计 22 项测试。用户附件可在对话中看到，但附件指向的 Windows 临时文件路径不存在，未能对该截图进行像素级算法回放；本版本不能宣称已经在该截图或真机上通过。缺少完整视频帧的处理日志时，也不能把失败原因唯一归结于阴影或断边。

仍可能漏掉断裂过大、文字稀少、严重弯曲的页面，或误报印刷包装、屏幕。亮度区域补充分支只是候选生成，不是语义识别；未通过有效性门槛仍禁止自动拍摄。请在同一摆位确认新构建号、帧号递增、候选轮廓及纹理指标后，再判断失败阶段。

此次上传：`index.html`、`styles.css`、`app.js`、`stability.js`、`page-detector.js`，可同步上传 README.md。开发测试修改 `tests/single-page.test.cjs`，无需部署。OpenCV 加载器与 vendor 文件未修改。

### 单页支持更新

单页不要求伴随另一页或中缝。旧版宽高比大于 1.12 的候选只有通过中缝分支才会继续处理，现已取消这一硬限制：中缝仅用于可选双页拆分，没有可通过的拆分页面时独立验证完整单页。另一页不完整时，其边缘触框候选被单独拒绝，不影响完整页。单个有效结果统一标注“单页”；两个有效且相邻的结果才标注“左页”“右页”。

轮廓在 1.5%、2.5%、4%、5.5% 周长尺度尝试四角近似，允许轻微边缘弯曲，保留轮廓面积与拟合四角面积的一致性约束、完整边界和文字纹理门槛；不会将任意旋转包围矩形直接判成页面。严重弯曲、边缘断裂仍可能失败，透视输出仍不等于曲面展开。

实时预览橙色虚线为候选，绿色为通过的页面；展开“检测调试”可查看文字行纹理不足、暗色过多、细节不足、触及画面边缘、比例或轮廓拟合失败等原因。候选最多显示 16 条，面积过小的杂散轮廓不逐一显示。

本次重新上传 `index.html`、`app.js`、`stability.js`、`page-detector.js`；可同步上传 README.md。新增开发测试 `tests/single-page.test.cjs` 无需部署。OpenCV 加载器及 vendor 依赖没有修改。

使用真实本地 OpenCV 和人工合成图案测试竖版单页、无中缝宽页、残页邻接、轻微弯边、轻微透视、空白矩形拒绝，以及双页输出。合成纹理仅用于自动测试，不是运行时模拟画面，也不能证明真实书本准确率。既有稳定门控测试已覆盖单个页面稳定约 1.5 秒触发。iPhone 仍需验证真实纸张、弯曲/阴影/反光、残页入镜、调试框对齐及实际逐页拍摄与下载。

以下内容优先于下方早期阶段说明。当前版本使用项目内托管的 OpenCV.js 4.10.0，位置为 `vendor/opencv/opencv.js`，WASM 内嵌，无额外 WASM 文件。旧的官方文档地址实测返回 HTTP 404，已移除运行时外部依赖。首次开启相机后显示检测边界，自动拍摄仍默认关闭。相机运行且页面可见时，每次检测结束至少等待 350ms 后再检测，最长边缩至 640 像素。只使用真实摄像头，不提供手动框选或模拟检测结果。

### 本地依赖加载修复

新增 `opencv-loader.js`：以加载器自身 URL 为基准解析 `vendor/opencv/opencv.js`，适配 GitHub Pages `/bookreader/` 子路径，不使用站点根路径。下载阶段检查 HTTP 状态和返回内容，90 秒超时；初始化阶段等待运行时回调/Promise/旧式 thenable，并实际创建和释放 Mat，60 秒超时。此固定版本的 `.then()` 返回自身，不能直接 `await window.cv`；就绪后移除这一旧式钩子再交给原生 Promise。失败会显示具体阶段及原因，并提供“重试加载”；失败的 Promise 会被清除以允许重试。下载后的脚本通过 Blob URL 执行，GitHub Pages 默认配置支持；如额外配置 CSP，需要允许 `blob:` 脚本和 WebAssembly。

此次需上传：`index.html`、`app.js`、`page-detector.js`、新增 `opencv-loader.js`，以及整个 `vendor/opencv/`（opencv.js、LICENSE、package.json、README.md）。同时更新本 README。其余已有网页文件继续保留。新增开发测试 `tests/opencv-loader.test.cjs`，无需部署测试文件夹。

检查：旧外部地址 HTTP 404；固定版本下载成功，包内 WASM 已确认内嵌；Node 中创建 Mat 通过；模拟浏览器环境用真实发布文件验证 `/bookreader/` 相对 URL、HTTP 404 后重试、真实 WASM 初始化、旧 thenable 处理及重复加载复用。以上不是 Safari 真机测试。iPhone 仍需验证 GitHub Pages 首次下载、弱网/断网提示、重试按钮、WASM 初始化与内存、拍照及自动检测恢复。浏览器不会在检测加载失败时自动拍任意静止画面。

检测依据：Canny 边缘及闭运算提取凸四边形，检查面积、长宽比例和完整边界；透视归一化后检查多行小尺度暗纹理。宽幅候选还必须存在贯穿大部分高度、对两侧有对比的中缝线，才生成左右候选；两页分别通过纹理检查才输出。独立单页候选不强行拆分，单页标注“单页”；两页标注“左页”“右页”。这里的“有效”仅指通过规则，并不代表语义上已经证明是书本。

低置信度显示“未确认书页，请调整位置”，立即清除待拍计时。边界和页内低分辨率灰度签名相对上一帧及稳定起点都稳定约 1.5 秒后才触发；拍摄前再验证一次当前画面。检测丢失不清除已拍页面签名，临时遮挡后恢复同一页不会仅因丢失就再拍。不同内容重新稳定后可拍摄；不将手部、遮挡或任何运动直接认定为翻页。停止、重启检测会初始化历史；关闭再开启自动模式属于新检测会话。

### 输出及整合

- 原图：保留原始视频尺寸 JPG，可下载。
- 页面：从同一原图按检测坐标进行四点透视变换，逐页展示和下载。当前只保留最近一次结果，后续拍摄会释放旧的对象 URL。
- JSON：下载每页原图像素坐标、输出尺寸、3×3 转换矩阵和规则证据。四角顺序为左上、右上、右下、左下；矩阵为按行存储的原图到校正图转换，目标四角为 `(0,0)`、`(width-1,0)`、`(width-1,height-1)`、`(0,height-1)`。坐标原点为原图左上，x 向右、y 向下。单页左右侧未知时不猜测侧别。
- `bookreader:captured` 事件保留顶层 `{blob,width,height}` 原图接口，并新增 `pages`（每页含 blob、points、matrix、width、height、label、evidence）及 `metadata`，供 B/C 自行保存和接入。本版本没有执行 OCR 或手势识别。
- 只做近似平面的透视校正。曲面、中缝弯曲和文字弯曲校正由 B 负责，JSON 标记 `curvedSurfaceCorrected: false`。

边界使用视频原始比例的归一化坐标；绘制时计算视频元素内 `object-fit: contain` 的实际内容区域及留白偏移，并监听布局尺寸变化。OpenCV Mat、MatVector、轮廓、变换矩阵在 finally 中释放；每次只处理一轮、逐页导出。WebAssembly 堆可能保留峰值分配，不能仅凭释放代码宣称已通过长期内存测试。

加载失败或超时会明确显示检测不可用，自动拍摄暂停，不降级为“静止即拍”；手动按钮仍可保存原图。当 OpenCV 已就绪且有有效候选时，手动拍摄也导出候选页面，否则只保存原图。

### 方法限制（必须真机评估）

传统轮廓与纹理规则不是书本分类模型。报纸、印刷包装、屏幕或带文字的平面物品可能误报；因此无法保证“任意其他物品绝不拍摄”。白桌面、空白纸张、纯色矩形会因缺少行状纹理被拒绝，但复杂桌纹仍需实测。要可靠区分书本和非书本，需要带非书本负样本的语义检测/分割模型与标注数据验证。本实现不以虚构置信度或假框替代这一能力。

空白页、插图页、大幅倾斜、旋转超过约 45°、反光、阴影、手遮挡、中缝不明显、弯曲边缘或一页完全未入镜均可能漏检。中缝规则主要支持接近竖直的书脊；两页相似度变化不足时可能漏拍，曝光或持续遮挡也可能使内容签名改变而误触发。边界追踪丢失按低频检测的下一轮处理，并非逐视频帧实时追踪。不要将该版本描述为已可靠识别翻页或手部。

### 检查与部署清单

网页新增：`page-detector.js`、`page-output.js`。
网页修改：`index.html`、`styles.css`、`app.js`、`stability.js`。请将这六个文件全部上传 GitHub，保留未修改的 `camera.js`。同时更新 README.md；开发测试新增 `tests/pages.test.cjs`，不需要部署测试目录。

已执行 JavaScript 语法检查，以及 `node --test tests/camera.test.cjs tests/pages.test.cjs`，共 12 项通过。测试覆盖稳定门控、跟踪丢失、同页锁定、边界变化、采样间断、空白/纯色纹理拒绝、UTF-8、重复 HTML ID，以及既有摄像头服务。它们不代表 OpenCV 实际运行或检测准确率已通过验证。本环境无浏览器自动化和 iPhone。

真机需要测试：HTTPS 依赖下载成功与断网失败；空桌/包装/屏幕负样本；单页/双页/单侧有效；不同书本字体、角度、光线和手遮挡；稳定 1.5 秒及同页不重复；翻动/拿走书立即取消下一轮计时；横竖屏留白框线对齐；原图/裁剪/矩阵映射；Safari 下载；后台与开关反复切换；至少 15–30 分钟的帧率、温度、内存及资源释放。阈值集中在 page-detector.js 的 PAGE_CONFIG 中。

实现依据：[OpenCV 轮廓教程](https://github.com/opencv/opencv/blob/5.x/doc/js_tutorials/js_imgproc/js_contours/js_contours_begin/js_contours_begin.markdown)、[OpenCV.js 透视变换示例](https://github.com/opencv/opencv/blob/5.x/doc/js_tutorials/js_assets/js_geometric_transformations_warpPerspective.html)。

## 早期阶段记录

纯 HTML、CSS、JavaScript，无依赖、无需构建。相机使用真实 `getUserMedia` 视频流，没有模拟图片。未添加 OCR、手势识别、朗读、翻页检测或自动拍照。

## Windows 本地预览

在 PowerShell 中运行（需要 Python）：

```powershell
Set-Location D:\bookreander
python -m http.server 8000 --bind 127.0.0.1
```

在**这台电脑**的浏览器打开 `http://localhost:8000`。点击“开启相机”授权。按 Ctrl+C 停止服务器。电脑需要有可用摄像头；若没有，可检查界面及相应错误提示。

**iPhone 的 localhost 指向 iPhone 自身，不指向电脑。** 此命令仅供电脑预览。手机即便能访问 `http://电脑局域网IP:8000`，普通 HTTP 也不满足相机所需的安全上下文条件。请使用下面的 HTTPS 发布方式。

## 发布 HTTPS 页面，让 iPhone Safari 测试

推荐 GitHub Pages，不需要电脑持续开机：

1. 在 GitHub 创建一个用于此原型的公开仓库。
2. 将 `index.html`、`styles.css`、`camera.js`、`app.js` 上传到仓库根目录并提交。
3. 仓库 Settings → Pages → Build and deployment，Source 选择 **Deploy from a branch**；Branch 选择文件所在分支（通常是 `main`），目录选择 **/(root)**，保存。
4. 等待发布完成，复制 Pages 显示的实际 HTTPS 地址，通常形如 `https://你的用户名.github.io/仓库名/`。如有 Enforce HTTPS 选项，请开启。
5. iPhone 在 Safari **直接打开该 HTTPS 地址**，点击“开启相机”并允许摄像头权限。不要通过聊天应用内嵌浏览器或非 HTTPS iframe 测试。
6. 修改文件后重新提交，等待部署完成，再刷新 Safari 页面。

发布操作由你执行；本次没有创建远端仓库或上传文件。照片只保存在浏览器内存中，不会发送至 GitHub 或其他服务器。下载按钮生成 JPG 文件，Safari 中可到下载列表或“文件”App 查看；也可长按预览照片保存。刷新页面会丢失未下载的照片。

参考：[GitHub Pages 发布源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)、[HTTPS 设置](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)、[MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。

## 文件与整合接口

- `camera.js`：独立 `BookCamera` 服务。`start()` 开启相机；`capture()` 返回 `Promise<{blob, width, height}>`；`stop()` 释放所有音视频轨道并断开视频元素。
- `app.js`：界面状态、中文错误提示、照片预览与下载。
- `styles.css`：手机布局、横竖屏、安全区域与完整画面显示。
- `index.html`：页面入口。

`video` 设置 `autoplay muted playsinline`；请求后置摄像头与 3840 × 2160 的 **ideal** 分辨率，没有硬性最低分辨率，允许设备选择可用能力。后置摄像头只是优先选择，不保证设备一定提供。显示与截图以 `videoWidth/videoHeight` 为准，旋转导致尺寸变化时监听视频 `resize` 更新；预览采用 `object-fit: contain`，不做镜像或裁剪。

拍摄后提供事件，便于组员后续接入（本阶段不执行任何识别）：

```javascript
window.addEventListener('bookreader:captured', event => {
  const { blob, width, height } = event.detail;
  // 后续模块接收 Blob；此处自行持有需要的数据。
});
```

页面切入后台或离开会停止相机；返回后需手动重新开启。权限弹窗尚未结束时点击停止，会忽略后续结果，并在浏览器返回流后立即释放；网页无法主动关闭系统权限弹窗。

## 验证

```powershell
node --check camera.js
node --check app.js
node tests/camera.test.cjs
```

自动化检查使用测试替身验证服务逻辑，不代表真实摄像头或 Safari 已通过测试；页面运行时始终请求真实摄像头。

真机验收清单：

- iPhone Safari HTTPS 首次授权、拒绝后恢复、无权限/系统限制提示。
- 优先打开后置摄像头；实际取得的分辨率与设备降级行为。
- 竖屏、横屏及相机开启期间旋转：无强制全屏，完整画面可见，尺寸更新。
- 将四角有标记的书页放入画面；拍摄后确认四角完整，JPG 像素尺寸等于拍摄时显示的视频尺寸。
- 重新拍摄、下载 JPG、长按保存，以及 Safari 文件保存体验。
- 停止、完成拍摄、切换后台、离开页面后相机指示灯熄灭；返回后可重开。
- 权限弹窗未处理时停止、反复快速点击、相机被其他应用占用或中断。
- 普通 HTTP 局域网页面显示中文 HTTPS 提示。

自动测试与实际执行记录见交付说明。此环境没有连接 iPhone，不宣称完成真机测试。


## 第二阶段：画面稳定与自动拍摄

部署需保留 index.html、styles.css、app.js、stability.js 和 camera.js。README.md 为项目说明。

自动拍摄默认关闭。每 200ms 将视频缩小至 160×120，再灰度化比较。画面稳定约 1.5 秒后自动拍摄，同一静止画面只拍一次。自动拍摄使用原始视频分辨率并保持实时预览，最近一张结果显示在下方且可下载；新照片会替换上一张。

stability.js 的 STABILITY_CONFIG 集中配置采样间隔、稳定时长和变化阈值。检测到明显移动后才允许再次自动拍摄。光照、阴影及自动曝光也可能影响检测；本功能不识别翻页、书页或手部。

关闭自动模式、停止相机或进入后台时停止检测；重新启用后清空检测历史。返回前台需手动开启相机。手动拍摄仍会停止相机。

检查记录：JavaScript 语法检查和原有六项摄像头服务测试通过。自动拍摄、静止锁定、移动后重新触发、后台恢复及下载体验仍需 iPhone Safari 真机验证，并根据设备和光照调整阈值。


## Build 20261105.1 verification

Stable observation is configured in PAGE_CONFIG (800ms, at least four frames).
Processing gaps preserve evidence but contribute at most two analysis intervals.
Short detection loss pauses evidence for 700ms. Two incompatible layout detections
are required before switching single/dual layout. Analysis uses a maximum 640px
side; original capture resolution is unchanged. Lightweight passes resample content
at confirmed geometry; full boundary detection runs every 600ms and before capture.
This is not optical-flow boundary tracking. Debug rendering is disabled when collapsed.

Local verification: node --test tests/*.test.cjs, 34 passing tests, including actual
OpenCV synthetic page fixtures, content identity, camera lifecycle and capture cancellation.
No iPhone/device timing was measured. The fixed-page 10-second test, five page turns,
finger removal and physical book removal still require device acceptance. The 1-2s
capture latency is a target, not a measured result. Current heuristic texture checks
cannot guarantee rejection of every printed tabletop or partially occluded page.
