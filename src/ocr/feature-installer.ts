import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { stdout, stderr } from "node:process";

import {
  PYTHON_MIN_VERSION,
  VISION_REQUIREMENTS_FILE_NAME,
  VISION_SCRIPT_FILE_NAME,
  VISION_STAGING_DIR_NAME,
  VISION_VENV_DIR_NAME,
  VISION_FILES_DIR_NAME,
  OMNIPARSER_MODEL_DISPLAY,
  PPOCR_MODEL_DISPLAY,
  VISION_DOWNLOAD_SIZE_ESTIMATE,
  TORCH_CPU_INDEX,
  TORCH_CUDA_INDEX,
  TORCH_ROCM_INDEX,
  TORCH_VERSION,
  TORCHVISION_VERSION,
  type ComputeMode,
  type GpuVendor,
  type PlatformInfo,
  type ComputeOption,
} from "./constants.js";
import { VcliError } from "../errors.js";
import { getVenvPython, runModelSelfTest, runModelInit } from "./python-bridge.js";
import type { VisionStateStore } from "./feature-state.js";
import { getPackageInfo } from "../package-info.js";
import { parseYesNo } from "../input.js";

const execFileAsync = promisify(execFile);

export interface InstallResult {
  success: boolean;
  message: string;
  pythonVersion: string;
  computeMode: ComputeMode;
}

// ---------------------------------------------------------------------------
// 硬件检测
// ---------------------------------------------------------------------------
export async function detectPlatform(): Promise<PlatformInfo> {
  const os = process.platform === "win32" ? "windows"
    : process.platform === "darwin" ? "macos"
    : process.platform === "linux" ? "linux"
    : "unknown";

  const arch = process.arch === "x64" ? "x64"
    : process.arch === "arm64" ? "arm64"
    : process.arch === "ia32" ? "ia32"
    : "unknown";

  const gpuVendor = await detectGpuVendor(os, arch);

  return { os, arch, gpuVendor };
}

async function detectGpuVendor(os: string, arch: string): Promise<GpuVendor> {
  // macOS ARM64 = Apple Silicon
  if (os === "macos" && arch === "arm64") {
    return "apple";
  }

  // Windows/Linux: try nvidia-smi
  try {
    await execFileAsync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
      timeout: 5000,
      windowsHide: true,
    });
    return "nvidia";
  } catch {
    // Not NVIDIA or nvidia-smi not available
  }

  // Windows: try wmic for AMD
  if (os === "windows") {
    try {
      const { stdout: wmicOut } = await execFileAsync(
        "wmic",
        ["path", "win32_VideoController", "get", "name"],
        { timeout: 5000, windowsHide: true },
      );
      if (/AMD|Radeon/i.test(wmicOut)) return "amd";
    } catch {
      // wmic not available
    }
  }

  // Linux: check /proc or lspci for AMD
  if (os === "linux") {
    try {
      const { stdout: lspciOut } = await execFileAsync("lspci", [], { timeout: 5000 });
      if (/AMD|Radeon/i.test(lspciOut)) return "amd";
    } catch {
      // lspci not available
    }
  }

  return "none";
}

