---
name: code-vcli
description: 使用 vcli CLI 对截图/图片执行本地视觉识别与网页 UI 元素解析。当需要把屏幕截图、网页截图、文档图片转成文本、结构化 JSON 或进行视觉意图理解时使用。支持三条路线：OCR 模式（PP-OCRv6 + 可选 YOLO Web 检测）、VLM 模式（Qwen2.5-VL 视觉理解）、Mix 模式（先 OCR 再把文字注入 VLM）。
---

# code-vcli — 为 AI 模型提供 Web 开发视觉能力

`code-vcli` 是一个面向 AI 编码模型的本地视觉识别 CLI：把一张图片（截图、网页截图、文档扫描件）转成文本，可选输出适合 AI 读取的 JSON。支持纯 OCR、纯 VLM（Qwen2.5-VL 视觉理解与意图识别）与 Mix（OCR + VLM 顺序执行）三种模式。推理完全在本地进行，图片不会上传。

## 前置条件

- 已执行过 `vcli init`（首次使用会下载模型）。OCR 约 1-2 GB；VLM（Qwen2.5-VL 7B）另需约 8-16 GB，且需 GPU + 8GB 以上显存。
- 若返回 `MODEL_NOT_INSTALLED`，则需要先运行 `vcli init`。
- 升级 code-vcli 后再次运行 `vcli init` 会自动同步最新推理脚本到工作区，无需重新下载模型。
- 支持 Node.js 22+ 与 Python 3.10+。

## 安装与初始化

首次使用需安装 CLI 并初始化视觉模型环境。Agent 在调用前应先确认 `vcli` 可用，必要时引导用户完成以下步骤：

```bash
# 1. 安装 CLI（需要 Node.js 22+）
npm i -g code-vcli

# 2. 初始化视觉模型环境（创建 venv、选计算模式与能力、下载模型）
vcli init

# 跳过交互用默认值：
vcli init --yes
# 指定工作区路径：
vcli init --yes --workspace "E:\code-vcli-data"

# 3. 查看环境信息（含工作区路径、Python、模型状态、已装能力）
vcli info

# 4. 更新到最新版
vcli update
```

### 能力选择（init）

初始化时按提示选择：

- **计算模式**：`CPU`（仅 OCR）或 `GPU`（可装 OCR 和/或 VLM）。
- **能力组合**（GPU 模式）：`仅 OCR` / `仅 VLM` / `都要`（`--mix` 需要两者）。
- **OCR 放置**（GPU + 含 OCR 时）：OCR 跑 `CPU` 还是 `GPU`，推荐 CPU 省显存给 VLM。
- **VLM 量化**（含 VLM 时）：根据显存自动推荐 `BF16`（16GB+）或 `AWQ INT4`（8-15GB），需确认。

已安装环境再次运行 `vcli init` 会先询问是否卸载现有能力：输入 `n`（默认）保留现有安装，仅增量增补/调整能力（例如为「仅 OCR」增加 VLM）；输入 `y` 则卸载后全新安装。

## 工作区与截图管理

`vcli init` 会创建工作区（默认 `~/.code-vcli/`，可用 `--workspace <path>` 自定义），并在其中创建 `files/` 文件夹用于存放截图。

```text
~/.code-vcli/              工作区（默认，可用 vcli info 查看）
├── files/                 截图存放目录（init 时自动创建）
├── models/                模型权重
├── venv/                  Python 虚拟环境
└── state.json             状态文件
```

> 建议引导用户把待识别的截图统一放到 `files/` 文件夹，方便集中管理与复用。通过 `vcli info` 可查看当前工作区路径。

调用时直接引用 `files/` 下的文件：

```bash
vcli run ~/.code-vcli/files/login.png --web --json
```

## 模式选择准则

