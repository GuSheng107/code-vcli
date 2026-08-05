# code-vcli — 为 AI 模型提供 Web 开发视觉能力

AI 编码模型（如 GLM、DeepSeek、Qwen-max）能写代码，但**无法「看见」屏幕**。

`code-vcli` 给它们一双眼睛：把截图 / 网页截图 / 文档图片转成结构化文本和 JSON，让没有视觉能力的模型也能看懂 UI 布局、按钮位置、卡片结构，准确完成 web 开发任务。

推理在本地完成，图片不上传。

文档站：https://gusheng107.github.io/code-vcli/

## 平台

- Windows 10/11（PowerShell / CMD / Windows Terminal）
- macOS（Apple Silicon 与 Intel，zsh / bash）
- Linux（x64 / arm64，bash / zsh）

需要 Node.js 22+ 和 Python 3.10+。

## 安装

直接使用 npm 安装：

```bash
npm i code-vcli
```

安装过程会自动部署运行依赖、用户级 `vcli` 启动入口并加入 PATH。首次安装后重新打开终端，即可直接运行：

```bash
vcli help
```

安装位置：

```text
Windows：    %LOCALAPPDATA%\.code-vcli\bin\vcli.cmd
macOS/Linux：~/.code-vcli/bin/vcli
配置目录：    ~/.code-vcli/
```

重新打开终端后，直接运行 `vcli` 进入可交互 CLI，或查看完整帮助：

```bash
vcli help
```

查看当前生效的 CLI 路径：

```bat
# Windows
where vcli

# macOS / Linux
which vcli
```

## 初始化

首次使用先初始化环境（创建 venv、选计算模式、下载模型，约 1-2 GB）：

```bash
vcli init
```

跳过交互用默认值：

```bash
vcli init --yes
vcli init --yes --workspace "E:\code-vcli-data"
```

> 升级 code-vcli 后，已安装的环境会通过 `vcli init` 自动同步最新推理脚本到工作区，无需重新下载模型。

初始化会在工作区下自动创建 `files/` 文件夹，建议把待识别的截图统一放到这里方便管理。通过 `vcli info` 可查看当前工作区路径。

```text
~/.code-vcli/              工作区（默认）
├── files/                 截图存放目录（init 时自动创建）
├── models/                模型权重
└── venv/                  Python 虚拟环境
```

## 使用

```bash
vcli run ./image.png              # 普通模式：整图 OCR
vcli run ./screenshot.png --web   # Web 模式：网页截图，叠加 YOLO 元素检测
vcli run ./image.png --json       # JSON 输出（自动保存到工作区 files/，返回文件路径）
vcli run ~/.code-vcli/files/login.png --web --json   # 直接引用 files/ 下的截图
```

### AI 调用场景

给 AI Agent 调用时建议始终带 `--json`：

```bash
vcli run ./webpage.png --web --json
```

输出示例：

```json
{
  "text": "登录\n注册\n用户名",
  "items": [
    {
      "text": "登录",
      "bbox": [10, 20, 60, 40],
      "type": "ui_text",
      "geometry": {"aspect": 2.5, "region": "top-center"},
      "cluster": {"id": 0, "size": 3, "arrangement": "vertical", "region": "center"}
    }
  ],
  "layout": {
    "img_size": [1920, 1080],
    "item_count": 12,
    "patterns": {"has_top_nav": true, "has_form": true},
    "cluster_summary": [
      {"id": 0, "size": 3, "arrangement": "vertical", "region": "center"}
    ]
  }
}
```

Web 模式原理：先用 PP-OCRv6 全图识字，再用 YOLO 定位按钮、输入框、卡片等 UI 元素，通过 IoU、中心点距离、面积比把文字归到对应元素上，最后按位置排序输出。空文本且置信度低于 `--min-confidence`（默认 0.55）的 UI 误检会自动丢弃。

## AI Agent Skill

仓库提供 `code-vcli` Skill，让 AI Agent 调用 `vcli` CLI 对截图执行本地视觉识别与网页 UI 元素解析。Skill 内含完整的 CLI 安装、初始化、调用流程，Agent 加载后即可知道如何使用 `vcli`。

推荐通过 Skills CLI 全局安装（会自动放入对应 Agent 的 skills 目录）：

```bash
npx skills add GuSheng107/code-vcli --skill code-vcli -g
```

也可以在[文档站 Skills 页面](https://gusheng107.github.io/code-vcli/skills.html)下载 ZIP 手动安装，解压后将 `code-vcli` 文件夹放入所用 Agent 的 skills 目录即可。

## 命令

| 命令 | 说明 |
| --- | --- |
| `vcli` | 交互界面 |
| `vcli init [--yes] [--workspace <path>] [--reset-workspace]` | 初始化环境 |
| `vcli run <image> [options]` | 识别图片 |
| `vcli info` | 环境信息 |
| `vcli update` | 更新到最新版 |
| `vcli install [--force]` | 安装到用户目录并加入 PATH |
| `vcli version [--check]` | 版本信息 |
| `vcli help` | 帮助 |

`run` 参数：

```text
<image>                    图片路径（必填）
    --ocr <ppocrv6>        OCR 引擎（默认 ppocrv6）
-w, --web                  网页/UI 场景
    --json                 输出 AI 可读的 JSON（自动保存到工作区 files/）
    --timeout <seconds>    推理超时
    --min-confidence <0~1> 空 UI 元素保留阈值（默认 0.55，仅 --web 生效）
```

支持 `png` / `jpg` / `jpeg` / `webp` / `bmp` / `tiff` / `tif`，上限 20 MB。

## 模型

- PP-OCRv6（RapidOCR + OpenVINO）：整图 OCR，速度快，带坐标
- OmniParser V2 YOLO：UI 元素检测（`--web` 启用）

## 隐私和安全

- 图片本地处理不上传，无遥测。
- 模型缓存位置：`~/.code-vcli/models/`
- 工作区：`~/.code-vcli/` 或自定义路径，截图建议放到工作区下的 `files/`

## 开发

```bash
npm install
npm run check    # 类型检查
npm run build    # 编译到 dist/
npm run build:skill-zip  # 生成 Skill 下载包
```

要求 Node.js 22 或更高版本。

Web 模式额外输出布局分析信息（`layout` 页面模式 + `geometry`/`cluster`/`relations`/`text_features` 每个元素的结构线索），供 LLM 推断元素意图，语言无关。详见 [skills/code-vcli/SKILL.md](skills/code-vcli/SKILL.md)。

## 许可

[AGPL-3.0-or-later](./LICENSE)。
