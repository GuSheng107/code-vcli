export const VISION_FEATURE_VERSION = "2";
export const VISION_VENV_DIR_NAME = "venv";
export const VISION_SCRIPT_FILE_NAME = "vcli_inference.py";
export const VISION_REQUIREMENTS_FILE_NAME = "requirements.txt";
export const VISION_VLM_REQUIREMENTS_FILE_NAME = "requirements-vlm.txt";
export const VISION_MODELS_DIR_NAME = "models";
export const OMNIPARSER_MODEL_DIR_NAME = "omniparser";
export const PPOCR_MODEL_DIR_NAME = "ppocr";
export const VLM_MODEL_DIR_NAME = "vlm";
export const VISION_STAGING_DIR_NAME = "staging";
export const VISION_STATE_FILE_NAME = "model_state.json";
export const VISION_FILES_DIR_NAME = "files";

export const PYTHON_MIN_VERSION = "3.10";

export const OMNIPARSER_REPO = "microsoft/OmniParser-v2.0";
export const OMNIPARSER_MODEL_DISPLAY = "OmniParser V2 YOLO";
export const OMNIPARSER_MODEL_ID = "omniparser-v2-yolo";

export const PPOCR_MODEL_DISPLAY = "PP-OCRv6 (RapidOCR + OpenVINO)";
export const PPOCR_MODEL_ID = "ppocrv6";

// OCR 引擎类型（可插拔；当前仅支持 ppocrv6）
export const VISION_OCR_ENGINES = ["ppocrv6"] as const;
export type VisionOcrEngineType = typeof VISION_OCR_ENGINES[number];

// ---------------------------------------------------------------------------
// VLM 常量（仅允许 Qwen2.5-VL 3B/7B/32B 的 BF16 与 AWQ 官方版本）
// ---------------------------------------------------------------------------
export type VlmQuantization = "bf16" | "awq";
export type VlmModelSize = "3b" | "7b" | "32b";
export type VlmModelOptionId = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

export interface VlmModelOption {
  id: VlmModelOptionId;
  size: VlmModelSize;
  quantization: VlmQuantization;
  display: string;
  repo: string;
  minVramGb: number;
  description: string;
  downloadSize: string;
}

export const VLM_MODEL_OPTIONS: readonly VlmModelOption[] = [
  {
    id: "A1",
    size: "3b",
    quantization: "bf16",
    display: "A1 — Qwen2.5-VL 3B BF16",
    repo: "Qwen/Qwen2.5-VL-3B-Instruct",
    minVramGb: 8,
    description: "3B 原生半精度，速度快、质量完整，建议 8GB+ 显存",
    downloadSize: "约 6-8 GB",
  },
  {
    id: "A2",
    size: "3b",
    quantization: "awq",
    display: "A2 — Qwen2.5-VL 3B AWQ INT4",
    repo: "Qwen/Qwen2.5-VL-3B-Instruct-AWQ",
    minVramGb: 4,
    description: "3B AWQ 4-bit，最省显存，适合低显存 GPU",
    downloadSize: "约 2-4 GB",
  },
  {
    id: "B1",
    size: "7b",
    quantization: "bf16",
    display: "B1 — Qwen2.5-VL 7B BF16",
    repo: "Qwen/Qwen2.5-VL-7B-Instruct",
    minVramGb: 16,
    description: "7B 原生半精度，质量完整，建议 16GB+ 显存",
    downloadSize: "约 14-16 GB",
  },
  {
    id: "B2",
    size: "7b",
    quantization: "awq",
    display: "B2 — Qwen2.5-VL 7B AWQ INT4",
    repo: "Qwen/Qwen2.5-VL-7B-Instruct-AWQ",
    minVramGb: 8,
    description: "7B AWQ 4-bit，质量、速度和显存占用均衡，16GB GPU 推荐",
    downloadSize: "约 5-8 GB",
  },
  {
    id: "C1",
    size: "32b",
    quantization: "bf16",
    display: "C1 — Qwen2.5-VL 32B BF16",
    repo: "Qwen/Qwen2.5-VL-32B-Instruct",
    minVramGb: 72,
    description: "32B 原生半精度，质量最高，建议 72GB+ 显存",
    downloadSize: "约 64-70 GB",
  },
  {
    id: "C2",
    size: "32b",
    quantization: "awq",
    display: "C2 — Qwen2.5-VL 32B AWQ INT4",
    repo: "Qwen/Qwen2.5-VL-32B-Instruct-AWQ",
    minVramGb: 24,
    description: "32B AWQ 4-bit，仍需要高显存 GPU，建议 24GB+",
    downloadSize: "约 18-24 GB",
  },
] as const;

