# 协作与贡献

本仓库交付 B 模块：照片校准、OCR、基础排版与文字地图。先阅读 [中文说明](README.zh-CN.md) 和 [集成契约](docs/INTEGRATION.md)，再修改接口或提交联调变更。

公开仓库：[Livia-W/ocr-text-map](https://github.com/Livia-W/ocr-text-map)。

## 分支分工

| 分支 | 负责模块 |
| --- | --- |
| `main` | 已验证、可供团队联调的稳定版本 |
| `a-camera` | A：采集与图像输入 |
| `b-ocr` | B：OCR、校准、几何、版面与坐标契约 |
| `c-gestures` | C：手势 |
| `d-reading` | D：阅读与语音 |
| `e-app` | E：应用与模块编排 |

各模块在所属分支开发，通过 PR 合入 `main`。修改公共输入输出时，在 PR 中说明受影响模块，并同步集成契约和调用示例。保持 `main` 可安装、可测试；避免将尚未完成的跨模块接口直接提交到 `main`。

直接向仓库推送分支需要写权限，由仓库所有者在 GitHub 的 Collaborators 设置中授予。没有写权限的组员可以 Fork 仓库，在自己的分支开发后提交 PR；公开访问本身不会授予推送权限。

```bash
git clone https://github.com/Livia-W/ocr-text-map.git
cd ocr-text-map
git switch -c b-ocr
```

若本地已经有 `b-ocr`，使用 `git switch b-ocr`。其他成员换用所属分支名。A/C/D/E 的完整实现不属于当前 B 交付范围；联调代码应清楚标注模块边界。

## 本地环境

使用 Python 3.10–3.12。Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m mobile_ocr serve
```

macOS/Linux 使用 `.venv/bin/python`。Node 用于运行照片调试页的测试，不是 Python 服务的运行依赖。

## 提交前验证

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node tests/test_photo_ui.cjs
```

命令行和 API 的默认值应一致：`max_side=1920`，每区有效范围 640–2560；照片编码最多 8 MiB、解码最多 2000 万像素。与照片方向、分区或坐标相关的改动，应核对四种旋转、非中点分割、区域覆盖与双向映射。

需要验证真实中文模型时可运行：

```powershell
.\.venv\Scripts\python.exe -m scripts.verify_chinese
```

默认字体不可用时通过 `--font` 指定已安装的中文字体。输出放在 `outputs/`，不提交到仓库。真实模型检查可补充单元测试，但不能替代照片中的人工定位检查。

## 契约变更

- 以 `document_id`、`regions`、`lines`、`blocks` 作为 C/D/E 的消费入口。
- 原始照片坐标始终指向 EXIF 正向、手动旋转前的照片；校正坐标属于 `region_id` 对应分区。
- 旋转、裁剪、透视已组合在分区变换中；保留非线性曲面网格，避免重复应用校准。
- 修改字段、坐标语义、默认参数或错误行为时，同时更新文档和相应测试。
- 阅读顺序和曲面校正仍是启发式；PR 应描述适用范围和回退行为，不把合成图效果当作任意书页的保证。

## 仓库内容

提交代码、必要文档以及可公开、可重复生成的测试材料。个人书页、上传照片、OCR 导出结果、虚拟环境、模型缓存、凭证和本机配置保留在仓库外或已忽略目录内。

`outputs/`、`.venv/`、`.local-backups/` 等是本地目录。旧项目备份 `.local-backups/legacy-before-module-b.zip` 不发布到公开仓库。旧 C++/Qt 代码、音效、串口组件和防火墙脚本已移出交付目录；不要作为 B 依赖重新引入。

照片调试页使用仓库内的静态资源。新增验证页面或测试时，不依赖外部 CDN、远程字体、在线脚本或个人文件路径；样本生成工具可以接受调用者提供的本地字体路径。

## PR 内容

说明具体问题、修改后的行为、验证命令和剩余限制。涉及跨模块接口时，给出输入示例、对应输出字段、坐标空间以及需要其他模块适配的变化。