| 场景 | 模式 | 命令 |
| --- | --- | --- |
| 网页 / UI 截图（需要定位按钮、输入框、卡片等元素） | `--web`（OCR 模式） | `vcli run ./webpage.png --web --json` |
| 普通文档 / 扫描件 / 纯文字图片 | `--ocr`（默认） | `vcli run ./image.png --json` |
| 需要视觉理解与意图识别（看懂画面含义、回答关于图片的问题） | `--vlm` | `vcli run ./image.png --vlm` |
| 既要定位又要理解（先 OCR 再注入 VLM，先定位再理解） | `--mix` | `vcli run ./image.png --mix` |
| 不确定图片类型 | 先向用户确认是「网页/UI」还是「普通文档」再选择 | — |

> OCR 模式：普通模式只做整图 OCR，速度快、带坐标；Web 模式额外运行 YOLO 检测 UI 元素位置，并把文字合并到元素上，适合网页/界面截图。Web 模式下，空文本且置信度低于 `--min-confidence`（默认 0.55）的 UI 误检会自动丢弃。
>
> VLM / Mix 模式：需要 GPU 模式且已安装 VLM 能力（`--mix` 还需 OCR）。`--vlm` 返回结构化的意图识别 JSON（含 `intent` / `summary` / `elements`）；`--mix` 会先做 OCR 把文字注入 VLM，适合既有文字又有布局理解的场景。

## 调用示例

```bash
# OCR 模式，输出纯文本
vcli run ./image.png

# OCR 模式，输出 JSON（AI 调用建议始终加 --json）
vcli run ./image.png --json

# Web 模式（网页/UI 截图）
vcli run ./webpage.png --web

# Web 模式 + JSON
vcli run ./webpage.png --web --json

# VLM 模式（视觉理解与意图识别，需已装 VLM 能力）
vcli run ./image.png --vlm --json

# Mix 模式（先 OCR 再注入 VLM，需已装 both）
vcli run ./webpage.png --mix --json

# VLM/Mix 自定义问题
vcli run ./image.png --vlm -p "这张页面主要的操作是什么？"
```

## 参数说明（run）

| 参数 | 说明 |
| --- | --- |
| `<image>` | 图片路径（必填）。支持 png / jpg / jpeg / webp / bmp / tiff / tif，上限 20 MB |
| `--ocr <ppocrv6>` | OCR 引擎，默认 `ppocrv6` |
| `--vlm` | 使用 VLM 视觉理解（Qwen2.5-VL，需已装 VLM 能力） |
| `--mix` | OCR + VLM 顺序执行，先 OCR 再把文字注入 VLM（需已装 both） |
| `-p, --prompt <text>` | VLM/`--mix` 模式自定义问题（默认有内置模板） |
| `-w, --web` | 启用 YOLO UI 元素检测（OCR 模式下的网页/UI 场景） |
| `--json` | 输出适合 AI 读取的 JSON |
| `--timeout <seconds>` | 本次推理超时（秒） |
| `--min-confidence <0~1>` | 空 UI 元素保留阈值（默认 0.55，仅 `--web` 生效）。空文本且置信度低于该值的 YOLO 误检自动丢弃 |

## JSON 输出字段

```json
{
  "text": "登录\nuser@example.com",
  "items": [
    {
      "text": "登录",
      "bbox": [10, 20, 60, 40],
      "type": "ui_text",
      "geometry": {"aspect": 2.5, "region": "top-right"},
      "cluster": {"id": 0, "size": 5, "arrangement": "horizontal", "region": "top"}
    }
  ],
  "layout": {
    "img_size": [1920, 1080],
    "item_count": 12,
    "patterns": {
      "has_top_nav": true,
      "has_form": false,
      "has_grid": false,
      "has_sidebar": false,
      "has_footer": false
    },
    "cluster_summary": [
      {"id": 0, "size": 5, "arrangement": "horizontal", "region": "top"}
    ]
  }
}
```

| 顶层字段 | 类型 | 说明 |
| --- | --- | --- |
| `text` | string | 全文识别结果，各项用 `\n` 连接 |
| `items` | array | 识别项数组 |
| `layout` | object | 仅 Web 模式：页面级布局分析（聚类、页面模式），用于辅助 LLM 推断意图，详见下方说明 |