// ---------------------------------------------------------------------------
// CPU/GPU 兼容性验证
// ---------------------------------------------------------------------------
export function checkComputeCompatibility(
  mode: ComputeMode,
  platform: PlatformInfo,
): { compatible: boolean; reason?: string; option?: ComputeOption } {
  if (mode === "cpu") {
    // CPU 模式全平台支持
    return {
      compatible: true,
      option: {
        mode: "cpu",
        gpuVendor: "none",
        torchIndex: TORCH_CPU_INDEX,
        description: "CPU 推理（全平台兼容）",
      },
    };
  }

  // GPU 模式
  const { os, arch, gpuVendor } = platform;

  if (gpuVendor === "nvidia") {
    if (os === "windows" || os === "linux") {
      return {
        compatible: true,
        option: {
          mode: "gpu",
          gpuVendor: "nvidia",
          torchIndex: TORCH_CUDA_INDEX,
          description: "NVIDIA GPU (CUDA 12.6)",
        },
      };
    }
    return { compatible: false, reason: `NVIDIA GPU 仅支持 Windows 和 Linux，当前系统：${os}` };
  }

  if (gpuVendor === "apple") {
    if (os === "macos" && arch === "arm64") {
      return {
        compatible: true,
        option: {
          mode: "gpu",
          gpuVendor: "apple",
          torchIndex: "", // macOS ARM64 用默认 PyPI（内置 MPS 支持）
          description: "Apple Silicon (MPS)",
        },
      };
    }
    return { compatible: false, reason: "Apple Silicon GPU 仅在 macOS ARM64 上支持" };
  }

  if (gpuVendor === "amd") {
    if (os === "linux") {
      return {
        compatible: true,
        option: {
          mode: "gpu",
          gpuVendor: "amd",
          torchIndex: TORCH_ROCM_INDEX,
          description: "AMD GPU (ROCm 6.2)",
        },
      };
    }
    return { compatible: false, reason: `AMD GPU (ROCm) 仅支持 Linux，当前系统：${os}` };
  }

  return { compatible: false, reason: "未检测到兼容的 GPU，请选择 CPU 模式" };
}

