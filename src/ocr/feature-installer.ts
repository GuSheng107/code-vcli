import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { stdout } from "node:process";

import {
  OCR_MODEL_DISPLAY,
  OCR_LANGUAGES,
  OCR_DOWNLOAD_SIZE_ESTIMATE,
  OCR_REQUIREMENTS_FILE_NAME,
  OCR_SCRIPT_FILE_NAME,
  OCR_STAGING_DIR_NAME,
  OCR_VENV_DIR_NAME,
  PYTHON_MIN_VERSION,
  OCR_CANVAS_PACKAGE,
  OCR_CANVAS_VERSION,
} from "./constants.js";
import { TransxError } from "../errors.js";
import { getVenvPython, runOcrSelfTest } from "./python-bridge.js";
import type { OcrFeatureStateStore } from "./feature-state.js";
import { getPackageInfo } from "../package-info.js";
import { parseYesNo } from "../input.js";
import { runNpm } from "../installer.js";

const execFileAsync = promisify(execFile);

export interface InstallResult {
  success: boolean;
  message: string;
}

export async function checkPythonAvailable(): Promise<{ path: string; version: string } | null> {
  const candidates = process.platform === "win32"
    ? ["python", "python3", "py"]
    : ["python3", "python"];

  for (const candidate of candidates) {
    try {
      const args = candidate === "py" ? ["-3", "--version"] : ["--version"];
      const { stdout, stderr } = await execFileAsync(candidate, args, { windowsHide: true });
      const output = (stdout || stderr).trim();
      const match = output.match(/Python (\d+)\.(\d+)\.(\d+)/);
      if (!match) continue;
      const major = Number(match[1]);
      const minor = Number(match[2]);
      const minParts = PYTHON_MIN_VERSION.split(".").map(Number);
      const minMajor = minParts[0] ?? 3;
      const minMinor = minParts[1] ?? 10;
      if (major < minMajor || (major === minMajor && minor < minMinor)) continue;
      return { path: candidate, version: `${major}.${minor}.${match[3]}` };
    } catch {
      continue;
    }
  }
  return null;
}

