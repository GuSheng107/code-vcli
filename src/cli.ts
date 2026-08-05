#!/usr/bin/env node

import { stderr, stdout } from "node:process";
import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";

import { ConfigStore, resolveWorkspacePath } from "./config.js";
import { VcliError, toVcliError } from "./errors.js";
import { promptEnterOrEscape, promptText } from "./input.js";
import { compareVersions, getLatestVersion, installCurrentPackage, updateFromRegistry } from "./installer.js";
import { getPackageInfo } from "./package-info.js";
import { getConfigRoot } from "./paths.js";
import {
  buildInteractiveFrame,
  clearScreen,
  getInteractiveMenuItems,
  selectInteractiveMenu,
} from "./ui.js";
import { VisionStateStore } from "./ocr/feature-state.js";
import { installVisionFeature, checkPythonAvailable } from "./ocr/feature-installer.js";
import { runVisionInference } from "./ocr/python-bridge.js";
import {
  PPOCR_MODEL_DISPLAY,
  OMNIPARSER_MODEL_DISPLAY,
  VISION_OCR_ENGINES,
  VISION_DOWNLOAD_SIZE_ESTIMATE,
  VISION_SUPPORTED_EXTENSIONS,
  IMAGE_MAX_BYTES,
  PYTHON_MIN_VERSION,
} from "./ocr/constants.js";
import type { VisionOcrEngineType } from "./ocr/constants.js";

const DISCLAIMER = "code-vcli — 为 AI 模型提供 web 开发视觉能力的 CLI 工具";

const HELP = `${DISCLAIMER}

Usage:
  code-vcli [command]

Commands:
  code-vcli                  打开交互界面
  init [--yes] [--workspace <path>] [--reset-workspace]  初始化视觉模型环境
  run <image> [options]      对图片执行视觉识别
  info                       显示 code-vcli 与系统环境信息
  update                     从 npm Registry 更新到最新版
  install [--force]          安装到用户目录并加入 PATH
  version [--check]          显示版本，可检查 npm 最新版本
  help                       显示帮助

Init Options:
  --yes                      跳过所有交互确认，使用默认值
  --workspace <path>         指定工作区路径（存放 venv + 模型，约 1-2 GB）
  --reset-workspace          重新选择工作区路径

Run Options:
  <image>                    图片文件路径（必填）
      --ocr <ppocrv6>        OCR 引擎（默认 ppocrv6）
  -w, --web                  启用 YOLO UI 元素检测（网页/UI 场景）
      --json                 输出适合 AI 读取的 JSON
      --timeout <seconds>    本次推理超时
      --min-confidence <0~1> 空 UI 元素保留阈值（默认 0.55，仅 --web 生效）
  -h, --help                 显示帮助

OCR Engine:
  ppocrv6   ${PPOCR_MODEL_DISPLAY}（工业级，速度快，带坐标）

Web Mode:
  启用 OmniParser YOLO 检测 UI 元素位置，与 OCR 文字合并输出。
  仅在网页/UI 截图场景使用，普通文档截图无需启用。

Init:
  需要 Python ${PYTHON_MIN_VERSION}+ 环境
  模型缓存位置：~/.code-vcli/models/
  下载大小：${VISION_DOWNLOAD_SIZE_ESTIMATE}
  首次使用前必须运行 code-vcli init

Examples:
  code-vcli init
  code-vcli init --yes
  code-vcli run ./image.png
  code-vcli run ./image.png --json
  code-vcli run ./image.png --web
  code-vcli run ./image.png --web --json
  code-vcli info
  code-vcli update
  code-vcli help
`;

interface RunArguments {
  image?: string;
  ocr?: VisionOcrEngineType;
  web: boolean;
  json: boolean;
  timeoutMs?: number;
  minConfidence?: number;
}

function isVisionOcrEngine(value: string): value is VisionOcrEngineType {
  return (VISION_OCR_ENGINES as readonly string[]).includes(value);
}

