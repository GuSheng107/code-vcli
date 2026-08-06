import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import nodeOs from "node:os";
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
  VISION_DOWNLOAD_SIZE_ESTIMATE,
  getVlmModelOption,
  getVlmOptionForLegacyQuant,
  VLM_MODEL_OPTIONS,
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
  type VlmModelOption,
  type VlmModelOptionId,
  type VlmQuantization,
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

  const gpu = await detectGpuInfo(os, arch);

  return { os, arch, ...gpu };
}

/**
 * 检测 GPU 的具体型号与显存（GB）。无法读取型号/显存时只返回厂商。
 */
async function detectGpuInfo(os: string, arch: string): Promise<{
  gpuVendor: GpuVendor;
  gpuName?: string;
  gpuVramGb?: number;
}> {
  if (os === "macos" && arch === "arm64") {
    return detectAppleGpu();
  }

  const nvidia = await detectNvidiaGpu();
  if (nvidia) return nvidia;

  const amd = await detectAmdGpu(os);
  if (amd) return amd;

  return { gpuVendor: "none" };
}

/** 通过 nvidia-smi 检测 NVIDIA GPU 型号与显存（MB → GB）。 */
async function detectNvidiaGpu(): Promise<{
  gpuVendor: "nvidia";
  gpuName?: string;
  gpuVramGb?: number;
} | null> {
  try {
    const { stdout: out } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
    );
    const firstLine = out.trim().split(/\r?\n/)[0] ?? "";
    const [name, memoryMb] = firstLine.split(",").map((part) => part.trim());
    const mb = Number.parseFloat(memoryMb ?? "");
    return {
      gpuVendor: "nvidia",
      ...(name ? { gpuName: name } : {}),
      ...(Number.isFinite(mb) && mb > 0 ? { gpuVramGb: mb / 1024 } : {}),
    };
  } catch {
    return null;
  }
}

/** macOS ARM64：通过 system_profiler 读取 Apple GPU 型号与显存。 */
async function detectAppleGpu(): Promise<{
  gpuVendor: "apple";
  gpuName?: string;
  gpuVramGb?: number;
}> {
  try {
    const { stdout: out } = await execFileAsync(
      "system_profiler",
      ["SPDisplaysDataType", "-json"],
      { timeout: 5000 },
    );
    const parsed: unknown = JSON.parse(out);
    const displays = (parsed as { SPDisplaysDataType?: unknown[] })?.SPDisplaysDataType;
    const gpu = Array.isArray(displays) ? displays[0] as Record<string, unknown> | undefined : undefined;
    const name = typeof gpu?.sppci_model === "string" ? gpu.sppci_model
      : typeof gpu?._name === "string" ? gpu._name
      : undefined;
    const vramMatch = typeof gpu?.spdisplays_vram === "string"
      ? gpu.spdisplays_vram.match(/(\d+(?:\.\d+)?)\s*GB/i)
      : null;
    const parsedVramGb = vramMatch ? Number.parseFloat(vramMatch[1] ?? "") : Number.NaN;
    const unifiedMemoryGb = nodeOs.totalmem() / 1024 / 1024 / 1024;
    const vramGb = Number.isFinite(parsedVramGb) && parsedVramGb > 0
      ? parsedVramGb
      : unifiedMemoryGb;
    return {
      gpuVendor: "apple",
      ...(name ? { gpuName: name } : {}),
      ...(vramGb > 0 ? { gpuVramGb: vramGb } : {}),
    };
  } catch {
    const unifiedMemoryGb = nodeOs.totalmem() / 1024 / 1024 / 1024;
    return { gpuVendor: "apple", ...(unifiedMemoryGb > 0 ? { gpuVramGb: unifiedMemoryGb } : {}) };
  }
}

