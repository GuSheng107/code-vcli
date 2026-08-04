export const VISION_FEATURE_VERSION = "1";
export const VISION_VENV_DIR_NAME = "venv";
export const VISION_SCRIPT_FILE_NAME = "vcli_inference.py";
export const VISION_REQUIREMENTS_FILE_NAME = "requirements.txt";
export const VISION_MODELS_DIR_NAME = "models";
export const VISION_STAGING_DIR_NAME = "staging";
export const VISION_STATE_FILE_NAME = "model_state.json";
export const VISION_FILES_DIR_NAME = "files";

export const PYTHON_MIN_VERSION = "3.10";

export const GLM_OCR_REPO = "zai-org/GLM-OCR";
export const GLM_OCR_MODEL_DISPLAY = "GLM-OCR 0.9B";
export const GLM_OCR_MODEL_ID = "glm-ocr-0.9b";

export const OMNIPARSER_REPO = "microsoft/OmniParser-v2.0";
export const OMNIPARSER_MODEL_DISPLAY = "OmniParser V2";
export const OMNIPARSER_MODEL_ID = "omniparser-v2";

export const FLORENCE_CAPTION_REPO = "microsoft/Florence-2-base-ft";
export const FLORENCE_PROCESSOR_REPO = "microsoft/Florence-2-base";

export const VISION_ENGINES = ["glm", "omni", "auto"] as const;
export type VisionEngineType = typeof VISION_ENGINES[number];

export const VISION_DOWNLOAD_SIZE_ESTIMATE = "约 3-5 GB（含 torch + 模型权重）";

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
// 锁定版本 — 两个引擎共用同一套依赖
// ---------------------------------------------------------------------------
export const TORCH_VERSION = "2.5.1";
export const TORCHVISION_VERSION = "0.20.1";
export const TRANSFORMERS_VERSION = "5.3.0";

// ---------------------------------------------------------------------------
// Torch 安装源 — 根据 CPU/GPU 模式和平台选择
// ---------------------------------------------------------------------------
export const TORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu";
export const TORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu121";
export const TORCH_ROCM_INDEX = "https://download.pytorch.org/whl/rocm6.1";

export type ComputeMode = "cpu" | "gpu";
export type GpuVendor = "nvidia" | "amd" | "apple" | "none";

export interface PlatformInfo {
  os: "windows" | "macos" | "linux" | "unknown";
  arch: "x64" | "arm64" | "ia32" | "unknown";
  gpuVendor: GpuVendor;
}

export interface ComputeOption {
  mode: ComputeMode;
  gpuVendor: GpuVendor;
  torchIndex: string;
  description: string;
}