function parseRunArguments(args: string[]): RunArguments {
  const parsed: RunArguments = { web: false, json: false };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--ocr") {
      const value = requireOptionValue(args, index, arg);
      if (!isVisionOcrEngine(value)) {
        throw new VcliError(
          "INVALID_ARGUMENT",
          `--ocr 仅支持：${VISION_OCR_ENGINES.join(", ")}`,
          2,
        );
      }
      parsed.ocr = value;
      index += 1;
    } else if (arg === "-w" || arg === "--web") {
      parsed.web = true;
    } else if (arg === "--timeout") {
      const seconds = Number(requireOptionValue(args, index, arg));
      index += 1;
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new VcliError("INVALID_ARGUMENT", "--timeout 必须是正数秒", 2);
      }
      parsed.timeoutMs = Math.round(seconds * 1000);
    } else if (arg === "--min-confidence") {
      const value = Number(requireOptionValue(args, index, arg));
      index += 1;
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new VcliError("INVALID_ARGUMENT", "--min-confidence 必须在 0~1 之间", 2);
      }
      parsed.minConfidence = value;
    } else if (arg?.startsWith("-")) {
      throw new VcliError("INVALID_ARGUMENT", `未知参数：${arg}`, 2);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  if (positional.length > 0) {
    const first = positional[0];
    if (first !== undefined) {
      parsed.image = first;
    }
  }
  return parsed;
}

function requireOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new VcliError("INVALID_ARGUMENT", `${option} 缺少参数值`, 2);
  }
  return value;
}

async function validateImageFile(imagePath: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(imagePath);
  } catch (error) {
    throw new VcliError(
      "IMAGE_READ_ERROR",
      `无法访问图片：${imagePath}`,
      6,
      { cause: error },
    );
  }
  if (!stats.isFile()) {
    throw new VcliError("IMAGE_READ_ERROR", `不是文件：${imagePath}`, 6);
  }
  if (stats.size > IMAGE_MAX_BYTES) {
    throw new VcliError(
      "IMAGE_TOO_LARGE",
      `图片大小 ${Math.round(stats.size / 1024 / 1024)}MB 超过上限 ${IMAGE_MAX_BYTES / 1024 / 1024}MB`,
      6,
    );
  }
  const ext = path.extname(imagePath).toLowerCase();
  if (!(VISION_SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new VcliError(
      "IMAGE_FORMAT_UNSUPPORTED",
      `不支持的图片格式：${ext}（支持：${VISION_SUPPORTED_EXTENSIONS.join(", ")}）`,
      6,
    );
  }
}

async function promptWorkspaceSelection(configStore: ConfigStore): Promise<string> {
  const defaultWorkspace = await configStore.getWorkspace();
  const prompt = [
    "选择 code-vcli 工作区路径（用于存放 venv 和模型权重，约 1-2 GB）",
    "",
    `默认路径：${defaultWorkspace}`,
    "如需使用其他盘符，请输入完整路径，例如：E:\\code-vcli-data",
    "直接回车使用默认路径：",
  ].join("\n");
  const input = (await promptText(prompt)).trim();
  if (!input) {
    return defaultWorkspace;
  }
  const resolved = await resolveWorkspacePath(input);
  await configStore.setWorkspace(resolved);
  stdout.write(`工作区已设置为：${resolved}\n`);
  return resolved;
}

async function runInitCommand(
  configStore: ConfigStore,
  stateStore: VisionStateStore,
  args: string[],
): Promise<void> {
  const yes = args.includes("--yes");
  const resetWorkspace = args.includes("--reset-workspace");
  const workspaceFlagIdx = args.indexOf("--workspace");
  const workspaceFlagValue = workspaceFlagIdx >= 0 ? args[workspaceFlagIdx + 1] : undefined;

  // 优先级：--workspace <path> > 交互选择 > 已有配置 > 默认路径
  if (workspaceFlagValue) {
    const resolved = await resolveWorkspacePath(workspaceFlagValue);
    await configStore.setWorkspace(resolved);
    stdout.write(`工作区已设置为：${resolved}\n`);
  } else {
    // 选择工作区路径（首次 init 或 --reset-workspace 时提示）
    const currentWorkspace = await configStore.getWorkspace();
    const configExists = currentWorkspace !== getConfigRoot();
    if (!configExists || resetWorkspace) {
      if (yes) {
        // --yes 模式使用默认路径或已有路径
        if (!configExists) {
          await configStore.setWorkspace(currentWorkspace);
        }
      } else {
        await promptWorkspaceSelection(configStore);
      }
    }
  }

  const workspace = await configStore.getWorkspace();
  // 用工作区路径构造 stateStore，使其读写工作区下的 state.json
  const workspaceStateStore = new VisionStateStore(workspace);
  await installVisionFeature(workspaceStateStore, workspace, {
    yes,
    prompt: async (message: string) => promptText(message),
  });
  await configStore.setInitialized();
  stdout.write(`code-vcli 视觉模型环境已就绪。\n工作区：${workspace}\n`);
}