// ---------------------------------------------------------------------------
// Python 检测
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 主安装流程
// ---------------------------------------------------------------------------
export async function installVisionFeature(
  stateStore: VisionStateStore,
  configRoot: string,
  options: {
    yes: boolean;
    prompt: (message: string) => Promise<string>;
    computeMode?: ComputeMode;
  },
): Promise<InstallResult> {
  if (await stateStore.isReady()) {
    const existing = await stateStore.read();
    return {
      success: true,
      message: "视觉模型环境已安装",
      pythonVersion: existing?.python_version ?? "",
      computeMode: "cpu",
    };
  }

  // 1. 检测 Python
  const pythonInfo = await checkPythonAvailable();
  if (!pythonInfo) {
    throw new VcliError(
      "MODEL_RUNTIME_MISSING",
      `未找到 Python ${PYTHON_MIN_VERSION}+ 环境。请安装 Python 后重试。下载地址：https://www.python.org/downloads/`,
      6,
    );
  }

  // 2. 检测平台和 GPU
  const platform = await detectPlatform();
  stdout.write(`检测到系统：${platform.os} ${platform.arch}，GPU：${platform.gpuVendor}\n`);

  // 3. 确定 CPU/GPU 模式
  let computeMode: ComputeMode;
  if (options.computeMode) {
    computeMode = options.computeMode;
  } else if (options.yes) {
    computeMode = "cpu";
  } else {
    computeMode = await promptComputeMode(options.prompt, platform);
  }

  // 4. 验证兼容性
  const compatibility = checkComputeCompatibility(computeMode, platform);
  if (!compatibility.compatible || !compatibility.option) {
    throw new VcliError(
      "MODEL_INITIALIZATION_FAILED",
      `硬件不兼容：${compatibility.reason ?? "未知原因"}`,
      6,
    );
  }
  const computeOption = compatibility.option;
  stdout.write(`计算模式：${computeOption.description}\n`);

  // 5. 确认安装
  if (!options.yes) {
    const promptText = [
      "即将初始化 code-vcli 视觉模型环境。",
      "",
      `模型：${PPOCR_MODEL_DISPLAY} + ${OMNIPARSER_MODEL_DISPLAY}`,
      "方式：本地离线推理，图片不会上传",
      `下载大小：${VISION_DOWNLOAD_SIZE_ESTIMATE}`,
      `工作区：${configRoot}`,
      `Python：${pythonInfo.version}`,
      `计算模式：${computeOption.description}`,
      "",
      "是否开始安装？ [y/n] ",
    ].join("\n");
    let answer: boolean | null = null;
    let currentPrompt = promptText;
    while (answer === null) {
      answer = parseYesNo(await options.prompt(currentPrompt));
      currentPrompt = "是否开始安装？ [y/n] ";
    }
    if (answer !== true) {
      throw new VcliError("MODEL_INSTALL_DECLINED", "用户取消安装", 6);
    }
  }

  await stateStore.writeStatus("installing", pythonInfo.version);

  const packageInfo = await getPackageInfo();
  const resourcesDir = path.join(packageInfo.root, "resources", "ocr");

  // venv 和模型直接建在工作区，失败也不清理
  const venvDir = path.join(configRoot, VISION_VENV_DIR_NAME);
  const stagingDir = path.join(configRoot, `${VISION_STAGING_DIR_NAME}-${randomUUID()}`);

  try {
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });

    // 6. 创建 venv（已存在则复用）
    await createVenvIfMissing(pythonInfo.path, venvDir);
    const venvPython = getVenvPython(configRoot);

    // 7. 先安装 torch/torchvision（锁定版本），避免 requirements 中的包解析出错误版本
    stdout.write(`安装 PyTorch（${computeOption.description}）…\n`);
    await installTorch(venvPython, computeOption);

    // 8. 安装 Python 依赖（ultralytics/rapidocr 等）
    const requirementsSrc = path.join(resourcesDir, VISION_REQUIREMENTS_FILE_NAME);
    const requirementsDst = path.join(stagingDir, VISION_REQUIREMENTS_FILE_NAME);
    await cp(requirementsSrc, requirementsDst, { force: true });
    await installRequirements(venvPython, requirementsDst);

    // 9. 验证核心依赖可导入且版本正确
    stdout.write("验证 Python 环境…\n");
    await verifyImports(venvPython);

    // 10. 复制推理脚本
    const scriptSrc = path.join(resourcesDir, VISION_SCRIPT_FILE_NAME);
    const scriptDst = path.join(stagingDir, VISION_SCRIPT_FILE_NAME);
    await cp(scriptSrc, scriptDst, { force: true });

    // 11. 下载模型
    await stateStore.writeStatus("downloading", pythonInfo.version);
    stdout.write("正在下载模型，请耐心等待…\n");
    await runModelInit(venvPython, scriptDst, configRoot);

    // 12. 自检
    await stateStore.writeStatus("verifying", pythonInfo.version);
    stdout.write("正在验证模型…\n");
    const verified = await runModelSelfTest(venvPython, scriptDst, configRoot);
    if (!verified) {
      throw new VcliError("MODEL_INITIALIZATION_FAILED", "模型自检失败，可能未正确安装", 6);
    }

    // 13. 原子切换：脚本和 requirements 移到正式位置
    const productionScript = path.join(configRoot, VISION_SCRIPT_FILE_NAME);
    const productionRequirements = path.join(configRoot, VISION_REQUIREMENTS_FILE_NAME);
    await rm(productionScript, { force: true });
    await rm(productionRequirements, { force: true });
    await rename(scriptDst, productionScript);
    await rename(requirementsDst, productionRequirements);
    await rm(stagingDir, { recursive: true, force: true });

    // 14. 创建用户 files 目录
    const filesDir = path.join(configRoot, VISION_FILES_DIR_NAME);
    await mkdir(filesDir, { recursive: true, mode: 0o700 });

    await stateStore.writeReady(pythonInfo.version);

    return {
      success: true,
      message: "视觉模型环境已安装",
      pythonVersion: pythonInfo.version,
      computeMode,
    };
  } catch (error) {
    // 只清理临时 staging，保留 venv 和 models
    await rm(stagingDir, { recursive: true, force: true });
    await stateStore.writeStatus("broken", pythonInfo.version);
    if (error instanceof VcliError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new VcliError("MODEL_INSTALL_FAILED", `安装失败：${detail}`, 6, { cause: error });
  }
}

export async function removeVisionFeature(stateStore: VisionStateStore, configRoot: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(path.join(configRoot, VISION_VENV_DIR_NAME), { recursive: true, force: true });
  await rm(path.join(configRoot, VISION_SCRIPT_FILE_NAME), { force: true });
  await rm(path.join(configRoot, VISION_REQUIREMENTS_FILE_NAME), { force: true });
  await rm(path.join(configRoot, "models"), { recursive: true, force: true });
  await rm(path.join(configRoot, VISION_FILES_DIR_NAME), { recursive: true, force: true });
  await stateStore.clear();
}