/** AMD GPU：Windows 用 CIM，Linux 用 lspci + rocm-smi，尽力读取型号与显存。 */
async function detectAmdGpu(os: string): Promise<{
  gpuVendor: "amd";
  gpuName?: string;
  gpuVramGb?: number;
} | null> {
  if (os === "windows") {
    try {
      const script = [
        "$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'AMD|Radeon' } | Select-Object -First 1",
        "if ($gpu) {",
        "  $vram = if ($gpu.AdapterRAM -gt 0) { [math]::Round($gpu.AdapterRAM / 1GB, 1) } else { '' }",
        "  Write-Output (($gpu.Name) + '|' + $vram)",
        "}",
      ].join("; ");
      const { stdout: out } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 5000, windowsHide: true },
      );
      const [name, vramText] = (out.trim().split(/\r?\n/)[0] ?? "").split("|");
      const vramGb = Number.parseFloat(vramText ?? "");
      if (name || (Number.isFinite(vramGb) && vramGb > 0)) {
        return {
          gpuVendor: "amd",
          ...(name ? { gpuName: name } : {}),
          ...(Number.isFinite(vramGb) && vramGb > 0 ? { gpuVramGb: vramGb } : {}),
        };
      }
    } catch {
      // PowerShell 不可用则跳过
    }
    return null;
  }

  if (os === "linux") {
    let name: string | undefined;
    try {
      const { stdout: lspciOut } = await execFileAsync("lspci", [], { timeout: 5000 });
      const line = lspciOut.split(/\r?\n/).find((entry) =>
        /VGA compatible controller/i.test(entry) && /AMD|Radeon/i.test(entry));
      name = line?.replace(/^.*controller:\s*/i, "").trim() || undefined;
    } catch {
      // lspci 不可用则跳过
    }
    let vramGb: number | undefined;
    try {
      const { stdout: rocmOut } = await execFileAsync(
        "rocm-smi",
        ["--showmeminfo", "vram"],
        { timeout: 5000 },
      );
      const match = rocmOut.match(/(\d+(?:\.\d+)?)\s*(M|G)B/i);
      if (match) {
        const value = Number.parseFloat(match[1] ?? "");
        vramGb = match[2]?.toUpperCase() === "M" ? value / 1024 : value;
      }
    } catch {
      // rocm-smi 不可用则跳过
    }
    if (name || vramGb !== undefined) {
      return {
        gpuVendor: "amd",
        ...(name ? { gpuName: name } : {}),
        ...(vramGb !== undefined && Number.isFinite(vramGb) && vramGb > 0 ? { gpuVramGb: vramGb } : {}),
      };
    }
    return null;
  }

  return null;
}

