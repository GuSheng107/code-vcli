import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { stdout, stderr } from "node:process";

import {
  PYTHON_MIN_VERSION,
  VISION_REQUIREMENTS_FILE_NAME,
  VISION_VLM_REQUIREMENTS_FILE_NAME,
  VISION_SCRIPT_FILE_NAME,
  VISION_STAGING_DIR_NAME,
  VISION_VENV_DIR_NAME,
  VISION_FILES_DIR_NAME,
  VISION_MODELS_DIR_NAME,
  OMNIPARSER_MODEL_DIR_NAME,
  PPOCR_MODEL_DIR_NAME,
  VLM_MODEL_DIR_NAME,
  OMNIPARSER_MODEL_DISPLAY,
  PPOCR_MODEL_DISPLAY,
  VLM_MODEL_DISPLAY,
  VLM_DOWNLOAD_SIZE_ESTIMATE,
  VISION_DOWNLOAD_SIZE_ESTIMATE,
  recommendVlmQuant,
  TORCH_CPU_INDEX,
  TORCH_CUDA_INDEX,
  TORCH_ROCM_INDEX,
  TORCH_VERSION,
  TORCHVISION_VERSION,
  type ComputeMode,
  type GpuVendor,
  type PlatformInfo,
  type ComputeOption,
  type ComputeCapability,
  type OcrBackend,
  type VlmQuantOption,
} from "./constants.js";
import { VcliError } from "../errors.js";
import { getVenvPython, runModelSelfTest, runModelInit } from "./python-bridge.js";
import type { VisionStateStore } from "./feature-state.js";
import type { VisionFeatureState } from "./types.js";
import { getPackageInfo } from "../package-info.js";
import { parseYesNo } from "../input.js";

const execFileAsync = promisify(execFile);