// ---------------------------------------------------------------------------
// CPU/GPU 模式选择
// ---------------------------------------------------------------------------
async function promptComputeMode(
  prompt: (message: string) => Promise<string>,
  platform: PlatformInfo,
): Promise<ComputeMode> {
  const gpuDesc = platform.gpuVendor === "none"
    ? "未检测到 GPU"
    : `检测到 ${platform.gpuVendor} GPU`;

  const message = [
    "选择计算模式：",
    "",
    `  1. CPU — 纯 CPU 推理，全平台兼容，速度较慢`,
    `  2. GPU — GPU 加速推理，需要兼容的 NVIDIA/AMD/Apple Silicon GPU`,
    "",
    `硬件检测结果：${gpuDesc}`,
    "",
    "请输入 1 或 2：",
  ].join("\n");

  while (true) {
    const input = (await prompt(message)).trim();
    if (input === "1") return "cpu";
    if (input === "2") return "gpu";
    stderr.write("请输入 1（CPU）或 2（GPU）。\n");
  }
}

// ---------------------------------------------------------------------------
// venv 创建
// ---------------------------------------------------------------------------
async function createVenvIfMissing(pythonPath: string, venvDir: string): Promise<void> {
  try {
    const s = await stat(path.join(venvDir, process.platform === "win32" ? "Scripts" : "bin"));
    if (s.isDirectory()) {
      stdout.write("venv 已存在，复用。\n");
      return;
    }
  } catch {
    // 不存在则继续创建
  }
  stdout.write("创建 Python 虚拟环境…\n");
  try {
    await execFileAsync(pythonPath, ["-m", "venv", "--upgrade-deps", venvDir], {
      windowsHide: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new VcliError("MODEL_INSTALL_FAILED", `创建虚拟环境失败：${detail}`, 6, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// 依赖安装
// ---------------------------------------------------------------------------
async function installRequirements(venvPython: string, requirementsPath: string): Promise<void> {
  stdout.write("安装 Python 依赖…\n");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        venvPython,
        ["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "--no-input", "-r", requirementsPath],
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
    throw new VcliError("MODEL_INSTALL_FAILED", `安装 Python 依赖失败：${detail}`, 6, { cause: error });
  }
}

async function installTorch(venvPython: string, option: ComputeOption): Promise<void> {
  const pipArgs = ["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "--no-input"];
  if (option.torchIndex) {
    pipArgs.push("--index-url", option.torchIndex);
  }
  pipArgs.push(`torch==${TORCH_VERSION}`, `torchvision==${TORCHVISION_VERSION}`);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(venvPython, pipArgs, {
        windowsHide: true,
        stdio: ["ignore", "inherit", "inherit"],
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error("安装 PyTorch 超时"));
      }, 900_000);
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
    throw new VcliError("MODEL_INSTALL_FAILED", `安装 PyTorch 失败：${detail}`, 6, { cause: error });
  }
}

async function verifyImports(venvPython: string): Promise<void> {
  const checkScript = [
    "import torch, torchvision, ultralytics, rapidocr",
    "print(f'torch={torch.__version__}, torchvision={torchvision.__version__}, cuda={torch.cuda.is_available()}, mps={getattr(torch.backends,\"mps\",None) and torch.backends.mps.is_available() if hasattr(torch.backends,\"mps\") else False}')",
  ].join("; ");
  try {
    const { stdout: out, stderr: err } = await execFileAsync(
      venvPython,
      ["-c", checkScript],
      { windowsHide: true, timeout: 30_000 },
    );
    stdout.write(`环境验证：${(out || err).trim()}\n`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new VcliError("MODEL_INSTALL_FAILED", `Python 环境验证失败：${detail}`, 6, { cause: error });
  }
}