/** 生成人类可读的 GPU 描述：型号（显存）→ 型号 → 厂商 → 未检测到 GPU。 */
export function describeGpu(platform: PlatformInfo): string {
  if (platform.gpuVendor === "none") return "未检测到 GPU";
  const { gpuName, gpuVramGb } = platform;
  if (gpuName && gpuVramGb !== undefined) {
    return `${gpuName}（${gpuVramGb >= 10 ? gpuVramGb.toFixed(0) : gpuVramGb.toFixed(1)} GB 显存）`;
  }
  if (gpuName) return gpuName;
  if (gpuVramGb !== undefined) return `${platform.gpuVendor} GPU（约 ${gpuVramGb.toFixed(0)} GB 显存）`;
  return `检测到 ${platform.gpuVendor} GPU`;
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
    if ((os === "windows" || os === "linux") && arch === "x64") {
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
    return { compatible: false, reason: `NVIDIA GPU 安装仅支持 Windows/Linux x64，当前：${os} ${arch}` };
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
    if (os === "linux" && arch === "x64") {
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
    return { compatible: false, reason: `AMD GPU (ROCm) 仅支持 Linux x64，当前：${os} ${arch}` };
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
    vlmModelOption?: VlmModelOptionId;
    vlmQuantization?: VlmQuantization;
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
  stdout.write(`检测到系统：${platform.os} ${platform.arch}，GPU：${describeGpu(platform)}\n`);

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

  // 7. GPU 且能力含 VLM 时，从 A1-A2/B1-B2/C1-C2 中选择。
  let vlmOption: VlmModelOption | undefined;
  if (computeMode === "gpu" && capabilities !== "ocr") {
    const requestedOption = options.vlmModelOption
      ? getVlmModelOption(options.vlmModelOption)
      : options.vlmQuantization
        ? getVlmOptionForLegacyQuant(options.vlmQuantization)
        : null;
    const existingOption = existing?.vlmModelOption
      ? getVlmModelOption(existing.vlmModelOption)
      : existing?.vlmQuantization
        ? getVlmOptionForLegacyQuant(existing.vlmQuantization as VlmQuantization)
        : null;

    if (requestedOption) {
      vlmOption = await confirmVlmModelOption(
        requestedOption,
        platform,
        options.prompt,
        options.yes,
      );
    } else if (existingReady && existing.capabilities !== "ocr" && existingOption) {
      vlmOption = existingOption;
    } else {
      vlmOption = await selectVlmModelOption(platform, options.prompt, options.yes);
    }
  }
  const vlmModelOption = vlmOption?.id;
  const vlmQuantization = vlmOption?.quantization;

  // 8. 目标与当前能力完全一致 → 仅同步脚本，不做变更
  if (
    existingReady
    && existing.computeMode === computeMode
    && existing.capabilities === capabilities
    && existing.ocrBackend === ocrBackend
    && (existing.vlmModelOption ?? getVlmOptionForLegacyQuant((existing.vlmQuantization ?? "awq") as VlmQuantization).id) === vlmModelOption
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
  if (wantsVlm && vlmOption) modelDescParts.push(vlmOption.display);
  const downloadSize = wantsVlm && vlmOption
    ? `${VISION_DOWNLOAD_SIZE_ESTIMATE} + ${vlmOption.downloadSize}`
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
      wantsVlm && vlmOption ? `VLM 选项：${vlmOption.display}` : null,
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
    const wantsAwq = wantsVlm && vlmOption?.quantization === "awq";
    if (wantsAwq) {
      await installAwqRuntime(venvPython);
    }

    // 12. 验证核心依赖可导入且版本正确
    stdout.write("验证 Python 环境…\n");
    await verifyImports(venvPython, wantsOcr, wantsVlm, wantsAwq);

    // 13. 复制推理脚本
    const scriptSrc = path.join(resourcesDir, VISION_SCRIPT_FILE_NAME);
    const scriptDst = path.join(stagingDir, VISION_SCRIPT_FILE_NAME);
    await cp(scriptSrc, scriptDst, { force: true });

    // 14. 下载模型（按能力范围）
    await stateStore.writeStatus("downloading", pythonInfo.version);
    stdout.write("正在下载模型，请耐心等待…\n");
    await runModelInit(
      venvPython,
      scriptDst,
      configRoot,
      capabilities,
      vlmModelOption,
      ocrBackend ?? "cpu",
      computeMode === "gpu",
    );

    // 15. 自检
    await stateStore.writeStatus("verifying", pythonInfo.version);
    stdout.write("正在验证模型…\n");
    const verified = await runModelSelfTest(
      venvPython,
      scriptDst,
      configRoot,
      capabilities,
      ocrBackend ?? "cpu",
      computeMode === "gpu",
    );
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
      ...(vlmModelOption ? { vlmModelOption } : {}),
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
  const gpuDesc = describeGpu(platform);

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
async function getDetectedVramGb(platform: PlatformInfo): Promise<number | null> {
  return platform.gpuVramGb ?? (await detectGpuVramGb());
}

function getModelPlatformIssue(option: VlmModelOption, platform: PlatformInfo): string | null {
  if (option.quantization !== "awq") return null;
  if (platform.gpuVendor !== "nvidia" || (platform.os !== "windows" && platform.os !== "linux")) {
    return "AWQ 当前仅支持 Windows/Linux 的 NVIDIA CUDA 环境；Apple MPS 与 AMD ROCm 请选 BF16（A1/B1/C1）";
  }
  return null;
}

function recommendCompatibleVlmOption(
  vramGb: number,
  platform: PlatformInfo,
): VlmModelOption | null {
  const preferredIds = ["C1", "C2", "B1", "B2", "A1", "A2"];
  const usableVramGb = platform.gpuVendor === "apple" ? Math.max(0, vramGb - 4) : vramGb;
  for (const id of preferredIds) {
    const option = getVlmModelOption(id)!;
    if (!getModelPlatformIssue(option, platform) && usableVramGb >= option.minVramGb) return option;
  }
  return null;
}

function getModelRisk(option: VlmModelOption, vramGb: number | null): string | null {
  if (vramGb === null) {
    return `无法读取显存，无法确认是否满足 ${option.minVramGb}GB 的建议要求。`;
  }
  if (vramGb < option.minVramGb) {
    return `当前显存约 ${vramGb.toFixed(1)}GB，低于 ${option.display} 建议的 ${option.minVramGb}GB，可能发生显存不足或推理失败。`;
  }
  return null;
}

async function confirmVlmModelOption(
  option: VlmModelOption,
  platform: PlatformInfo,
  prompt: (message: string) => Promise<string>,
  yes: boolean,
): Promise<VlmModelOption> {
  const platformIssue = getModelPlatformIssue(option, platform);
  if (platformIssue) {
    throw new VcliError("MODEL_INITIALIZATION_FAILED", `${option.display} 不支持当前平台：${platformIssue}`, 6);
  }
  const vramGb = await getDetectedVramGb(platform);
  const risk = getModelRisk(option, vramGb);
  if (!risk) return option;

  stderr.write(`警告：${risk}\n`);
  if (yes) {
    stderr.write("已通过命令行明确指定 VLM 选项，继续安装。\n");
    return option;
  }

  let answer: boolean | null = null;
  let message = `仍然安装 ${option.display}？ [y/n] `;
  while (answer === null) {
    answer = parseYesNo(await prompt(message));
    message = "请输入 y 或 n：";
  }
  if (!answer) {
    throw new VcliError("MODEL_INSTALL_DECLINED", "用户取消安装超出本机建议能力的 VLM 选项", 6);
  }
  return option;
}

function buildVlmSelectionMessage(
  recommended: VlmModelOption | null,
  vramGb: number | null,
  platform: PlatformInfo,
): string {
  const rows = VLM_MODEL_OPTIONS.map((option) => {
    const platformIssue = getModelPlatformIssue(option, platform);
    const risk = platformIssue ?? getModelRisk(option, vramGb);
    const marker = recommended?.id === option.id ? "（推荐）" : "";
    const availability = risk ? `\n     警告：${risk}` : "";
    return `  ${option.id}. ${option.display.replace(`${option.id} — `, "")}${marker}\n     ${option.description}；下载 ${option.downloadSize}${availability}`;
  });
  return [
    "请选择要安装的 Qwen2.5-VL 模型（仅允许以下六项）：",
    "",
    ...rows,
    "",
    "请输入 A1、A2、B1、B2、C1 或 C2：",
  ].join("\n");
}

export async function selectVlmModelOption(
  platform: PlatformInfo,
  prompt: (message: string) => Promise<string>,
  yes: boolean,
): Promise<VlmModelOption> {
  const vramGb = await getDetectedVramGb(platform);
  stdout.write(vramGb === null
    ? "未能读取显存容量，将由用户手动选择 VLM 模型。\n"
    : `检测到显存：约 ${vramGb.toFixed(1)} GB\n`);

  const recommended = vramGb === null ? null : recommendCompatibleVlmOption(vramGb, platform);
  if (yes) {
    if (!recommended) {
      throw new VcliError(
        "MODEL_INITIALIZATION_FAILED",
        "无法安全自动选择 VLM 模型。请去掉 --yes 手动选择，或显式传入 --vlm-option A1..C2。",
        6,
      );
    }
    stdout.write(`自动选择推荐模型：${recommended.display}\n`);
    return recommended;
  }

  if (recommended) {
    const message = [
      `推荐 VLM 模型：${recommended.display}`,
      "",
      `  说明：${recommended.description}`,
      `  下载：${recommended.downloadSize}`,
      "",
      "确认使用推荐模型？ [y/n] ",
    ].join("\n");
    let answer: boolean | null = null;
    let currentPrompt = message;
    while (answer === null) {
      answer = parseYesNo(await prompt(currentPrompt));
      currentPrompt = "确认使用推荐模型？ [y/n] ";
    }
    if (answer) return recommended;
    stdout.write("已拒绝推荐模型，请从全部六个选项中选择。\n");
  } else {
    stderr.write("警告：当前硬件没有满足建议显存的自动推荐项，请手动选择并确认风险。\n");
  }

  while (true) {
    const input = (await prompt(buildVlmSelectionMessage(recommended, vramGb, platform))).trim().toUpperCase();
    const selected = getVlmModelOption(input);
    if (!selected) {
      stderr.write("请输入 A1、A2、B1、B2、C1 或 C2。\n");
      continue;
    }
    const platformIssue = getModelPlatformIssue(selected, platform);
    if (platformIssue) {
      stderr.write(`该模型不支持当前平台：${platformIssue}。请重新选择。\n`);
      continue;
    }
    const risk = getModelRisk(selected, vramGb);
    if (!risk) return selected;

    let answer: boolean | null = null;
    let currentPrompt = `警告：${risk}\n仍然选择 ${selected.display}？ [y/n] `;
    while (answer === null) {
      answer = parseYesNo(await prompt(currentPrompt));
      currentPrompt = "请输入 y 或 n：";
    }
    if (answer) return selected;
    stdout.write("已取消该模型，请重新选择。\n");
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

async function runPip(
  venvPython: string,
  args: string[],
  description: string,
  timeoutMs = 600_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(venvPython, [
      "-m", "pip", "install", "--disable-pip-version-check", "--no-input", ...args,
    ], {
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${description}超时`));
    }, timeoutMs);
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
      code === 0 ? resolve() : reject(new Error(`${description}失败，pip 退出码 ${code ?? "unknown"}`));
    });
  });
}

async function installAwqRuntime(venvPython: string): Promise<void> {
  stdout.write("安装 AWQ INT4 运行时…\n");
  try {
    if (process.platform === "win32") {
      // 官方 triton 在 Windows 无 wheel，使用兼容的 triton-windows 提供同名 Python 模块。
      await runPip(
        venvPython,
        ["--upgrade", "triton-windows==3.3.1.post21", "zstandard>=0.22.0", "datasets>=2.20"],
        "安装 Windows AWQ 基础依赖",
      );
      // autoawq 声明依赖 triton 分发名；Windows 已由 triton-windows 提供模块，因此跳过依赖解析。
      await runPip(
        venvPython,
        ["--upgrade", "--no-deps", "autoawq==0.2.9"],
        "安装 AutoAWQ",
      );
    } else {
      await runPip(venvPython, ["--upgrade", "autoawq==0.2.9"], "安装 AutoAWQ");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new VcliError("MODEL_INSTALL_FAILED", `安装 AWQ 运行时失败：${detail}`, 6, { cause: error });
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

async function verifyImports(
  venvPython: string,
  wantsOcr: boolean,
  wantsVlm: boolean,
  wantsAwq: boolean,
): Promise<void> {
  const imports: string[] = [];
  imports.push("import torch, torchvision");
  if (wantsOcr) imports.push("import ultralytics, rapidocr");
  if (wantsVlm) imports.push("import transformers, qwen_vl_utils");
  if (wantsAwq) imports.push("import awq, triton");
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
