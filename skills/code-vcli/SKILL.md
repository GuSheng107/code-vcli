---
name: code-vcli
description: 使用 vcli CLI 对截图/图片执行本地视觉识别（OCR）与网页 UI 元素解析。当需要把屏幕截图、网页截图、文档图片转成文本或结构化 JSON 时使用。支持普通模式（PP-OCRv6）与 Web 模式（叠加 YOLO UI 检测）。
---

# code-vcli — 为 AI 模型提供 Web 开发视觉能力

`code-vcli` 是一个面向 AI 编码模型的本地视觉识别 CLI：把一张图片（截图、网页截图、文档扫描件）转成文本，可选输出适合 AI 读取的 JSON。推理完全在本地进行，图片不会上传。

## 前置条件

- 已执行过 `vcli init`（首次使用会下载模型，约 1-2 GB）。
- 若返回 `MODEL_NOT_INSTALLED`，则需要先运行 `vcli init`。
- 升级 code-vcli 后再次运行 `vcli init` 会自动同步最新推理脚本到工作区，无需重新下载模型。
- 支持 Node.js 22+ 与 Python 3.10+。

## 安装与初始化

首次使用需安装 CLI 并初始化视觉模型环境。Agent 在调用前应先确认 `vcli` 可用，必要时引导用户完成以下步骤：

```bash
# 1. 安装 CLI（需要 Node.js 22+）
npm i -g code-vcli

# 2. 初始化视觉模型环境（创建 venv、选计算模式、下载模型，约 1-2 GB）
vcli init

# 跳过交互用默认值：
vcli init --yes
# 指定工作区路径：
vcli init --yes --workspace "E:\code-vcli-data"

# 3. 查看环境信息（含工作区路径、Python、模型状态）
vcli info

# 4. 更新到最新版
vcli update
```

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
| 网页 / UI 截图（需要定位按钮、输入框、卡片等元素） | `--web` | `vcli run ./webpage.png --web --json` |
| 普通文档 / 扫描件 / 纯文字图片 | 默认（普通模式，PP-OCRv6） | `vcli run ./image.png --json` |
| 不确定图片类型 | 先向用户确认是「网页/UI」还是「普通文档」再选择 | — |

> 普通模式只做整图 OCR，速度快、带坐标；Web 模式额外运行 YOLO 检测 UI 元素位置，并把文字合并到元素上，适合网页/界面截图。普通文档无需启用 `--web`。Web 模式下，空文本且置信度低于 `--min-confidence`（默认 0.55）的 UI 误检会自动丢弃。

## 调用示例

```bash
# 普通模式，输出纯文本
vcli run ./image.png

# 普通模式，输出 JSON（AI 调用建议始终加 --json）
vcli run ./image.png --json

# Web 模式（网页/UI 截图）
vcli run ./webpage.png --web

# Web 模式 + JSON
vcli run ./webpage.png --web --json
```

## 参数说明（run）

| 参数 | 说明 |
| --- | --- |
| `<image>` | 图片路径（必填）。支持 png / jpg / jpeg / webp / bmp / tiff / tif，上限 20 MB |
| `--ocr <ppocrv6>` | OCR 引擎，默认 `ppocrv6` |
| `-w, --web` | 启用 YOLO UI 元素检测（网页/UI 场景） |
| `--json` | 输出适合 AI 读取的 JSON |
| `--timeout <seconds>` | 本次推理超时（秒） |
| `--min-confidence <0~1>` | 空 UI 元素保留阈值（默认 0.55，仅 `--web` 生效）。空文本且置信度低于该值的 YOLO 误检自动丢弃 |

## JSON 输出字段

```json
{
  "ok": true,
  "text": "第一行\n第二行",
  "items": [
    {
      "text": "登录",
      "confidence": 0.98,
      "bbox": [10, 20, 60, 40],
      "source": "yolo+ocr",
      "type": "ui_text"
    }
  ],
  "engine": "web",
  "ocr": "ppocrv6",
  "model": "OmniParser V2 YOLO + PP-OCRv6 (RapidOCR + OpenVINO)"
}
```

| 顶层字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | boolean | 是否成功 |
| `text` | string | 全文识别结果，各项用 `\n` 连接 |
| `items` | array | 识别项数组 |
| `engine` | string | `web`（Web 模式）或 `ppocrv6`（普通模式） |
| `ocr` | string | OCR 引擎，当前为 `ppocrv6` |
| `model` | string | 实际使用的模型显示名 |

`items[]` 结构：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `text` | string | 该项文字；Web 模式下为 UI 元素内合并后的文字 |
| `confidence` | number | 置信度（0~1） |
| `bbox` | array | 轴对齐矩形 `[x1, y1, x2, y2]` |
| `source` | string | `ppocr`（OCR 文字）\| `yolo`（UI 检测）\| `yolo+ocr`（合并项） |
| `type` | string | 仅 Web 模式：`ui_element`（无文字的元素）\| `ui_text`（含文字的 UI 元素） |

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