export const VLM_MODEL_DISPLAY = "Qwen2.5-VL 3B/7B/32B (transformers)";
export const DEFAULT_VLM_MODEL_OPTION: VlmModelOptionId = "B2";

export function getVlmModelOption(id: string): VlmModelOption | null {
  return VLM_MODEL_OPTIONS.find((option) => option.id === id.toUpperCase()) ?? null;
}

export function getVlmOptionForLegacyQuant(quantization: VlmQuantization): VlmModelOption {
  return getVlmModelOption(quantization === "bf16" ? "B1" : "B2")!;
}

export function recommendVlmModelOption(vramGb: number): VlmModelOption | null {
  const preference: VlmModelOptionId[] = ["C1", "C2", "B1", "B2", "A1", "A2"];
  for (const id of preference) {
    const option = getVlmModelOption(id)!;
    if (vramGb >= option.minVramGb) return option;
  }
  return null;
}

export const VLM_DOWNLOAD_SIZE_ESTIMATE = "约 2-70 GB（取决于 A1-A2/B1-B2/C1-C2）";
export const VLM_REQUEST_TIMEOUT = 300_000;
export const MIX_OCR_CONTEXT_TOKENS_DEFAULT = 16_384;
export const MIX_OCR_CONTEXT_TOKENS_MAX = 32_768;

// ---------------------------------------------------------------------------
// 推理模式与计算能力
// ---------------------------------------------------------------------------
export const VISION_MODES = ["ocr", "vlm", "mix"] as const;
export type VisionMode = typeof VISION_MODES[number];

export const COMPUTE_CAPABILITIES = ["ocr", "vlm", "both"] as const;
export type ComputeCapability = typeof COMPUTE_CAPABILITIES[number];

export const OCR_BACKENDS = ["cpu", "gpu"] as const;
export type OcrBackend = typeof OCR_BACKENDS[number];

export const VISION_DOWNLOAD_SIZE_ESTIMATE = "约 1-2 GB（含 torch + 模型权重）";

export const VISION_SUPPORTED_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
] as const;

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Torch 版本 — 锁定已知稳定版本
// 2.13.0 在 Windows + Python 3.13 上有 c10.dll 加载失败问题，锁定 2.7.1
// ---------------------------------------------------------------------------
export const TORCH_VERSION = "2.7.1";
export const TORCHVISION_VERSION = "0.22.1";

// ---------------------------------------------------------------------------
// Torch 安装源 — 根据 CPU/GPU 模式和平台选择
// ---------------------------------------------------------------------------
export const TORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu";
export const TORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu126";
export const TORCH_ROCM_INDEX = "https://download.pytorch.org/whl/rocm6.3";

export type ComputeMode = "cpu" | "gpu";
export type GpuVendor = "nvidia" | "amd" | "apple" | "none";

export interface PlatformInfo {
  os: "windows" | "macos" | "linux" | "unknown";
  arch: "x64" | "arm64" | "ia32" | "unknown";
  gpuVendor: GpuVendor;
  gpuName?: string;
  gpuVramGb?: number;
}

export interface ComputeOption {
  mode: ComputeMode;
  gpuVendor: GpuVendor;
  torchIndex: string;
  description: string;
}
