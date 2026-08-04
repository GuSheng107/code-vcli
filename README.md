# vcli CLI — DLX 翻译工具

面向终端、脚本和 Agent 的 DLX 翻译工具。

> 感谢 [LINUX DO](https://linux.do/) 社区，没有始皇的福利就没有这个CLI

文档站：https://gusheng107.github.io/vcli/

## 写在最前

**非官方项目。** 本项目不提供 API Key 或翻译服务。

## 平台

- Windows 10/11（PowerShell / CMD / Windows Terminal）
- macOS（Apple Silicon 与 Intel，zsh / bash）
- Linux（x64 / arm64，bash / zsh）

需要 Node.js 22 或更高版本。

## 安装

直接使用 npm 安装：

```bash
npm i vcli
```

安装过程会自动部署运行依赖、用户级 `vcli` 启动入口并加入 PATH，无需再执行 `vcli install` 或手动安装依赖。首次安装后重新打开终端，即可直接运行：

```bash
vcli help
```

安装位置：

```text
Windows：    %LOCALAPPDATA%\.vcli\bin\vcli.cmd
macOS/Linux：~/.vcli/bin/vcli
配置目录：    ~/.vcli/
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

## AI Agent Skill

仓库提供 `vcli-translate` Skill，可选择 Python 脚本、Node.js 脚本或 vcli CLI。三种方式支持相同的文本与文件翻译，并共用 `~/.vcli/history/`。

推荐通过 Skills CLI 全局安装：

```bash
npx skills add GuSheng107/vcli --skill vcli-translate -g
```

首次使用时，Agent 会检测本机环境并让用户选择一种调用方式；之后本地 `SKILL.md` 会精简为对应流程。切换模式只修改 Skill 文档和偏好，不会删除附带脚本或卸载 CLI。

脚本依赖使用固定版本：

```bash
python -m pip install -r ./skills/vcli-translate/requirements.txt
npm ci --omit=dev --prefix ./skills/vcli-translate
```

也可以在[文档站 Skills 页面](https://gusheng107.github.io/vcli/skills.html)下载 ZIP 手动安装。

## 配置 API Key

在 [Linux.do Connect](https://connect.linux.do/) 获取 DLX API Key，然后初始化：

```bash
vcli init
```

Key 是隐藏输入的，保存在 `~/.vcli/credentials.json`，源码、npm 包和日志里都不会出现你的 Key。

非交互环境（比如 CI）可以从 stdin 传：

```bash
printf '%s' "$DLX_API_KEY" | vcli init --key-stdin
```

也可以临时用环境变量 `DLX_API_KEY` 覆盖本地配置，不写盘。

## 翻译

给 AI Agent 调用时建议始终带 `--json`：

```bash
vcli translate "Hello world" --to ZH --json
```

从 stdin 读：

```bash
echo "Hello world" | vcli translate --to ZH --json
```

翻译文件：

```bash
vcli translate --file ./readme.md --to ZH --json
vcli translate --file ./report.docx --to ZH
vcli translate --file ./paper.pdf --to ZH --timeout 60
```

支持 `txt`、`md`、`csv`、`log`、`docx`、`xlsx`、`pptx`、`pdf`。译文默认写入源文件目录，文件名为 `<源文件名>_<目标语言>`；PDF 输出 DOCX。无法创建文件时返回文本或 JSON。

识别图片或文件内图片并翻译（需先开启 OCR 扩展）：

```bash
vcli translate --image ./screenshot.png --to ZH --json
vcli translate --image ./scan.pdf --to ZH --json
```

单条文本上限 1500 字符。文件上限 20MB、可翻译文本上限 100000 字符、最多 500 次请求。文件按段落、同格式文字或单元格拆分，最多 5 个请求并发执行，并输出进度。

完整参数：

```text
-t, --to <lang>              目标语言（必填）
-s, --source <lang>          源语言，默认 auto
-f, --file <path>            从文件提取文本翻译（与位置文本互斥）
    --image <path>           OCR 识别图片或文件内图片，确认后翻译
-o, --output <path>          指定译文文件路径
    --json                   输出 AI 友好的 JSON
    --timeout <seconds>      本次请求超时
```

## 图片识别翻译（OCR）

vcli CLI 先在本地识别文字，生成 `<源文件名>_OCR.md` 并显示预览。用户确认后，中间文件才会进入现有文件翻译流程。

```bash
vcli translate --image ./screenshot.png --to ZH --json
```

支持图片、PDF 页面、DOCX/PPTX 内嵌图片和 Markdown 本地图片。Markdown 远程图片不会下载。输入上限 20MB，最多识别 100 张图片或 100 页 PDF，单张图片上限 4000 万像素。

首次使用需开启 OCR 扩展，CLI 会显示安装信息并询问是否下载：

```bash
vcli ocr enable
```

需要 Python 3.10+，下载约 180 MB。模型为 PP-OCRv6 Quality（基于 RapidOCR + OpenVINO），支持简体中文、繁体中文、英文、日文等 50 种语言。

查看 OCR 扩展状态：

```bash
vcli ocr status
vcli ocr status --json
```

`vcli ocr recognize` 只在本地识别，不调用 DLX。原文、来源、置信度和坐标保存在中间文件；JSON 返回 `recognition_file` 路径和预览：

```bash
vcli ocr recognize ./image.png --json
vcli ocr recognize ./scan.pdf --json
vcli ocr recognize ./report.docx --json
```

删除 OCR 扩展：

```bash
vcli ocr remove --yes
```

OCR 扩展安装在 `~/.vcli/features/ocr/`，与 CLI 主依赖隔离。

`vcli translate --image` 生成中间文件后询问是否翻译。输入 `y` 或 `Y` 后，按普通文件的并发流程翻译；输入 `n`、`N` 或按 Esc 不发送，中间文件仍保留。非交互 `--json` 返回文件路径、预览和 `awaiting_confirmation` 状态。

Skill 使用相同流程：先生成中间文件并征得确认，再调用文件翻译。Node.js 和 CLI 模式支持上述文件范围；Python 模式只支持独立图片。

成功输出：

```json
{"ok":true,"data":"你好，世界","source_lang":"auto","target_lang":"ZH","provider":"dlx"}
```

失败走 stderr，非零退出码，方便脚本捕获：

```json
{"ok":false,"error":{"code":"CONFIG_NOT_INITIALIZED","message":"缺少 DLX API Key，请先运行 vcli init"}}
```

查看支持的语言代码（不需要联网或初始化）：

```bash
vcli languages
vcli languages --json
```

DLX 接口支持 31 个目标语言代码。中文使用 `ZH`（简体）或 `ZH-HANT`（繁体）；源语言可使用 `AUTO`。

## 翻译历史

每条成功的翻译都会落到本地历史，不记录 URL 和 API Key。历史按中国时间拆分到 `YYYY-MM-DD.json`，时间格式 `YYYY-MM-DD HH:mm:ss.SSS`。

```bash
vcli history                         # 最近 20 条
vcli history --limit 50 --offset 100
vcli history --from "2026-08-01" --to "2026-08-03"
vcli history --since 7d --json
```

搜索文本原文/译文或文件记录中的源文件名/译文文件名：

```bash
vcli history search "环境审查" --json
```

查看文件状态、清理：

```bash
vcli history status
vcli history clear --oldest 100
vcli history clear --keep 1000
vcli history clear --older-than 30d --yes
vcli history clear --from "2026-07-01" --to "2026-07-31" --yes
vcli history clear --all --yes
```

查看历史命令自身的帮助：

```bash
vcli history help
```

文件翻译历史只保存源文件和译文文件的路径、文件名，不保存文件正文。历史目录 `~/.vcli/history/`，含 `index.json` 和按日期拆分的文件。

## 配置

```bash
vcli config                  # 查看 URL 模板和完整 API Key
vcli config set-key          # 重新输入 Key（隐藏）
vcli config set-key --stdin  # 从 stdin 读 Key
vcli config reset key        # 删掉 Key
vcli config reset all        # 重置全部
```

`vcli config` 会显示完整 API Key，但不会显示拼接后的请求 URL。

## 版本与更新

```bash
vcli version          # 当前版本
vcli version --check  # 对比 npm 上的最新版
vcli update           # 拉最新版并重新安装
```

`update` 走 npm Registry 拉最新版，原子替换启动入口；旧版本目录会保留，方便排查或回退。

## 隐私和安全

- 待翻译内容会发送到 DLX 服务。
- API Key 存在 `~/.vcli/credentials.json`，POSIX 系统文件权限 0600。
- 不收集任何遥测。
- API Key 不会编译进程序。

## 开发

```bash
npm install
npm run check    # 类型检查
npm test         # 测试
npm run build    # 编译到 dist/
npm pack --dry-run
```

要求 Node.js 22 或更高版本。每次提交会在 Windows、macOS、Linux 三系统跑类型检查、构建和打包检查。

## 许可

[MIT License](./LICENSE)。

## 友情链接

- [LINUX DO](https://linux.do/)
