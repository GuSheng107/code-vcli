export const OCR_FEATURE_VERSION = "1";
export const OCR_RUNTIME_VERSION = "rapidocr-3.9.2+openvino";
export const OCR_ENGINE = "rapidocr-openvino";
export const OCR_MODEL_ID = "ppocr-v6-small";
export const OCR_MODEL_DISPLAY = "PP-OCRv6 Quality";

export const OCR_FEATURE_DIR_NAME = "features/ocr";
export const OCR_STATE_FILE_NAME = "state.json";
export const OCR_VENV_DIR_NAME = "venv";
export const OCR_SCRIPT_FILE_NAME = "ocr.py";
export const OCR_REQUIREMENTS_FILE_NAME = "requirements-ocr.txt";
export const OCR_STAGING_DIR_NAME = "staging";

export const OCR_SUPPORTED_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
] as const;

export const OCR_PDF_EXTENSION = ".pdf";
export const OCR_PDF_MAX_PAGES = 100;
export const OCR_PDF_RENDER_SCALE = 2;
export const OCR_MAX_SOURCES = 100;
export const OCR_INLINE_PREVIEW_MAX_CHARS = 2_000;
export const OCR_SUPPORTED_DOCUMENT_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".pptx",
  ".md",
  ".markdown",
] as const;

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 40_000_000;

// PDF 渲染依赖（与 package.json 的 optionalDependencies 保持一致）
export const OCR_CANVAS_PACKAGE = "@napi-rs/canvas";
export const OCR_CANVAS_VERSION = "0.1.100";

export const PYTHON_MIN_VERSION = "3.10";

export const OCR_LANGUAGES = "简体中文、繁体中文、英文、日文等 50 种";

export const OCR_DOWNLOAD_SIZE_ESTIMATE = "约 180 MB";