async function runRunCommand(
  stateStore: VisionStateStore,
  args: string[],
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    stdout.write(HELP);
    return;
  }
  const parsed = parseRunArguments(args);
  if (!parsed.image) {
    throw new VcliError("INVALID_ARGUMENT", "必须指定图片路径：code-vcli run <image>", 2);
  }

  const imagePath = path.resolve(parsed.image);
  await validateImageFile(imagePath);

  const ocrEngine = parsed.ocr ?? "ppocrv6";
  const webMode = parsed.web;
  const modeDesc = webMode ? `web + ${ocrEngine}` : ocrEngine;
  stderr.write(`正在识别…（模式：${modeDesc}）\n`);

  const result = await runVisionInference(stateStore, imagePath, ocrEngine, webMode, {
    ...(parsed.timeoutMs ? { timeoutMs: parsed.timeoutMs } : {}),
    ...(parsed.minConfidence !== undefined ? { minConfidence: parsed.minConfidence } : {}),
  });

  if (parsed.json) {
    stdout.write(`${JSON.stringify({
      ok: true,
      text: result.text,
      items: result.items,
      engine: result.engine,
      ocr: result.ocr,
      model: result.model,
    }, null, 2)}\n`);
  } else {
    stdout.write(`${result.text}\n`);
  }
}