export interface InstallResult {
  success: boolean;
  message: string;
  pythonVersion: string;
  computeMode: ComputeMode;
  capabilities: ComputeCapability;
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

/**
 * 检测 NVIDIA GPU 显存总量（GB）。失败返回 null。
 */
export async function detectGpuVramGb(): Promise<number | null> {
  try {
    const { stdout: out } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
    );
    const mb = Number.parseFloat(out.trim().split(/\r?\n/)[0] ?? "");
    if (Number.isFinite(mb) && mb > 0) return mb / 1024;
    return null;
  } catch {
    return null;
  }
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
    capabilities?: ComputeCapability;
    ocrBackend?: OcrBackend;
  },
): Promise<InstallResult> {
  const existing = await stateStore.read();
  const existingReady = existing?.status === "ready" && existing.verified;

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

  // 3. 选择计算模式（CPU/GPU）
  let computeMode: ComputeMode;
  if (options.computeMode) {
    computeMode = options.computeMode;
  } else if (options.yes) {
    computeMode = existingReady ? existing.computeMode : "cpu";
  } else {
    computeMode = await promptComputeMode(options.prompt, platform);
  }

  // 4. 验证兼容性（CPU 模式固定兼容；GPU 需检测硬件）
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

  // 5. 确定能力组合（capabilities）
  let capabilities: ComputeCapability;
  if (computeMode === "cpu") {
    // CPU 模式固定仅 OCR
    capabilities = "ocr";
  } else if (options.capabilities) {
    capabilities = options.capabilities;
  } else if (options.yes) {
    capabilities = existingReady ? existing.capabilities : "vlm";
  } else {
    capabilities = await promptCapabilities(options.prompt);
  }

  // 6. GPU 且能力含 OCR 时，选择 OCR 放置（CPU/GPU）
  let ocrBackend: OcrBackend | undefined;
  if (computeMode === "gpu" && capabilities !== "vlm") {
    if (options.ocrBackend) {
      ocrBackend = options.ocrBackend;
    } else if (options.yes) {
      ocrBackend = existingReady ? existing.ocrBackend : "cpu";
    } else {
      ocrBackend = await promptOcrBackend(options.prompt);
    }
  }

  // 7. GPU 且能力含 VLM 时，检测显存 → 推荐量化 → 强制确认（--yes 也不跳过）
  let vlmQuantization: string | undefined;
  if (computeMode === "gpu" && capabilities !== "ocr") {
    // 能力未变化且已有量化时复用，避免重复确认
    if (existingReady && existing.capabilities === capabilities && existing.vlmQuantization) {
      vlmQuantization = existing.vlmQuantization;
    } else {
      const quant = await selectVlmQuantization(options.prompt);
      vlmQuantization = quant.id;
    }
  }

  // 8. 目标与当前能力完全一致 → 仅同步脚本，不做变更
  if (
    existingReady
    && existing.computeMode === computeMode
    && existing.capabilities === capabilities
    && existing.ocrBackend === ocrBackend
    && existing.vlmQuantization === vlmQuantization
  ) {
    await syncRuntimeScripts(configRoot);
    return {
      success: true,
      message: "已具备该能力组合，无需变更",
      pythonVersion: existing.python_version,
      computeMode,
      capabilities,
    };
  }

  // 9. 确认安装
  const wantsOcr = capabilities !== "vlm";
  const wantsVlm = capabilities !== "ocr";
  const modelDescParts: string[] = [];
  if (wantsOcr) modelDescParts.push(`${PPOCR_MODEL_DISPLAY} + ${OMNIPARSER_MODEL_DISPLAY}`);
  if (wantsVlm) modelDescParts.push(`${VLM_MODEL_DISPLAY}（${vlmQuantization ?? "bf16"}）`);
  const downloadSize = wantsVlm
    ? `${VISION_DOWNLOAD_SIZE_ESTIMATE} + ${VLM_DOWNLOAD_SIZE_ESTIMATE}`
    : VISION_DOWNLOAD_SIZE_ESTIMATE;

  if (!options.yes) {
    const promptText = [
      "code-vcli 视觉模型环境配置如下：",
      "",
      `模型：${modelDescParts.join(" + ")}`,
      "方式：本地离线推理，图片不会上传",
      `下载大小：${downloadSize}`,
      `工作区：${configRoot}`,
      `Python：${pythonInfo.version}`,
      `计算模式：${computeOption.description}`,
      wantsOcr ? `OCR 放置：${ocrBackend ?? "cpu"}` : null,
      wantsVlm ? `VLM 量化：${vlmQuantization ?? "bf16"}` : null,
      "",
      "是否开始安装？ [y/n] ",
    ].filter((line): line is string => line !== null).join("\n");
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

  // 10. 卸载已装但目标不再需要的能力（增量差异处理）
  if (existingReady) {
    await removeExcessCapabilities(configRoot, existing, capabilities);
  }

  const packageInfo = await getPackageInfo();
  const resourcesDir = path.join(packageInfo.root, "resources", "ocr");

  // venv 和模型直接建在工作区，失败也不清理
  const venvDir = path.join(configRoot, VISION_VENV_DIR_NAME);
  const stagingDir = path.join(configRoot, `${VISION_STAGING_DIR_NAME}-${randomUUID()}`);

  try {
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });

    // 9. 创建 venv（已存在则复用）
    await createVenvIfMissing(pythonInfo.path, venvDir);
    const venvPython = getVenvPython(configRoot);

    // 10. 先安装 torch/torchvision（锁定版本），避免 requirements 中的包解析出错误版本
    stdout.write(`安装 PyTorch（${computeOption.description}）…\n`);
    await installTorch(venvPython, computeOption);

    // 11. 按能力安装 Python 依赖
    const requirementsDsts: string[] = [];
    if (wantsOcr) {
      const reqSrc = path.join(resourcesDir, VISION_REQUIREMENTS_FILE_NAME);
      const reqDst = path.join(stagingDir, VISION_REQUIREMENTS_FILE_NAME);
      await cp(reqSrc, reqDst, { force: true });
      requirementsDsts.push(reqDst);
    }
    if (wantsVlm) {
      const reqSrc = path.join(resourcesDir, VISION_VLM_REQUIREMENTS_FILE_NAME);
      const reqDst = path.join(stagingDir, VISION_VLM_REQUIREMENTS_FILE_NAME);
      await cp(reqSrc, reqDst, { force: true });
      requirementsDsts.push(reqDst);
    }
    for (const reqDst of requirementsDsts) {
      await installRequirements(venvPython, reqDst);
    }

    // 12. 验证核心依赖可导入且版本正确
    stdout.write("验证 Python 环境…\n");
    await verifyImports(venvPython, wantsOcr, wantsVlm);

    // 13. 复制推理脚本
    const scriptSrc = path.join(resourcesDir, VISION_SCRIPT_FILE_NAME);
    const scriptDst = path.join(stagingDir, VISION_SCRIPT_FILE_NAME);
    await cp(scriptSrc, scriptDst, { force: true });

    // 14. 下载模型（按能力范围）
    await stateStore.writeStatus("downloading", pythonInfo.version);
    stdout.write("正在下载模型，请耐心等待…\n");
    await runModelInit(venvPython, scriptDst, configRoot, capabilities, vlmQuantization);

    // 15. 自检
    await stateStore.writeStatus("verifying", pythonInfo.version);
    stdout.write("正在验证模型…\n");
    const verified = await runModelSelfTest(venvPython, scriptDst, configRoot, capabilities);
    if (!verified) {
      throw new VcliError("MODEL_INITIALIZATION_FAILED", "模型自检失败，可能未正确安装", 6);
    }

    // 16. 原子切换：脚本和 requirements 移到正式位置
    const productionScript = path.join(configRoot, VISION_SCRIPT_FILE_NAME);
    await rm(productionScript, { force: true });
    await rename(scriptDst, productionScript);
    for (const reqDst of requirementsDsts) {
      const name = path.basename(reqDst);
      const productionReq = path.join(configRoot, name);
      await rm(productionReq, { force: true });
      await rename(reqDst, productionReq);
    }
    await rm(stagingDir, { recursive: true, force: true });

    // 17. 创建用户 files 目录
    const filesDir = path.join(configRoot, VISION_FILES_DIR_NAME);
    await mkdir(filesDir, { recursive: true, mode: 0o700 });

    await stateStore.writeReady(pythonInfo.version, {
      computeMode,
      capabilities,
      ...(ocrBackend ? { ocrBackend } : {}),
      ...(vlmQuantization ? { vlmQuantization } : {}),
    });

    return {
      success: true,
      message: "视觉模型环境已安装",
      pythonVersion: pythonInfo.version,
      computeMode,
      capabilities,
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

/**
 * 增量差异：卸载当前已安装但目标能力不再需要的模型目录。
 * 仅删除目标不需要的模型，保留可复用的 venv / torch 与共同模型。
 */
async function removeExcessCapabilities(
  configRoot: string,
  existing: VisionFeatureState,
  targetCapabilities: ComputeCapability,
): Promise<void> {
  const modelsRoot = path.join(configRoot, VISION_MODELS_DIR_NAME);
  const existingWantsOcr = existing.capabilities !== "vlm";
  const existingWantsVlm = existing.capabilities !== "ocr";
  const targetWantsOcr = targetCapabilities !== "vlm";
  const targetWantsVlm = targetCapabilities !== "ocr";

  const removals: string[] = [];
  if (existingWantsOcr && !targetWantsOcr) {
    removals.push(
      path.join(modelsRoot, OMNIPARSER_MODEL_DIR_NAME),
      path.join(modelsRoot, PPOCR_MODEL_DIR_NAME),
    );
  }
  if (existingWantsVlm && !targetWantsVlm) {
    removals.push(path.join(modelsRoot, VLM_MODEL_DIR_NAME));
  }

  for (const dir of removals) {
    await rm(dir, { recursive: true, force: true });
    stdout.write(`已卸载模型：${path.basename(dir)}\n`);
  }
}

export async function removeVisionFeature(stateStore: VisionStateStore, configRoot: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(path.join(configRoot, VISION_VENV_DIR_NAME), { recursive: true, force: true });
  await rm(path.join(configRoot, VISION_SCRIPT_FILE_NAME), { force: true });
  await rm(path.join(configRoot, VISION_REQUIREMENTS_FILE_NAME), { force: true });
  await rm(path.join(configRoot, VISION_VLM_REQUIREMENTS_FILE_NAME), { force: true });
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
    `  1. CPU — 仅 OCR（纯 CPU 推理，全平台兼容，速度较慢）`,
    `  2. GPU — 可装 OCR 和/或 VLM，按需选择`,
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
// GPU 能力组合选择
// ---------------------------------------------------------------------------
async function promptCapabilities(
  prompt: (message: string) => Promise<string>,
): Promise<ComputeCapability> {
  const message = [
    "选择要安装的能力组合：",
    "",
    `  1. 仅 OCR — ${PPOCR_MODEL_DISPLAY} + ${OMNIPARSER_MODEL_DISPLAY}`,
    `  2. 仅 VLM — ${VLM_MODEL_DISPLAY}（视觉理解与意图识别）`,
    `  3. 都要 — OCR + VLM（--mix 模式需要两者）`,
    "",
    "请输入 1、2 或 3：",
  ].join("\n");

  while (true) {
    const input = (await prompt(message)).trim();
    if (input === "1") return "ocr";
    if (input === "2") return "vlm";
    if (input === "3") return "both";
    stderr.write("请输入 1、2 或 3。\n");
  }
}

// ---------------------------------------------------------------------------
// OCR 放置选择（GPU + 含 OCR 时）
// ---------------------------------------------------------------------------
async function promptOcrBackend(
  prompt: (message: string) => Promise<string>,
): Promise<OcrBackend> {
  const message = [
    "选择 OCR 运行位置：",
    "",
    `  1. CPU — 推荐，省显存给 VLM`,
    `  2. GPU — OCR 也用 GPU 加速`,
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
// VLM 量化选择（显存检测 + 推荐 + 强制确认，--yes 也不跳过）
// ---------------------------------------------------------------------------
async function selectVlmQuantization(
  prompt: (message: string) => Promise<string>,
): Promise<VlmQuantOption> {
  const vramGb = await detectGpuVramGb();
  if (vramGb === null) {
    throw new VcliError(
      "MODEL_INITIALIZATION_FAILED",
      `检测显卡显存失败。${VLM_MODEL_DISPLAY} 需要 8GB+ 显存，请确认 GPU 正常或改用 CPU/OCR 模式。`,
      6,
    );
  }
  stdout.write(`检测到显存：约 ${vramGb.toFixed(0)} GB\n`);

  const recommended = recommendVlmQuant(vramGb);
  if (!recommended) {
    throw new VcliError(
      "MODEL_INITIALIZATION_FAILED",
      `显存约 ${vramGb.toFixed(0)} GB，低于 Qwen2.5-VL 8GB 的最低要求。请改用 CPU/OCR 模式或升级显卡。`,
      6,
    );
  }

  // 强制确认：即便 --yes 也不跳过
  const message = [
    `推荐 VLM 量化方式：${recommended.display}`,
    "",
    `  说明：${recommended.description}`,
    "",
    "确认使用该量化方式？ [y/n] ",
  ].join("\n");
  let answer: boolean | null = null;
  let currentPrompt = message;
  while (answer === null) {
    answer = parseYesNo(await prompt(currentPrompt));
    currentPrompt = "确认使用该量化方式？ [y/n] ";
  }
  if (answer !== true) {
    throw new VcliError("MODEL_INSTALL_DECLINED", "用户未确认 VLM 量化方式", 6);
  }
  return recommended;
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

async function verifyImports(venvPython: string, wantsOcr: boolean, wantsVlm: boolean): Promise<void> {
  const imports: string[] = [];
  imports.push("import torch, torchvision");
  if (wantsOcr) imports.push("import ultralytics, rapidocr");
  if (wantsVlm) imports.push("import transformers, qwen_vl_utils");
  const checkScript = [
    ...imports,
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

// ---------------------------------------------------------------------------
// 运行时脚本同步
// ---------------------------------------------------------------------------
async function fileSha256(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 已安装环境下，把包内的推理脚本和 requirements 同步到工作区。
 * 通过 sha256 比较，仅在不一致时覆盖，避免无谓写入。
 */
async function syncRuntimeScripts(configRoot: string): Promise<void> {
  const packageInfo = await getPackageInfo();
  const resourcesDir = path.join(packageInfo.root, "resources", "ocr");
  for (const fileName of [
    VISION_SCRIPT_FILE_NAME,
    VISION_REQUIREMENTS_FILE_NAME,
    VISION_VLM_REQUIREMENTS_FILE_NAME,
  ]) {
    const src = path.join(resourcesDir, fileName);
    const dst = path.join(configRoot, fileName);
    try {
      const [srcHash, dstHash] = await Promise.all([fileSha256(src), fileSha256(dst)]);
      if (srcHash === dstHash) continue;
      await cp(src, dst, { force: true });
      stdout.write(`已同步 ${fileName} 到工作区\n`);
    } catch {
      // 目标不存在或读取失败：跳过，首次安装流程会处理
    }
  }
}
