#!/usr/bin/env python3
"""vcli 视觉推理脚本 — PP-OCRv6 + OmniParser YOLO

设计：
- 默认模式：PP-OCRv6 整图识别，速度快、带坐标
- --web 模式：额外跑 YOLO 检测 UI 元素位置，与 OCR 文字合并输出
  适用于网页/UI 截图场景，普通文档无需启用

命令：
  --init                          下载全部模型
  --self-test                     验证模型可加载
  --image <path>                  对图片执行推理
  --ocr <ppocrv6>                 OCR 引擎（当前仅支持 ppocrv6）
  --web                           启用 YOLO UI 元素检测（网页/UI 场景）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from PIL import Image

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
def _resolve_models_dir() -> Path:
    """模型目录：优先使用 VCLI_CONFIG_ROOT 环境变量。

    回退顺序：
    1. ~/.vcli-data/models（Windows 上常见的工作区）
    2. ~/.vcli/models（默认位置）
    """
    config_root = os.environ.get("VCLI_CONFIG_ROOT")
    if config_root:
        return Path(config_root) / "models"
    return Path.home() / ".vcli" / "models"


MODELS_DIR = _resolve_models_dir()

OMNIPARSER_REPO = "microsoft/OmniParser-v2.0"
HF_MIRROR = "https://hf-mirror.com"

OMNIPARSER_DIR = MODELS_DIR / "omniparser"
ICON_DETECT_DIR = OMNIPARSER_DIR / "icon_detect"
PPOCR_DIR = MODELS_DIR / "ppocr"

PPOCR_MODEL_DISPLAY = "PP-OCRv6 (RapidOCR + OpenVINO)"
YOLO_MODEL_DISPLAY = "OmniParser V2 YOLO"

# YOLO 置信度阈值
BOX_THRESHOLD = 0.25
# OCR 文字框与 YOLO UI 框的 IoU 阈值，超过则认为文字属于该 UI 元素
IOU_MATCH_THRESHOLD = 0.3
# 文字框与 UI 框中心点距离阈值（像素），用于辅助匹配
CENTER_DIST_THRESHOLD = 50
# 面积比阈值：OCR 框面积 / UI 框面积 > 该值时不合并，避免大段落被误吞
MAX_AREA_RATIO = 2.5
# UI 元素最小面积（像素），过小的图标不吞文字
MIN_UI_AREA = 500


# ---------------------------------------------------------------------------
# 输出辅助
# ---------------------------------------------------------------------------
def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def emit_error(code: str, message: str) -> None:
    emit({"ok": False, "error": {"code": code, "message": message}})


# ---------------------------------------------------------------------------
# 设备 / 下载 / 校验
# ---------------------------------------------------------------------------
def get_device() -> str:
    try:
        import torch  # type: ignore[import-untyped]
    except ImportError:
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"


def download_snapshot(repo_id: str, local_dir: Path, allow_patterns: list[str] | None = None) -> str:
    from huggingface_hub import snapshot_download  # type: ignore[import-untyped]

    local_dir.mkdir(parents=True, exist_ok=True)
    log(f"下载 {repo_id} -> {local_dir}（huggingface.co）")
    try:
        return snapshot_download(repo_id=repo_id, local_dir=str(local_dir), allow_patterns=allow_patterns)
    except Exception as exc:
        log(f"huggingface.co 下载失败：{exc}")
        log(f"切换镜像：{HF_MIRROR}")
        os.environ["HF_ENDPOINT"] = HF_MIRROR
        return snapshot_download(repo_id=repo_id, local_dir=str(local_dir), allow_patterns=allow_patterns)


def init_ppocr_models() -> None:
    try:
        from rapidocr import RapidOCR  # type: ignore[import-untyped]
        from rapidocr.utils.typings import EngineType  # type: ignore[import-untyped]
        log("初始化 PP-OCRv6（下载其模型）…")
        PPOCR_DIR.mkdir(parents=True, exist_ok=True)
        engine = EngineType.OPENVINO
        RapidOCR(params={"Global.model_root_dir": str(PPOCR_DIR),
                         "Det.engine_type": engine,
                         "Cls.engine_type": engine,
                         "Rec.engine_type": engine})
        log("PP-OCRv6 模型就绪")
    except Exception as exc:
        log(f"PP-OCRv6 预下载失败（将在使用时重试）：{exc}")


def download_all_models() -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    log("== 开始下载 OmniParser YOLO ==")
    download_snapshot(OMNIPARSER_REPO, OMNIPARSER_DIR, allow_patterns=["icon_detect/model.pt"])
    log("== 开始下载 PP-OCRv6 ==")
    init_ppocr_models()
    missing = verify_model_integrity()
    if missing:
        log("警告：下载完成后部分文件仍缺失：")
        for item in missing:
            log(f"  - {item}")
        raise RuntimeError(f"模型下载不完整，缺失 {len(missing)} 项")
    log("== 全部模型下载完成 ==")


def _check_file(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def _check_dir_has_files(path: Path, min_count: int = 1) -> bool:
    try:
        if not path.is_dir():
            return False
        return len(list(path.iterdir())) >= min_count
    except OSError:
        return False


def verify_model_integrity() -> list[str]:
    missing: list[str] = []
    if not _check_file(ICON_DETECT_DIR / "model.pt"):
        missing.append("omniparser/icon_detect/model.pt")
    if not _check_dir_has_files(PPOCR_DIR, 1):
        missing.append("ppocr/ (RapidOCR 模型未下载)")
    return missing


def ensure_models_ready() -> None:
    missing = verify_model_integrity()
    if missing:
        log("模型文件不完整，缺失：")
        for item in missing:
            log(f"  - {item}")
        emit_error("MODEL_INITIALIZATION_FAILED", f"模型文件不完整，缺失 {len(missing)} 项。请重新运行 vcli init。")
        sys.exit(1)


# ---------------------------------------------------------------------------
# PP-OCRv6 引擎
# ---------------------------------------------------------------------------
_ppocr_engine: Any = None


def load_ppocr() -> Any:
    global _ppocr_engine
    if _ppocr_engine is not None:
        return _ppocr_engine

    try:
        from rapidocr import RapidOCR  # type: ignore[import-untyped]
        from rapidocr.utils.typings import EngineType  # type: ignore[import-untyped]
    except ImportError as exc:
        emit_error("MODEL_RUNTIME_MISSING", f"RapidOCR 未安装或无法导入：{exc}")
        sys.exit(1)

    try:
        engine = EngineType.OPENVINO
        _ppocr_engine = RapidOCR(params={
            "Global.model_root_dir": str(PPOCR_DIR),
            "Det.engine_type": engine,
            "Cls.engine_type": engine,
            "Rec.engine_type": engine,
        })
    except Exception as exc:
        emit_error("MODEL_INITIALIZATION_FAILED", f"PP-OCRv6 初始化失败：{exc}")
        sys.exit(1)
    return _ppocr_engine


def run_ppocr(image_path: str) -> tuple[str, list[dict[str, Any]]]:
    """对整张图片运行 PP-OCRv6，返回文本和带坐标的识别项。"""
    engine = load_ppocr()
    result = engine(image_path)
    boxes = result.boxes if result.boxes is not None else []
    txts = result.txts if result.txts is not None else []
    scores = result.scores if result.scores is not None else []

    items: list[dict[str, Any]] = []
    for index, text in enumerate(txts):
        if not text:
            continue
        item: dict[str, Any] = {"text": text, "source": "ppocr"}
        if index < len(scores) and scores[index] is not None:
            item["confidence"] = float(scores[index])
        if index < len(boxes) and boxes[index] is not None:
            pts = [[int(point[0]), int(point[1])] for point in boxes[index]]
            item["box"] = pts
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            item["bbox"] = [min(xs), min(ys), max(xs), max(ys)]
        items.append(item)

    text = "\n".join(item["text"] for item in items)
    return text, items


# ---------------------------------------------------------------------------
# YOLO UI 元素检测
# ---------------------------------------------------------------------------
_yolo_model: Any = None


def load_yolo() -> Any:
    global _yolo_model
    if _yolo_model is not None:
        return _yolo_model

    from ultralytics import YOLO  # type: ignore[import-untyped]
    log(f"加载 OmniParser YOLO（device={get_device()}）…")
    yolo = YOLO(str(ICON_DETECT_DIR / "model.pt"))
    device = get_device()
    if device.startswith("cuda"):
        yolo.to(device)
    _yolo_model = yolo
    return _yolo_model


def run_yolo_detection(image_path: str) -> list[dict[str, Any]]:
    """用 YOLO 检测 UI 元素，返回带 bbox 的检测项。"""
    model = load_yolo()
    results = model(image_path, conf=BOX_THRESHOLD, verbose=False)
    detections: list[dict[str, Any]] = []
    for result in results:
        for box in result.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            conf = float(box.conf[0])
            detections.append({
                "box": [[int(x1), int(y1)], [int(x2), int(y1)], [int(x2), int(y2)], [int(x1), int(y2)]],
                "bbox": [int(x1), int(y1), int(x2), int(y2)],
                "confidence": conf,
                "source": "yolo",
            })
    return detections


# ---------------------------------------------------------------------------
# 框匹配与合并
# ---------------------------------------------------------------------------
def box_iou(a: list[int], b: list[int]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    if inter_x2 <= inter_x1 or inter_y2 <= inter_y1:
        return 0.0
    inter = (inter_x2 - inter_x1) * (inter_y2 - inter_y1)
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def center_dist(a: list[int], b: list[int]) -> float:
    ax = (a[0] + a[2]) / 2
    ay = (a[1] + a[3]) / 2
    bx = (b[0] + b[2]) / 2
    by = (b[1] + b[3]) / 2
    return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5


def assign_text_to_ui(
    ocr_items: list[dict[str, Any]],
    ui_items: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """把 OCR 文字框分配到 YOLO UI 元素上。

    返回：
    - ui_with_text：每个 UI 元素内匹配到的文字列表
    - unassigned：未匹配到任何 UI 元素的文字段落
    """
    assigned_flags = [False] * len(ocr_items)
    ui_with_text: list[dict[str, Any]] = []

    for ui in ui_items:
        ui_bbox = ui["bbox"]
        texts: list[tuple[str, float]] = []
        for idx, ocr in enumerate(ocr_items):
            if assigned_flags[idx]:
                continue
            ocr_bbox = ocr.get("bbox")
            if not ocr_bbox:
                continue
            ui_area = max(1, (ui_bbox[2] - ui_bbox[0]) * (ui_bbox[3] - ui_bbox[1]))
            ocr_area = max(1, (ocr_bbox[2] - ocr_bbox[0]) * (ocr_bbox[3] - ocr_bbox[1]))
            if ui_area < MIN_UI_AREA:
                continue
            iou = box_iou(ui_bbox, ocr_bbox)
            dist = center_dist(ui_bbox, ocr_bbox)
            area_ratio = ocr_area / ui_area
            if (iou >= IOU_MATCH_THRESHOLD or dist <= CENTER_DIST_THRESHOLD) and area_ratio <= MAX_AREA_RATIO:
                conf = ocr.get("confidence", 0.0)
                texts.append((ocr["text"], conf))
                assigned_flags[idx] = True

        merged_text = " ".join(t[0] for t in texts)
        avg_conf = sum(t[1] for t in texts) / len(texts) if texts else ui["confidence"]
        ui_with_text.append({
            "text": merged_text,
            "box": ui["box"],
            "bbox": ui_bbox,
            "confidence": round(avg_conf, 4),
            "type": "ui_element" if not merged_text else "ui_text",
            "source": "yolo+ocr",
        })

    unassigned: list[dict[str, Any]] = []
    for idx, ocr in enumerate(ocr_items):
        if not assigned_flags[idx]:
            unassigned.append(ocr)

    return ui_with_text, unassigned


def merge_web_results(
    image_path: str,
    ocr_items: list[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]], str]:
    """网页模式：OCR 全图 + YOLO UI 定位 + 合并。"""
    log("Web 模式：OCR 全图识别 + YOLO UI 定位")

    ui_items = run_yolo_detection(image_path)
    log(f"YOLO 检测到 {len(ui_items)} 个 UI 元素（阈值={BOX_THRESHOLD}）")

    ui_with_text, unassigned = assign_text_to_ui(ocr_items, ui_items)

    # 合并所有元素：UI 元素 + 未匹配的 OCR 段落
    all_items = ui_with_text + unassigned

    # 排序：从上到下、从左到右
    def sort_key(item: dict[str, Any]) -> tuple[int, int]:
        bbox = item.get("bbox") or item.get("box")
        if bbox:
            return (bbox[1], bbox[0])
        return (0, 0)

    all_items.sort(key=sort_key)

    # 生成全文
    text_parts: list[str] = []
    for item in all_items:
        if item.get("text"):
            text_parts.append(item["text"])
        else:
            text_parts.append("[ui_element]")

    text = "\n".join(text_parts)
    model_name = f"{YOLO_MODEL_DISPLAY} + {PPOCR_MODEL_DISPLAY}"
    return text, all_items, model_name


def run_inference(image_path: str, ocr_engine: str, web_mode: bool) -> None:
    try:
        text, ocr_items = run_ppocr(image_path)
    except ImportError as exc:
        emit_error("MODEL_RUNTIME_MISSING", f"Python 依赖未安装：{exc}")
        sys.exit(1)
    except Exception as exc:
        emit_error("MODEL_INITIALIZATION_FAILED", f"模型加载失败：{exc}")
        sys.exit(1)

    if not text or not ocr_items:
        emit_error("MODEL_TEXT_EMPTY", "未识别到文字")
        sys.exit(1)

    if web_mode:
        text, items, model_name = merge_web_results(image_path, ocr_items)
    else:
        items = ocr_items
        model_name = PPOCR_MODEL_DISPLAY

    emit({
        "ok": True,
        "text": text,
        "items": items,
        "engine": "web" if web_mode else ocr_engine,
        "ocr": ocr_engine,
        "model": model_name,
    })


# ---------------------------------------------------------------------------
# 自检 / 主入口
# ---------------------------------------------------------------------------
def self_test() -> bool:
    import traceback
    missing = verify_model_integrity()
    if missing:
        log("模型文件不完整，缺失：")
        for item in missing:
            log(f"  - {item}")
        return False
    try:
        load_ppocr()
    except Exception as exc:
        log(f"PP-OCRv6 自检失败：{exc}")
        log(traceback.format_exc())
        return False
    try:
        load_yolo()
    except Exception as exc:
        log(f"YOLO 自检失败：{exc}")
        log(traceback.format_exc())
        return False
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="vcli 视觉推理（PP-OCRv6 + YOLO）")
    parser.add_argument("--init", action="store_true", help="下载全部模型")
    parser.add_argument("--self-test", action="store_true", help="验证模型可加载")
    parser.add_argument("--image", help="图片文件路径")
    parser.add_argument("--ocr", choices=["ppocrv6"], default="ppocrv6", help="OCR 引擎（默认 ppocrv6）")
    parser.add_argument("--web", action="store_true", help="启用 YOLO UI 元素检测（网页/UI 场景）")
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

    ensure_models_ready()
    run_inference(args.image, args.ocr, args.web)


if __name__ == "__main__":
    main()
