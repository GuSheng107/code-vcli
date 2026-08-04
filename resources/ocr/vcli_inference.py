#!/usr/bin/env python3
"""vcli 视觉推理脚本 — GLM-OCR / OmniParser V2 / Auto

由 Node.js CLI 通过 spawn() 调用，所有进度信息输出到 stderr，
识别结果以 JSON 形式输出到 stdout。

命令：
  --init                下载全部模型到 ~/.vcli/models/
  --self-test           验证模型可加载，输出 {"ok": true/false}
  --image <path> --engine <glm|omni|auto>   对图片执行推理
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
def _resolve_models_dir() -> Path:
    """模型目录：优先使用 VCLI_CONFIG_ROOT 环境变量，回退到 ~/.vcli/。"""
    config_root = os.environ.get("VCLI_CONFIG_ROOT")
    if config_root:
        return Path(config_root) / "models"
    return Path.home() / ".vcli" / "models"


MODELS_DIR = _resolve_models_dir()

GLM_OCR_REPO = "zai-org/GLM-OCR"
OMNIPARSER_REPO = "microsoft/OmniParser-v2.0"
FLORENCE_CAPTION_REPO = "microsoft/Florence-2-base-ft"
FLORENCE_PROCESSOR_REPO = "microsoft/Florence-2-base"

HF_MIRROR = "https://hf-mirror.com"

GLM_OCR_DIR = MODELS_DIR / "glm-ocr"
OMNIPARSER_DIR = MODELS_DIR / "omniparser"
ICON_DETECT_DIR = OMNIPARSER_DIR / "icon_detect"
ICON_CAPTION_DIR = OMNIPARSER_DIR / "icon_caption"
ICON_PROCESSOR_DIR = OMNIPARSER_DIR / "icon_processor"
EASYOCR_DIR = MODELS_DIR / "easyocr"

GLM_OCR_MODEL_DISPLAY = "GLM-OCR 0.9B"
OMNIPARSER_MODEL_DISPLAY = "OmniParser V2"
AUTO_MODEL_DISPLAY = f"{GLM_OCR_MODEL_DISPLAY} + {OMNIPARSER_MODEL_DISPLAY}"

OCR_PROMPT = "请识别并输出图片中的所有文字内容，保留原始排版。"
CAPTION_PROMPT = "<CAPTION>"


# ---------------------------------------------------------------------------
# 输出辅助
# ---------------------------------------------------------------------------
def log(message: str) -> None:
    """进度信息输出到 stderr（Node.js 仅捕获 stdout）。"""
    print(message, file=sys.stderr, flush=True)


def emit(payload: dict[str, Any]) -> None:
    """以 JSON 形式输出到 stdout。"""
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def emit_error(code: str, message: str) -> None:
    emit({"ok": False, "error": {"code": code, "message": message}})


# ---------------------------------------------------------------------------
# 设备
# ---------------------------------------------------------------------------
def get_device() -> str:
    try:
        import torch  # type: ignore[import-untyped]
    except ImportError:
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"


def get_dtype():
    import torch  # type: ignore[import-untyped]
    return torch.float16 if torch.cuda.is_available() else torch.float32


# ---------------------------------------------------------------------------
# 模型下载
# ---------------------------------------------------------------------------
def download_snapshot(repo_id: str, local_dir: Path, allow_patterns: list[str] | None = None) -> str:
    """使用 huggingface_hub 下载快照，先尝试 huggingface.co，失败回退 hf-mirror.com。"""
    from huggingface_hub import snapshot_download  # type: ignore[import-untyped]

    local_dir.mkdir(parents=True, exist_ok=True)
    log(f"下载 {repo_id} -> {local_dir}（huggingface.co）")
    try:
        return snapshot_download(
            repo_id=repo_id,
            local_dir=str(local_dir),
            allow_patterns=allow_patterns,
        )
    except Exception as exc:
        log(f"huggingface.co 下载失败：{exc}")
        log(f"切换镜像：{HF_MIRROR}")
        os.environ["HF_ENDPOINT"] = HF_MIRROR
        return snapshot_download(
            repo_id=repo_id,
            local_dir=str(local_dir),
            allow_patterns=allow_patterns,
        )


def init_easyocr_models() -> None:
    """预下载 EasyOCR 自带模型到工作区（失败不视为致命错误，使用时会再次尝试）。"""
    try:
        log("初始化 EasyOCR（下载其自带模型）…")
        import easyocr  # type: ignore[import-untyped]
        EASYOCR_DIR.mkdir(parents=True, exist_ok=True)
        easyocr.Reader(
            ["ch_sim", "en"],
            gpu=False,
            model_storage_directory=str(EASYOCR_DIR),
        )
        log("EasyOCR 模型就绪")
    except Exception as exc:
        log(f"EasyOCR 预下载失败（将在使用时重试）：{exc}")


def _clean_florence2_custom_code(directory: Path) -> None:
    """已废弃：保留旧版 .py 文件用于 Strategy B 兼容层加载。

    保留 configuration_florence2.py / modeling_florence2.py / processing_florence2.py，
    运行时通过 get_class_from_dynamic_module 加载，配合 transformers 5.3 使用。
    此函数仅保留签名以兼容旧调用点，实际不做任何操作。
    """
    return None


# ---------------------------------------------------------------------------
# 模型完整性校验
# ---------------------------------------------------------------------------
def _check_file(path: Path) -> bool:
    """检查文件存在且大小 > 0。"""
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def _check_dir_has_files(path: Path, suffix: str | None = None, min_count: int = 1) -> bool:
    """检查目录存在且至少有 min_count 个文件（可按后缀过滤）。"""
    try:
        if not path.is_dir():
            return False
        files = list(path.iterdir())
        if suffix is not None:
            files = [f for f in files if f.suffix == suffix]
        return len(files) >= min_count
    except OSError:
        return False


def verify_model_integrity() -> list[str]:
    """校验全部模型文件完整性，返回缺失/空文件列表（空列表表示全部通过）。"""
    missing: list[str] = []

    # GLM-OCR
    if not _check_file(GLM_OCR_DIR / "config.json"):
        missing.append("glm-ocr/config.json")
    if not _check_dir_has_files(GLM_OCR_DIR, ".safetensors", 1):
        missing.append("glm-ocr/*.safetensors")
    if not _check_file(GLM_OCR_DIR / "preprocessor_config.json"):
        missing.append("glm-ocr/preprocessor_config.json")
    if not (_check_file(GLM_OCR_DIR / "tokenizer.json") or
            _check_file(GLM_OCR_DIR / "tokenizer_config.json")):
        missing.append("glm-ocr/tokenizer.json 或 tokenizer_config.json")

    # OmniParser — YOLO
    if not _check_file(ICON_DETECT_DIR / "model.pt"):
        missing.append("omniparser/icon_detect/model.pt")

    # OmniParser — Florence-2 caption (权重 + 配置 + 旧模型代码)
    if not _check_file(ICON_CAPTION_DIR / "config.json"):
        missing.append("omniparser/icon_caption/config.json")
    if not _check_dir_has_files(ICON_CAPTION_DIR, ".safetensors", 1):
        missing.append("omniparser/icon_caption/*.safetensors")
    for py_file in ("configuration_florence2.py", "modeling_florence2.py"):
        if not _check_file(ICON_CAPTION_DIR / py_file):
            missing.append(f"omniparser/icon_caption/{py_file}")

    # OmniParser — Florence-2 processor (tokenizer + 图像预处理 + processing 代码)
    if not _check_file(ICON_PROCESSOR_DIR / "config.json"):
        missing.append("omniparser/icon_processor/config.json")
    if not _check_file(ICON_PROCESSOR_DIR / "tokenizer.json"):
        missing.append("omniparser/icon_processor/tokenizer.json")
    if not _check_file(ICON_PROCESSOR_DIR / "preprocessor_config.json"):
        missing.append("omniparser/icon_processor/preprocessor_config.json")
    if not _check_file(ICON_PROCESSOR_DIR / "processing_florence2.py"):
        missing.append("omniparser/icon_processor/processing_florence2.py")

    # EasyOCR — 检测模型 + 至少一个识别模型
    if not _check_file(EASYOCR_DIR / "craft_mlt_25k.pth"):
        missing.append("easyocr/craft_mlt_25k.pth")
    if not _check_dir_has_files(EASYOCR_DIR, ".pth", 2):
        missing.append("easyocr/*.pth (需要检测模型 + 至少一个识别模型)")

    return missing


def ensure_models_ready() -> None:
    """推理/自检前调用，文件不完整直接报错。"""
    missing = verify_model_integrity()
    if missing:
        log("模型文件不完整，缺失：")
        for item in missing:
            log(f"  - {item}")
        emit_error(
            "MODEL_INITIALIZATION_FAILED",
            f"模型文件不完整，缺失 {len(missing)} 项。请重新运行 vcli init。",
        )
        sys.exit(1)


def download_all_models() -> None:
    """下载全部模型组件到 ~/.vcli/models/。"""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    log("== 开始下载 GLM-OCR ==")
    download_snapshot(GLM_OCR_REPO, GLM_OCR_DIR)

    log("== 开始下载 OmniParser 组件 ==")
    # icon_detect：仅下载 icon_detect/model.pt
    download_snapshot(
        OMNIPARSER_REPO,
        OMNIPARSER_DIR,
        allow_patterns=["icon_detect/model.pt"],
    )
    # icon_caption：Florence-2-base-ft
    download_snapshot(FLORENCE_CAPTION_REPO, ICON_CAPTION_DIR)
    _clean_florence2_custom_code(ICON_CAPTION_DIR)
    # icon_processor：Florence-2-base（processor/tokenizer）
    download_snapshot(FLORENCE_PROCESSOR_REPO, ICON_PROCESSOR_DIR)
    _clean_florence2_custom_code(ICON_PROCESSOR_DIR)

    init_easyocr_models()

    # 下载后校验完整性
    missing = verify_model_integrity()
    if missing:
        log("警告：下载完成后部分文件仍缺失：")
        for item in missing:
            log(f"  - {item}")
        raise RuntimeError(f"模型下载不完整，缺失 {len(missing)} 项")

    log("== 全部模型下载完成 ==")


# ---------------------------------------------------------------------------
# GLM-OCR 引擎
# ---------------------------------------------------------------------------
def load_glm_ocr() -> tuple[Any, Any]:
    """加载 GLM-OCR 模型与 processor。

    GLM-OCR 属于 ImageTextToText 架构，官方推荐用 AutoModelForImageTextToText
    加载；AutoModel 会落到 GlmOcrModel，缺少 generate 方法。
    """
    from transformers import AutoModelForImageTextToText, AutoProcessor  # type: ignore[import-untyped]
    import torch  # type: ignore[import-untyped]

    device = get_device()
    dtype = get_dtype()
    kwargs: dict[str, Any] = {"trust_remote_code": True, "torch_dtype": dtype}
    if device == "cuda":
        kwargs["device_map"] = "auto"

    log(f"加载 GLM-OCR（device={device}, dtype={dtype}）…")
    model = AutoModelForImageTextToText.from_pretrained(str(GLM_OCR_DIR), **kwargs)
    if device != "cuda":
        model = model.to(device)
    model.eval()
    processor = AutoProcessor.from_pretrained(str(GLM_OCR_DIR), trust_remote_code=True)
    return model, processor


def run_glm_ocr(model: Any, processor: Any, image_path: str) -> tuple[str, list[dict[str, Any]]]:
    """使用 GLM-OCR 执行推理，返回 (全文, items)。"""
    import torch  # type: ignore[import-untyped]

    # GLM-OCR 官方格式：content 使用 url 字段传入图片路径
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "url": image_path},
                {"type": "text", "text": "Text Recognition:"},
            ],
        }
    ]

    inputs = processor.apply_chat_template(
        messages,
        tokenize=True,
        add_generation_prompt=True,
        return_dict=True,
        return_tensors="pt",
    ).to(model.device)

    # GLM-OCR 要求移除 token_type_ids
    inputs.pop("token_type_ids", None)

    with torch.inference_mode():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=4096,
            do_sample=False,
        )

    input_len = inputs["input_ids"].shape[1]
    generated_ids = output_ids[0][input_len:]
    recognized = processor.decode(generated_ids, skip_special_tokens=True).strip()

    if recognized:
        return recognized, [{"text": recognized, "confidence": 1.0}]
    return "", []


# ---------------------------------------------------------------------------
# OmniParser V2 引擎
# ---------------------------------------------------------------------------

# transformers 5.3 将 tied weights 从列表改成目标到源的映射。
LANGUAGE_MODEL_TIED_WEIGHTS = {
    "encoder.embed_tokens.weight": "shared.weight",
    "decoder.embed_tokens.weight": "shared.weight",
}
LANGUAGE_GENERATION_TIED_WEIGHTS = {
    "lm_head.weight": "model.shared.weight",
}
FLORENCE_TIED_WEIGHTS = {
    "language_model.lm_head.weight": "language_model.model.shared.weight",
}
FLORENCE_TOKENIZER_SPECIAL_TOKENS = {
    "bos_token": "<s>",
    "eos_token": "</s>",
    "unk_token": "<unk>",
    "sep_token": "</s>",
    "pad_token": "<pad>",
    "cls_token": "<s>",
    "mask_token": "<mask>",
}


def _load_florence_model(caption_path: str, device: str, dtype: Any) -> Any:
    """用 transformers 5.3 加载 OmniParser 的旧 Florence-2 权重（Strategy B）。

    保留旧 Florence-2 的 configuration/modeling .py 文件，通过
    get_class_from_dynamic_module 加载，仅修正 transformers 5.3 变化的元数据，
    不修改模型结构和权重内容。
    """
    from safetensors.torch import load_model  # type: ignore[import-untyped]
    from transformers import GenerationMixin, PretrainedConfig  # type: ignore[import-untyped]
    from transformers.dynamic_module_utils import get_class_from_dynamic_module  # type: ignore[import-untyped]

    # 旧 Florence 配置在构造阶段读取该属性；transformers 5.x 不再默认定义。
    if not hasattr(PretrainedConfig, "forced_bos_token_id"):
        PretrainedConfig.forced_bos_token_id = None

    config_class = get_class_from_dynamic_module(
        "configuration_florence2.Florence2Config",
        caption_path,
        local_files_only=True,
    )
    with open(f"{caption_path}/config.json", "r", encoding="utf-8") as config_file:
        config = config_class.from_dict(json.load(config_file))
    config._attn_implementation = "eager"

    model_class = get_class_from_dynamic_module(
        "modeling_florence2.Florence2ForConditionalGeneration",
        caption_path,
        local_files_only=True,
    )
    model_module = sys.modules[model_class.__module__]
    if not issubclass(model_class, GenerationMixin):
        model_class = type(
            "CompatibleFlorence2ForConditionalGeneration",
            (model_class, GenerationMixin),
            {},
        )

    # transformers 5.3 的类级元数据，不改变模型计算逻辑。
    model_class._supports_sdpa = False
    model_class._supports_flash_attn = False
    model_class._supports_flex_attn = False
    model_class._supports_attention_backend = False
    model_module.Florence2LanguageModel._tied_weights_keys = LANGUAGE_MODEL_TIED_WEIGHTS
    model_module.Florence2LanguageForConditionalGeneration._tied_weights_keys = (
        LANGUAGE_GENERATION_TIED_WEIGHTS
    )
    model_module.Florence2LanguageForConditionalGeneration._supports_default_dynamic_cache = (
        classmethod(lambda cls: False)
    )
    model_class._tied_weights_keys = FLORENCE_TIED_WEIGHTS

    model = model_class(config)
    missing, unexpected = load_model(
        model,
        f"{caption_path}/model.safetensors",
        strict=False,
    )
    # tied weights 的源参数会出现在 unexpected（因为 safetensors 存了，但模型通过 tie 引用）
    allowed_unexpected = {"language_model.model.shared.weight"}
    # tied weights 的目标参数会出现在 missing（因为 safetensors 不存，由源参数 tie 而来）
    allowed_missing = set(FLORENCE_TIED_WEIGHTS.keys()) | set(LANGUAGE_MODEL_TIED_WEIGHTS.keys()) | set(LANGUAGE_GENERATION_TIED_WEIGHTS.keys())
    missing_set = set(missing) - allowed_missing
    unexpected_set = set(unexpected) - allowed_unexpected
    if missing_set or unexpected_set:
        raise RuntimeError(
            "OmniParser Florence-2 权重与模型结构不匹配: "
            f"missing={sorted(missing_set)}, unexpected={sorted(unexpected_set)}"
        )
    # 显式绑定 tied weights：safetensors 不存 lm_head，必须从 shared weight 共享。
    # transformers 5.3 的 tie_weights() 在此场景下不会自动建立引用，需手动设置。
    model.language_model.lm_head.weight = model.language_model.model.shared.weight

    return model.to(device=device, dtype=dtype).eval()


def _load_florence_processor(processor_path: str) -> Any:
    """加载与 OmniParser 旧词表一致的 Florence-2 processor（Strategy B）。"""
    from transformers import (  # type: ignore[import-untyped]
        CLIPImageProcessor,
        PreTrainedTokenizerBase,
        PreTrainedTokenizerFast,
    )
    from transformers.dynamic_module_utils import get_class_from_dynamic_module  # type: ignore[import-untyped]

    # transformers 5.x 将该便捷属性移除，旧 processor 仍通过它读取已有
    # special tokens。只补只读属性，不修改 tokenizer 的词表。
    if not hasattr(PreTrainedTokenizerBase, "additional_special_tokens"):
        PreTrainedTokenizerBase.additional_special_tokens = property(
            lambda tokenizer: tokenizer.special_tokens_map.get(
                "additional_special_tokens", []
            )
        )

    tokenizer = PreTrainedTokenizerFast(
        tokenizer_file=f"{processor_path}/tokenizer.json",
        model_max_length=1024,
        **FLORENCE_TOKENIZER_SPECIAL_TOKENS,
    )
    image_processor = CLIPImageProcessor.from_pretrained(
        processor_path,
        local_files_only=True,
    )
    processor_class = get_class_from_dynamic_module(
        "processing_florence2.Florence2Processor",
        processor_path,
        local_files_only=True,
    )
    return processor_class(image_processor=image_processor, tokenizer=tokenizer)


def load_omniparser() -> dict[str, Any]:
    """加载 OmniParser 全部组件。"""
    from ultralytics import YOLO  # type: ignore[import-untyped]
    import easyocr  # type: ignore[import-untyped]

    device = get_device()
    dtype = get_dtype()
    log(f"加载 OmniParser（device={device}）…")

    yolo = YOLO(str(ICON_DETECT_DIR / "model.pt"))

    caption_processor = _load_florence_processor(str(ICON_PROCESSOR_DIR))
    caption_model = _load_florence_model(str(ICON_CAPTION_DIR), device, dtype)

    reader = easyocr.Reader(
        ["ch_sim", "en"],
        gpu=(device == "cuda"),
        model_storage_directory=str(EASYOCR_DIR),
        download_enabled=False,
        verbose=False,
    )

    return {
        "yolo": yolo,
        "caption_model": caption_model,
        "caption_processor": caption_processor,
        "reader": reader,
        "device": device,
    }


def run_omniparser(components: dict[str, Any], image_path: str) -> tuple[str, list[dict[str, Any]]]:
    """使用 OmniParser 执行推理：EasyOCR 文字 + YOLO 图标检测 + Florence-2 描述。"""
    import cv2  # type: ignore[import-untyped]
    import numpy as np  # type: ignore[import-untyped]

    yolo = components["yolo"]
    caption_model = components["caption_model"]
    caption_processor = components["caption_processor"]
    reader = components["reader"]

    items: list[dict[str, Any]] = []

    # 1. EasyOCR 文字识别
    try:
        image_cv = cv2.imread(image_path)
        if image_cv is None:
            raise FileNotFoundError(f"无法读取图片: {image_path}")
        ocr_results = reader.readtext(image_cv)
        for entry in ocr_results:
            bbox, text, conf = _parse_easyocr_entry(entry)
            if text:
                box = [[int(p[0]), int(p[1])] for p in bbox]
                items.append({
                    "text": text,
                    "confidence": float(conf),
                    "box": box,
                    "source": "easyocr",
                })
    except Exception as exc:
        log(f"EasyOCR 识别失败：{exc}")

    # 2. YOLO 图标检测
    detections: list[tuple[tuple[int, int, int, int], float]] = []
    try:
        results = yolo(image_path, verbose=False)
        for result in results:
            for box in result.boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                conf = float(box.conf[0])
                detections.append(((int(x1), int(y1), int(x2), int(y2)), conf))
    except Exception as exc:
        log(f"YOLO 检测失败：{exc}")

    # 3. Florence-2 为检测到的图标区域批量生成描述
    if detections:
        try:
            captions = _caption_icons(caption_model, caption_processor, image_cv, detections)
            for (x1, y1, x2, y2), conf in detections:
                idx = len([d for d in detections if d[0][0] < x1 or (d[0][0] == x1 and d[0][1] < y1)])
                caption = captions[idx] if idx < len(captions) else ""
                if caption:
                    items.append({
                        "text": caption,
                        "confidence": conf,
                        "box": [[x1, y1], [x2, y1], [x2, y2], [x1, y2]],
                        "source": "icon",
                    })
        except Exception as exc:
            log(f"图标描述失败：{exc}")

    text = "\n".join(item["text"] for item in items if item.get("text"))
    return text, items


def _caption_icons(model: Any, processor: Any, image: np.ndarray, detections: list[tuple[tuple[int, int, int, int], float]]) -> list[str]:
    """批量为图标区域生成描述（与原始 OmniParser 对齐：64x64 + num_beams=1 + do_resize=False）。"""
    import torch  # type: ignore[import-untyped]
    import cv2  # type: ignore[import-untyped]
    from PIL import Image as PILImage  # type: ignore[import-untyped]

    cropped_images: list[PILImage.Image] = []
    for (x1, y1, x2, y2), _conf in detections:
        x1, x2 = int(x1), int(x2)
        y1, y2 = int(y1), int(y2)
        crop = image[y1:y2, x1:x2, :]
        if crop.size == 0:
            crop = np.zeros((64, 64, 3), dtype=np.uint8)
        else:
            crop = cv2.resize(crop, (64, 64))
        cropped_images.append(PILImage.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)))

    if not cropped_images:
        return []

    device = model.device
    dtype = next(model.parameters()).dtype
    captions: list[str] = []
    prompt = CAPTION_PROMPT
    batch_size = 128

    for i in range(0, len(cropped_images), batch_size):
        batch = cropped_images[i:i + batch_size]
        inputs = processor(
            images=batch,
            text=[prompt] * len(batch),
            return_tensors="pt",
            do_resize=False,
        ).to(device, dtype=dtype)

        with torch.inference_mode():
            generated_ids = model.generate(
                input_ids=inputs["input_ids"],
                pixel_values=inputs["pixel_values"],
                max_new_tokens=20,
                num_beams=1,
                do_sample=False,
            )

        generated_text = processor.batch_decode(generated_ids, skip_special_tokens=True)
        captions.extend([t.strip() for t in generated_text])

    return captions


def _parse_easyocr_entry(entry: Any) -> tuple[list[list[float]], str, float]:
    """兼容 EasyOCR 不同版本的返回结构。

    常见结构：
      - (bbox, text, conf)
      - (bbox, text, conf, ?)
      - (bbox, text)
    """
    if isinstance(entry, (list, tuple)) and len(entry) >= 3:
        bbox, text, conf = entry[0], entry[1], entry[2]
    elif isinstance(entry, (list, tuple)) and len(entry) == 2:
        bbox, text = entry
        conf = 0.0
    else:
        raise ValueError(f"无法解析 EasyOCR 返回项：{entry}")
    return [[float(p[0]), float(p[1])] for p in bbox], str(text), float(conf)


def _move_inputs(inputs: Any, device: Any) -> Any:
    """将模型输入张量移动到指定设备。"""
    if hasattr(inputs, "to"):
        try:
            return inputs.to(device)
        except Exception:
            return inputs
    if isinstance(inputs, dict):
        moved: dict[str, Any] = {}
        for key, value in inputs.items():
            if hasattr(value, "to"):
                try:
                    moved[key] = value.to(device)
                except Exception:
                    moved[key] = value
            else:
                moved[key] = value
        return moved
    return inputs


# ---------------------------------------------------------------------------
# Auto 引擎
# ---------------------------------------------------------------------------
def run_auto(image_path: str) -> tuple[str, list[dict[str, Any]], str]:
    """运行 GLM-OCR + OmniParser 并合并结果。返回 (全文, items, model 显示名)。"""
    text_parts: list[str] = []
    items: list[dict[str, Any]] = []

    # GLM-OCR
    try:
        model, processor = load_glm_ocr()
        glm_text, glm_items = run_glm_ocr(model, processor, image_path)
        if glm_text:
            text_parts.append(glm_text)
        for item in glm_items:
            item["source"] = "glm"
            items.append(item)
    except Exception as exc:
        log(f"GLM-OCR 推理失败：{exc}")

    # OmniParser
    try:
        components = load_omniparser()
        omni_text, omni_items = run_omniparser(components, image_path)
        if omni_text:
            text_parts.append(omni_text)
        items.extend(omni_items)
    except Exception as exc:
        log(f"OmniParser 推理失败：{exc}")

    text = "\n".join(part for part in text_parts if part)
    return text, items, AUTO_MODEL_DISPLAY


# ---------------------------------------------------------------------------
# 自检
# ---------------------------------------------------------------------------
def self_test() -> bool:
    """验证全部模型可加载。"""
    import traceback
    # 先校验文件完整性，避免因文件缺失导致难以理解的加载错误
    missing = verify_model_integrity()
    if missing:
        log("模型文件不完整，缺失：")
        for item in missing:
            log(f"  - {item}")
        return False
    try:
        load_glm_ocr()
    except Exception as exc:
        log(f"GLM-OCR 自检失败：{exc}")
        log(traceback.format_exc())
        return False
    try:
        load_omniparser()
    except Exception as exc:
        log(f"OmniParser 自检失败：{exc}")
        log(traceback.format_exc())
        return False
    return True


# ---------------------------------------------------------------------------
# 推理入口
# ---------------------------------------------------------------------------
def run_inference(image_path: str, engine: str) -> None:
    """按引擎执行推理并输出 JSON。"""
    try:
        if engine == "glm":
            model, processor = load_glm_ocr()
            text, items = run_glm_ocr(model, processor, image_path)
            model_name = GLM_OCR_MODEL_DISPLAY
        elif engine == "omni":
            components = load_omniparser()
            text, items = run_omniparser(components, image_path)
            model_name = OMNIPARSER_MODEL_DISPLAY
        elif engine == "auto":
            text, items, model_name = run_auto(image_path)
        else:
            emit_error("MODEL_RECOGNITION_FAILED", f"未知引擎：{engine}")
            sys.exit(1)
    except ImportError as exc:
        emit_error("MODEL_RUNTIME_MISSING", f"Python 依赖未安装：{exc}")
        sys.exit(1)
    except Exception as exc:
        emit_error("MODEL_INITIALIZATION_FAILED", f"模型加载失败：{exc}")
        sys.exit(1)

    if not text or not items:
        emit_error("MODEL_TEXT_EMPTY", "未识别到文字")
        sys.exit(1)

    emit({
        "ok": True,
        "text": text,
        "items": items,
        "engine": engine,
        "model": model_name,
    })


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="vcli 视觉推理（GLM-OCR / OmniParser V2）")
    parser.add_argument("--init", action="store_true", help="下载全部模型到 ~/.vcli/models/")
    parser.add_argument("--self-test", action="store_true", help="验证模型可加载")
    parser.add_argument("--image", help="图片文件路径")
    parser.add_argument(
        "--engine",
        choices=["glm", "omni", "auto"],
        default="auto",
        help="推理引擎（默认 auto）",
    )
    args = parser.parse_args()

    if args.init:
        try:
            download_all_models()
        except Exception as exc:
            emit_error("MODEL_INITIALIZATION_FAILED", f"模型下载失败：{exc}")
            sys.exit(1)
        emit({"ok": True})
        sys.exit(0)

    if args.self_test:
        ok = self_test()
        emit({"ok": ok})
        sys.exit(0 if ok else 1)

    if not args.image:
        emit_error("IMAGE_READ_ERROR", "未指定图片路径")
        sys.exit(1)

    if not os.path.isfile(args.image):
        emit_error("IMAGE_READ_ERROR", f"图片不存在：{args.image}")
        sys.exit(1)

    # 推理前校验模型文件完整性
    ensure_models_ready()
    run_inference(args.image, args.engine)


if __name__ == "__main__":
    main()
