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

## 重置环境

如需清除工作区数据（模型权重、虚拟环境等），重新初始化：

```bash
vcli reset
```

执行后需确认，确认后删除工作区并重置配置，下次需重新运行 `vcli init`。

## 使用

```bash
vcli run ./image.png              # 普通模式：整图 OCR
vcli run ./screenshot.png --web   # Web 模式：网页截图，叠加 YOLO 元素检测
vcli run ./image.png --json       # JSON 输出（AI 调用建议始终加 --json）
```

## AI Agent Skill

仓库提供 `code-vcli` Skill，让 AI Agent 调用 `vcli` CLI 对截图执行本地视觉识别与网页 UI 元素解析。

推荐通过 Skills CLI 全局安装：

```bash
npx skills add GuSheng107/code-vcli --skill code-vcli -g
```

也可以在[文档站 Skills 页面](https://gusheng107.github.io/code-vcli/skills.html)下载 ZIP 手动安装。

## 命令

| 命令 | 说明 |
| --- | --- |
| `vcli` | 交互界面 |
| `vcli init [--yes] [--workspace <path>] [--reset-workspace]` | 初始化环境 |
| `vcli run <image> [options]` | 识别图片 |
| `vcli reset` | 重置环境（删除工作区数据，需重新 init） |
| `vcli info` | 环境信息 |
| `vcli update` | 更新到最新版 |
| `vcli install [--force]` | 安装到用户目录并加入 PATH |
| `vcli version [--check]` | 版本信息 |
| `vcli help` | 帮助 |

## 模型

- PP-OCRv6（RapidOCR + OpenVINO）：整图 OCR，速度快，带坐标
- OmniParser V2 YOLO：UI 元素检测（`--web` 启用）

## 隐私和安全

- 图片本地处理不上传，无遥测。
- 模型缓存位置：`~/.code-vcli/models/`
- 工作区：`~/.code-vcli/` 或自定义路径

## 开发

```bash
npm install
npm run check    # 类型检查
npm run build    # 编译到 dist/
npm run build:skill-zip  # 生成 Skill 下载包
```

要求 Node.js 22 或更高版本。

## 许可

[MIT](./LICENSE)。