async function runInfoCommand(
  configStore: ConfigStore,
  stateStore: VisionStateStore,
): Promise<void> {
  const packageInfo = await getPackageInfo();
  const configStatus = await configStore.status();
  const visionState = await stateStore.read();
  const pythonInfo = await checkPythonAvailable();

  const lines: string[] = [
    "code-vcli 环境信息",
    "==============",
    "",
    `版本：v${packageInfo.version}`,
    `配置目录：${configStore.directory}（轻量 config.json）`,
    `工作区：${configStatus.workspace}（venv + 模型权重）`,
    `已初始化：${configStatus.initialized ? "是" : "否"}`,
    `初始化时间：${configStatus.initializedAt ?? "—"}`,
    "",
    "系统环境",
    "----------",
    `操作系统：${process.platform} ${process.arch}`,
    `Node.js：${process.versions.node}`,
    `主机：${os.hostname()}`,
    `CPU：${os.cpus()[0]?.model ?? "未知"}`,
    `内存：${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
    "",
    "Python 环境",
    "----------",
    `检测到 Python：${pythonInfo ? `${pythonInfo.version}（${pythonInfo.path}）` : "未找到"}`,
    `最低要求：Python ${PYTHON_MIN_VERSION}+`,
    "",
    "视觉模型",
    "----------",
    `状态：${visionState?.status ?? "none"}`,
    `已验证：${visionState?.verified ? "是" : "否"}`,
    `Python 版本：${visionState?.python_version ?? "—"}`,
    `安装时间：${visionState?.installed_at ?? "—"}`,
    `模型目录：${path.join(configStatus.workspace, "models")}`,
    `venv 目录：${path.join(configStatus.workspace, "venv")}`,
    "",
    "OCR 引擎",
    "----------",
    `ppocrv6   — ${PPOCR_MODEL_DISPLAY}（工业级，速度快，带坐标）`,
    "",
    "Web 模式",
    "----------",
    `${OMNIPARSER_MODEL_DISPLAY}（网页/UI 元素检测，--web 启用）`,
    "",
    `下载大小（首次 init）：${VISION_DOWNLOAD_SIZE_ESTIMATE}`,
  ];
  stdout.write(`${lines.join("\n")}\n`);
}

async function runVersionCommand(args: string[]): Promise<void> {
  const current = (await getPackageInfo()).version;
  stdout.write(`code-vcli ${current}\n`);
  if (args.includes("--check")) {
    const latest = await getLatestVersion();
    const comparison = compareVersions(latest, current);
    stdout.write(
      comparison > 0
        ? `发现新版本 ${latest}，运行 code-vcli update 更新\n`
        : comparison === 0
          ? "已是最新版本\n"
          : `本地版本 ${current} 高于 npm 当前版本 ${latest}，无需更新\n`,
    );
  }
}

async function runUpdateCommand(): Promise<void> {
  await updateFromRegistry();
  stdout.write("code-vcli 已更新到最新版本\n");
}

async function runInstallCommand(args: string[]): Promise<void> {
  const directory = await installCurrentPackage(args.includes("--force"));
  stdout.write(`code-vcli 已安装到 ${directory}\n请重新打开终端使 PATH 生效。\n`);
}

async function pauseInteractive(): Promise<void> {
  await promptEnterOrEscape("\nEnter 或 Esc 返回主菜单");
}

function renderInteractivePage(
  version: string,
  initialized: boolean,
  items: ReturnType<typeof getInteractiveMenuItems>,
  content: string,
): void {
  clearScreen();
  const frame = buildInteractiveFrame({
    version,
    initialized,
    items,
    selectedIndex: -1,
    color: !process.env.NO_COLOR,
  });
  stdout.write(`${frame.split("\n").slice(0, 12).join("\n")}\n\n${content}\n`);
}

async function runInteractive(configStore: ConfigStore): Promise<void> {
  const packageInfo = await getPackageInfo();
  while (true) {
    const configStatus = await configStore.status();
    const stateStore = new VisionStateStore(configStatus.workspace);
    const visionReady = await stateStore.isReady();
    const initialized = configStatus.initialized && visionReady;
    const items = getInteractiveMenuItems(initialized);
    const action = await selectInteractiveMenu({
      version: packageInfo.version,
      initialized,
      items,
    });
    if (!action || action === "exit") {
      clearScreen();
      stdout.write("code-vcli 已退出。\n");
      return;
    }

    clearScreen();
    try {
      if (action === "init") {
        renderInteractivePage(packageInfo.version, initialized, items, "初始化视觉模型环境");
        await runInitCommand(configStore, stateStore, []);
      } else if (action === "run") {
        if (!initialized) {
          stderr.write("视觉模型尚未安装，请先运行 init。\n");
        } else {
          renderInteractivePage(packageInfo.version, initialized, items, "识别图片");
          const imagePath = (await promptText("图片路径：")).trim();
          if (!imagePath) continue;

          const webInput = (await promptText("网页/UI 场景？ [y/n]（回车默认 n）：")).trim().toLowerCase();
          const webMode = webInput === "y" || webInput === "yes";

          const runArgs = [imagePath, "--ocr", "ppocrv6"];
          if (webMode) runArgs.push("--web");
          await runRunCommand(stateStore, runArgs);
        }
      } else if (action === "info") {
        renderInteractivePage(packageInfo.version, initialized, items, "环境信息");
        await runInfoCommand(configStore, stateStore);
      } else if (action === "update") {
        renderInteractivePage(packageInfo.version, initialized, items, "检查版本更新");
        const latest = await getLatestVersion();
        const comparison = compareVersions(latest, packageInfo.version);
        if (comparison > 0) {
          stdout.write(`当前版本：v${packageInfo.version}\nnpm 最新版本：v${latest}\n`);
          const decision = await promptEnterOrEscape("\nEnter 更新 · Esc 返回主菜单");
          if (decision === "escape") continue;
          await runUpdateCommand();
        } else if (comparison === 0) {
          stdout.write(`已是最新版本（本地与 npm 均为 v${packageInfo.version}）\n`);
        } else {
          stdout.write(`本地版本 v${packageInfo.version} 高于 npm 当前版本 v${latest}，无需更新。\n`);
        }
      } else if (action === "help") {
        clearScreen();
        stdout.write(HELP);
      }
    } catch (error) {
      const vcliError = toVcliError(error);
      if (vcliError.code === "CANCELLED") continue;
      stderr.write(`\n错误 [${vcliError.code}]：${vcliError.message}\n`);
    }
    await pauseInteractive();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const configStore = new ConfigStore();
      await runInteractive(configStore);
    } else {
      stdout.write(HELP);
    }
    return;
  }
  const commandArgs = args.slice(1);
  const configStore = new ConfigStore();
  const workspace = await configStore.getWorkspace();
  const stateStore = new VisionStateStore(workspace);

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      stdout.write(HELP);
      return;
    case "init":
      await runInitCommand(configStore, stateStore, commandArgs);
      return;
    case "run":
      await runRunCommand(stateStore, commandArgs);
      return;
    case "info":
      await runInfoCommand(configStore, stateStore);
      return;
    case "version":
      await runVersionCommand(commandArgs);
      return;
    case "update":
      await runUpdateCommand();
      return;
    case "install": {
      await runInstallCommand(commandArgs);
      return;
    }
    default:
      throw new VcliError("INVALID_ARGUMENT", `未知命令：${command}。运行 code-vcli help 查看用法`, 2);
  }
}

main().catch((error: unknown) => {
  const vcliError = toVcliError(error);
  const jsonOutput = process.argv.includes("--json");
  if (jsonOutput) {
    stderr.write(`${JSON.stringify({ ok: false, error: { code: vcliError.code, message: vcliError.message } })}\n`);
  } else {
    stderr.write(`错误 [${vcliError.code}]：${vcliError.message}\n`);
  }
  process.exitCode = vcliError.exitCode;
});
