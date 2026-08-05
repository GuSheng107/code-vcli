# code-vcli — 为 AI 模型提供 web 开发视觉能力

AI 编码模型（如 GLM、DeepSeek、Qwen-max）能写代码，但**无法「看见」屏幕**。

`code-vcli` 给它们一双眼睛：把截图 / 网页截图 / 文档图片转成结构化文本和 JSON，让没有视觉能力的模型也能看懂 UI 布局、按钮位置、卡片结构，准确完成 web 开发任务。

推理在本地完成，图片不上传。

## 平台

- Windows 10/11
- macOS（Apple Silicon / Intel）
- Linux（x64 / arm64）

需要 Node.js 22+ 和 Python 3.10+。

## 安装

```bash
npm i code-vcli
```

安装会自动写入 `vcli` 启动入口并加入 PATH。完成后新开终端即可使用：

```bash
vcli help
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

## 使用

```bash
vcli run ./image.png          # 普通模式：整图 OCR
vcli run ./screenshot.png --web  # Web 模式：网页截图，叠加 YOLO 元素检测
vcli run ./image.png --json   # JSON 输出（AI 调用建议始终加 --json）
```

### AI 调用场景

对于 AI 编码 Agent，推荐始终使用 `--json` 输出，便于解析 UI 元素的结构化信息：

```bash
vcli run ./webpage.png --web --json
```

输出示例：

```json
{
  "ok": true,
  "text": "登录\n注册\n用户名",
  "items": [
    {
      "text": "登录",
      "confidence": 0.98,
      "bbox": [10, 20, 60, 40],
      "source": "yolo+ocr",
      "type": "ui_text"
    }
  ],
  "engine": "web"
}
```

Web 模式原理：先用 PP-OCRv6 全图识字，再用 YOLO 定位按钮、输入框、卡片等 UI 元素，通过 IoU、中心点距离、面积比把文字归到对应元素上，最后按位置排序输出。

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
    --json                 JSON 输出
    --timeout <seconds>    推理超时
```

支持 `png` / `jpg` / `jpeg` / `webp` / `bmp` / `tiff` / `tif`，上限 20 MB。

## 模型

- PP-OCRv6（RapidOCR + OpenVINO）：整图 OCR，速度快，带坐标
- OmniParser V2 YOLO：UI 元素检测（`--web` 启用）

## 隐私

图片本地处理不上传，无遥测。

## AI Agent Skill

`.trae/skills/code-vcli-ocr/SKILL.md` 提供模式选择、调用示例、JSON 字段和错误码说明，供 AI Agent 调用 code-vcli 时参考。

## 开发

```bash
npm install
npm run check    # 类型检查
npm run build    # 编译到 dist/
```

## 许可

[AGPL-3.0-or-later](./LICENSE)。