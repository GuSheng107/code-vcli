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
// VLM 常量（Qwen2.5-VL 视觉语言模型）
// ---------------------------------------------------------------------------
export const VLM_REPO = "Qwen/Qwen2.5-VL-7B-Instruct";
export const VLM_AWQ_REPO = "Qwen/Qwen2.5-VL-7B-Instruct-AWQ";
export const VLM_MODEL_DISPLAY = "Qwen2.5-VL 7B (transformers)";
export const VLM_MODEL_ID = "qwen2.5-vl-7b";

// VLM 量化版本表：显存阈值（GB）决定推荐量化方式
export interface VlmQuantOption {
  id: string;
  display: string;
  repo: string;
  minVramGb: number;
  description: string;
}

export const VLM_QUANT_OPTIONS: VlmQuantOption[] = [
  {
    id: "bf16",
    display: "BF16（原生，质量无损）",
    repo: VLM_REPO,
    minVramGb: 16,
    description: "原生半精度，质量无损，需 16GB+ 显存",
  },
  {
    id: "awq",
    display: "AWQ INT4（量化，省显存）",
    repo: VLM_AWQ_REPO,
    minVramGb: 8,
    description: "INT4-AWQ 量化，质量略降，8-15GB 显存推荐",
  },
];

export function recommendVlmQuant(vramGb: number): VlmQuantOption | null {
  if (vramGb >= 16) return VLM_QUANT_OPTIONS[0]!;
  if (vramGb >= 8) return VLM_QUANT_OPTIONS[1]!;
  return null;
}

export const VLM_DOWNLOAD_SIZE_ESTIMATE = "约 8-16 GB（Qwen2.5-VL 模型权重）";
export const VLM_REQUEST_TIMEOUT = 120_000;

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
export const TORCH_ROCM_INDEX = "https://download.pytorch.org/whl/rocm6.2";

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