`items[]` 结构：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `text` | string | 该项文字；Web 模式下为 UI 元素内合并后的文字 |
| `bbox` | array | 轴对齐矩形 `[x1, y1, x2, y2]` |
| `type` | string | 仅 Web 模式：`ui_element`（无文字的元素）\| `ui_text`（含文字的 UI 元素） |
| `geometry` | object | 仅 Web 模式：几何特征（宽高比、九宫格区域），语言无关 |
| `cluster` | object | 仅 Web 模式：所属空间聚类信息（组内元素数、排列方式、区域） |

### 布局分析说明（仅 Web 模式）

`layout.patterns` 字段提供页面级结构线索，完全基于空间关系，**语言无关**：

| 模式 | 含义 |
| --- | --- |
| `has_top_nav` | 顶部有横向排列的导航栏 |
| `has_form` | 中心区域有纵向排列的表单 |
| `has_grid` | 有网格状排列的卡片/图标 |
| `has_sidebar` | 左侧有纵向侧边栏 |
| `has_footer` | 底部有横向页脚 |

`items[].geometry` 提供单元素几何特征：`region` 为九宫格区域（top-left / top-center / top-right / center / bottom-left 等），`aspect` 为宽高比（>8 多为输入框或按钮，<1.2 多为图标）。

> LLM 结合 `geometry` + `cluster` + `layout.patterns` 可推断元素意图（如 `cluster` 为 form 区域 + `geometry.aspect` > 8 → 输入框；`cluster` 为 top nav + `type` 为 ui_text → 导航按钮），无需硬编码关键词。

### VLM / Mix 模式输出（--vlm / --mix）

VLM 与 Mix 模式在 OCR 字段基础上追加视觉理解字段：

| 顶层字段 | 类型 | 说明 |
| --- | --- | --- |
| `intent` | string | VLM 推断的页面/图片意图（如 `login` / `register` / `dashboard`） |
| `summary` | string | VLM 对画面内容的自然语言总结 |
| `elements` | array | VLM 识别出的关键 UI 元素/操作点 |
| `raw` | string | VLM 原始输出文本 |
| `engine` | string | 使用的引擎（`ocr` / `vlm` / `mix`） |

> Mix 模式会先执行 OCR 提取文字，再把文字注入 VLM，使其既有坐标定位又有画面理解；`--prompt` 可自定义问题。需要 GPU 模式且已安装对应能力。

## 错误码对照表

失败时走 stderr，非零退出码，JSON 输出形如：

```json
{"ok": false, "error": {"code": "MODEL_TEXT_EMPTY", "message": "未识别到文字"}}
```

| 错误码 | 含义 | 处理建议 |
| --- | --- | --- |
| `MODEL_NOT_INSTALLED` | 视觉模型未安装 | 先运行 `vcli init` |
| `MODEL_TEXT_EMPTY` | 图片中未识别到文字 | 换一张更清晰的图片，或确认是否误用 Web 模式 |
| `IMAGE_READ_ERROR` | 无法访问图片 / 路径不存在 | 检查文件路径 |
| `IMAGE_FORMAT_UNSUPPORTED` | 不支持的图片格式 | 使用 png/jpg/webp/bmp/tiff |
| `IMAGE_TOO_LARGE` | 图片超过 20 MB | 压缩后重试 |
| `MODEL_RUNTIME_MISSING` | Python 运行时或推理脚本丢失 | 重新运行 `vcli init` |
| `MODEL_INITIALIZATION_FAILED` | 模型初始化/下载失败 | 重新运行 `vcli init`，检查网络 |
| `MODEL_RECOGNITION_FAILED` | 推理失败 / 超时 / 输出解析失败 | 可加 `--timeout`，或重试 |
| `INVALID_ARGUMENT` | 参数错误 | 检查命令与参数 |
| `CANCELLED` | 用户取消 | 无需处理 |

## 其他命令

| 命令 | 说明 |
| --- | --- |
| `vcli init [--yes] [--workspace <path>]` | 初始化视觉模型环境（工作区 + venv + 模型下载） |
| `vcli info` | 显示环境信息（Python / 模型 / 状态） |
| `vcli update` | 更新到最新版 |
| `vcli install [--force]` | 安装到用户目录并加入 PATH |
| `vcli version [--check]` | 查看版本 |
| `vcli help` | 查看帮助 |