export async function installOcrFeature(
  stateStore: OcrFeatureStateStore,
  options: { yes: boolean; prompt: (message: string) => Promise<string> },
): Promise<InstallResult> {
  if (await stateStore.isReady()) {
    return { success: true, message: "图片识别翻译扩展已安装" };
  }

  const pythonInfo = await checkPythonAvailable();
  if (!pythonInfo) {
    throw new TransxError(
      "OCR_RUNTIME_MISSING",
      `未找到 Python ${PYTHON_MIN_VERSION}+ 环境。图片识别翻译扩展需要 Python，请安装后重试。下载地址：https://www.python.org/downloads/`,
      6,
    );
  }

  if (!options.yes) {
    const promptText = [
      "图片识别翻译扩展尚未安装。",
      "",
      `模型：${OCR_MODEL_DISPLAY}`,
      "方式：本地离线 OCR",
      `语言：${OCR_LANGUAGES}`,
      "隐私：图片不会上传；确认后才发送识别文字",
      `下载大小：${OCR_DOWNLOAD_SIZE_ESTIMATE}`,
      "安装位置：~/.transx/features/ocr/",
      "依赖：需要 Python 环境（已检测到）",
      "",
      "是否下载并开启？ [y/n] ",
    ].join("\n");
    let answer: boolean | null = null;
    let currentPrompt = promptText;
    while (answer === null) {
      answer = parseYesNo(await options.prompt(currentPrompt));
      currentPrompt = "是否下载并开启？ [y/n] ";
    }
    if (answer !== true) {
      throw new TransxError("OCR_INSTALL_DECLINED", "用户取消安装", 6);
    }
  }

  await stateStore.writeStatus("downloading");

  const packageInfo = await getPackageInfo();
  const resourcesDir = path.join(packageInfo.root, "resources", "ocr");
  const featureDir = stateStore.featureDirectory;
  const stagingDir = path.join(featureDir, `${OCR_STAGING_DIR_NAME}-${randomUUID()}`);

  try {
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    await stateStore.writeStatus("installing");

    const venvDir = path.join(stagingDir, OCR_VENV_DIR_NAME);
    await createVenv(pythonInfo.path, venvDir);

    const venvPython = getVenvPython(stagingDir);
    const requirementsSrc = path.join(resourcesDir, OCR_REQUIREMENTS_FILE_NAME);
    const requirementsDst = path.join(stagingDir, OCR_REQUIREMENTS_FILE_NAME);
    await cp(requirementsSrc, requirementsDst, { force: true });
    await installRequirements(venvPython, requirementsDst);

    // 安装 Node 端 PDF 渲染依赖（PDF OCR 需要）
    await ensureCanvasDependency(packageInfo.root);

    const scriptSrc = path.join(resourcesDir, OCR_SCRIPT_FILE_NAME);
    const scriptDst = path.join(stagingDir, OCR_SCRIPT_FILE_NAME);
    await cp(scriptSrc, scriptDst, { force: true });

    await stateStore.writeStatus("verifying");
    const verified = await runOcrSelfTest(venvPython, scriptDst);
    if (!verified) {
      throw new TransxError("OCR_INITIALIZATION_FAILED", "OCR 自检失败，模型可能未正确安装", 6);
    }

    // 原子切换：移除旧文件，移动 staging 内容到正式目录
    const productionVenv = path.join(featureDir, OCR_VENV_DIR_NAME);
    const productionScript = path.join(featureDir, OCR_SCRIPT_FILE_NAME);
    const productionRequirements = path.join(featureDir, OCR_REQUIREMENTS_FILE_NAME);

    await rm(productionVenv, { recursive: true, force: true });
    await rm(productionScript, { force: true });
    await rm(productionRequirements, { force: true });

    await rename(venvDir, productionVenv);
    await rename(scriptDst, productionScript);
    await rename(requirementsDst, productionRequirements);
    await rm(stagingDir, { recursive: true, force: true });

    await stateStore.writeReady();

    return { success: true, message: "图片识别翻译扩展已安装" };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    await stateStore.writeStatus("broken");
    if (error instanceof TransxError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new TransxError("OCR_INSTALL_FAILED", `安装失败：${detail}`, 6, { cause: error });
  }
}

export async function removeOcrFeature(stateStore: OcrFeatureStateStore): Promise<void> {
  await stateStore.clear();
}

async function createVenv(pythonPath: string, venvDir: string): Promise<void> {
  try {
    await execFileAsync(pythonPath, ["-m", "venv", venvDir], { windowsHide: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TransxError("OCR_INSTALL_FAILED", `创建虚拟环境失败：${detail}`, 6, { cause: error });
  }
}

async function installRequirements(venvPython: string, requirementsPath: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        venvPython,
        ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", requirementsPath],
        { windowsHide: true, stdio: ["ignore", "inherit", "inherit"] },
      );
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error("安装 Python 依赖超时"));
      }, 600_000);
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`pip 退出码 ${code ?? "unknown"}`));
      });
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TransxError("OCR_INSTALL_FAILED", `安装 Python 依赖失败：${detail}`, 6, { cause: error });
  }
}

async function ensureCanvasDependency(packageRoot: string): Promise<void> {
  // 先检测是否已可加载（CLI 目录已安装则跳过）
  try {
    await import("@napi-rs/canvas");
    return;
  } catch {
    // 未安装或 native 二进制加载失败，继续尝试安装
  }

  stdout.write(`正在安装 PDF 渲染依赖 ${OCR_CANVAS_PACKAGE}@${OCR_CANVAS_VERSION}…\n`);
  try {
    await runNpm(
      [
        "install",
        `${OCR_CANVAS_PACKAGE}@${OCR_CANVAS_VERSION}`,
        "--no-save",
        "--no-package-lock",
        "--fund=false",
        "--audit=false",
        "--prefix",
        packageRoot,
      ],
      { timeout: 300_000 },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TransxError(
      "OCR_INSTALL_FAILED",
      `PDF 渲染依赖 ${OCR_CANVAS_PACKAGE} 安装失败：${detail}`,
      6,
      { cause: error },
    );
  }

  // 安装后再次验证加载，区分"未安装"与"native 二进制不支持当前平台"
  try {
    await import("@napi-rs/canvas");
    stdout.write(`${OCR_CANVAS_PACKAGE} 安装完成。\n`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TransxError(
      "OCR_INSTALL_FAILED",
      `PDF 渲染依赖 ${OCR_CANVAS_PACKAGE} 已安装但加载失败，当前平台可能不支持：${detail}`,
      6,
      { cause: error },
    );
  }
}
