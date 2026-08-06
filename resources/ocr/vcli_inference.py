#!/usr/bin/env python3
"""vcli 视觉推理脚本 — PP-OCRv6 + OmniParser YOLO + Qwen2.5-VL

设计：
- 默认模式：PP-OCRv6 整图识别，速度快、带坐标
- --mode vlm：Qwen2.5-VL 直接看图，支持自定义 --prompt，输出结构化 JSON
- --mode mix：先 OCR，释放 OCR 资源后，再加载 VLM 并注入 OCR 结果
- --web 模式：额外跑 YOLO 检测 UI 元素位置，与 OCR 文字合并输出
  适用于网页/UI 截图场景，普通文档无需启用

命令：
  --init --compute <ocr|vlm|both>        按范围下载模型
  --self-test --compute <ocr|vlm|both>   验证对应模型可加载
  --image <path>                         对图片执行推理
  --mode <ocr|vlm|mix>                   识别模式（默认 ocr）
  --prompt <text>                        VLM/mix 模式自定义问题
  --ocr <ppocrv6>                        OCR 引擎（当前仅支持 ppocrv6）
  --web                                  启用 YOLO UI 元素检测（网页/UI 场景）
"""
from __future__ import annotations

import argparse
import gc
import json
import os
import re
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
VLM_MODEL_DISPLAY = "Qwen2.5-VL 7B (transformers)"

# VLM 模型仓库
VLM_REPO = "Qwen/Qwen2.5-VL-7B-Instruct"
VLM_AWQ_REPO = "Qwen/Qwen2.5-VL-7B-Instruct-AWQ"
VLM_DIR = MODELS_DIR / "vlm"

# VLM 默认 / 模式默认 prompt
VLM_DEFAULT_PROMPT = "描述这张截图的内容、布局和用户意图"
MIX_DEFAULT_PROMPT = "结合下方OCR结果，回答：描述这张截图的内容、布局和用户意图"

# VLM 输出 JSON 解析失败后回退到 raw 文本
VLM_JSON_INSTRUCTION = (
    "请严格输出一个 JSON 对象，包含以下字段："
    "summary（内容摘要，字符串）、intent（用户意图，字符串）、"
    "elements（可交互元素数组，每项含 role 元素类型、text 文字、position 位置）。"
    "不要输出 JSON 以外的任何内容。"
)

# YOLO 置信度阈值
BOX_THRESHOLD = 0.25
# 空 UI 元素保留阈值：text 为空且 confidence 低于该值的 YOLO 误检直接丢弃
DEFAULT_MIN_UI_CONFIDENCE = 0.55
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
    # 紧凑序列化：去掉无意义空格，缩小 JSON 体积约 5~10%
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


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


def download_all_models(compute: str = "both", quant: str = "bf16") -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    want_ocr = compute in ("ocr", "both")
    want_vlm = compute in ("vlm", "both")

    if want_ocr:
        log("== 开始下载 OmniParser YOLO ==")
        download_snapshot(OMNIPARSER_REPO, OMNIPARSER_DIR, allow_patterns=["icon_detect/model.pt"])
        log("== 开始下载 PP-OCRv6 ==")
        init_ppocr_models()
    if want_vlm:
        log(f"== 开始下载 {VLM_MODEL_DISPLAY}（{quant}） ==")
        download_vlm(quant)

    missing = verify_model_integrity(compute)
    if missing:
        log("警告：下载完成后部分文件仍缺失：")
        for item in missing:
            log(f"  - {item}")
        raise RuntimeError(f"模型下载不完整，缺失 {len(missing)} 项")
    log("== 全部模型下载完成 ==")


def download_vlm(quant: str = "bf16") -> None:
    """下载对应量化版本的 VLM 权重。awq 取 AWQ 量化仓库，否则下载 BF16 全量权重。"""
    VLM_DIR.mkdir(parents=True, exist_ok=True)
    repo = VLM_AWQ_REPO if quant == "awq" else VLM_REPO
    download_snapshot(repo, VLM_DIR)


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


def verify_model_integrity(compute: str = "both") -> list[str]:
    missing: list[str] = []
    want_ocr = compute in ("ocr", "both")
    want_vlm = compute in ("vlm", "both")
    if want_ocr:
        if not _check_file(ICON_DETECT_DIR / "model.pt"):
            missing.append("omniparser/icon_detect/model.pt")
        if not _check_dir_has_files(PPOCR_DIR, 1):
            missing.append("ppocr/ (RapidOCR 模型未下载)")
    if want_vlm:
        if not _check_dir_has_files(VLM_DIR, 1):
            missing.append("vlm/ (VLM 模型未下载)")
    return missing


def ensure_models_ready(compute: str = "both") -> None:
    missing = verify_model_integrity(compute)
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
            pts = boxes[index]
            xs = [int(p[0]) for p in pts]
            ys = [int(p[1]) for p in pts]
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


# ---------------------------------------------------------------------------
# 页面布局分析（通用结构线索，语言无关）
# ---------------------------------------------------------------------------
def compute_geometry(bbox: list[int], img_w: int, img_h: int) -> dict[str, Any]:
    """计算单个元素的几何特征：宽高比、九宫格区域。"""
    x1, y1, x2, y2 = bbox
    w = x2 - x1
    h = y2 - y1
    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0

    # 九宫格定位
    rel_x = cx / img_w if img_w > 0 else 0.5
    rel_y = cy / img_h if img_h > 0 else 0.5
    if rel_y < 0.33:
        v = "top"
    elif rel_y < 0.66:
        v = "middle"
    else:
        v = "bottom"
    if rel_x < 0.33:
        hz = "left"
    elif rel_x < 0.66:
        hz = "center"
    else:
        hz = "right"
    region = f"{v}-{hz}" if v != "middle" or hz != "center" else "center"

    return {
        "aspect": round(w / max(1, h), 2),
        "region": region,
    }


def _cluster_items(items: list[dict[str, Any]]) -> list[list[int]]:
    """按空间邻近度聚类 UI 元素（并查集）。

    两个元素的中心距 < 平均特征尺寸 × 1.5 则归为同一组。
    平均特征尺寸 = 所有元素 (w+h)/2 的均值。
    这是 web 页面的通用规律：同组间距 < 元素尺寸。
    """
    n = len(items)
    if n <= 1:
        return [[i] for i in range(n)]

    centers: list[tuple[float, float]] = []
    char_sizes: list[float] = []
    for item in items:
        b = item.get("bbox", [0, 0, 0, 0])
        cx = (b[0] + b[2]) / 2.0
        cy = (b[1] + b[3]) / 2.0
        w = max(1, b[2] - b[0])
        h = max(1, b[3] - b[1])
        centers.append((cx, cy))
        char_sizes.append((w + h) / 2.0)

    avg_char_size = sum(char_sizes) / n
    threshold = avg_char_size * 1.5

    parent = list(range(n))
    def _find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def _union(x: int, y: int) -> None:
        px, py = _find(x), _find(y)
        if px != py:
            parent[py] = px

    for i in range(n):
        for j in range(i + 1, n):
            dx = centers[i][0] - centers[j][0]
            dy = centers[i][1] - centers[j][1]
            if (dx * dx + dy * dy) ** 0.5 < threshold:
                _union(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        p = _find(i)
        groups.setdefault(p, []).append(i)
    return list(groups.values())


def _arrangement(indices: list[int], items: list[dict[str, Any]]) -> str:
    """判断组内排列方式：horizontal / vertical / grid / single / scattered。"""
    n = len(indices)
    if n <= 1:
        return "single"
    bboxes = [items[i].get("bbox", [0, 0, 0, 0]) for i in indices]
    cxs = [(b[0] + b[2]) / 2.0 for b in bboxes]
    cys = [(b[1] + b[3]) / 2.0 for b in bboxes]

    if n == 2:
        dx = abs(cxs[0] - cxs[1])
        dy = abs(cys[0] - cys[1])
        if dx > dy * 2:
            return "horizontal"
        if dy > dx * 2:
            return "vertical"
        return "scattered"

    # 3+ items：用标准差判断主方向
    mean_x = sum(cxs) / n
    mean_y = sum(cys) / n
    var_x = sum((x - mean_x) ** 2 for x in cxs) / n
    var_y = sum((y - mean_y) ** 2 for y in cys) / n
    x_std = var_x ** 0.5
    y_std = var_y ** 0.5
    if x_std > y_std * 2:
        return "horizontal"
    if y_std > x_std * 2:
        return "vertical"
    if n >= 4 and x_std > 0 and y_std > 0:
        return "grid"
    return "scattered"


def _cluster_bbox(indices: list[int], items: list[dict[str, Any]]) -> list[int]:
    """计算组外接框。"""
    xs: list[int] = []
    ys: list[int] = []
    for i in indices:
        b = items[i].get("bbox", [0, 0, 0, 0])
        xs.extend([b[0], b[2]])
        ys.extend([b[1], b[3]])
    return [min(xs), min(ys), max(xs), max(ys)]


def compute_relations(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """计算每个元素与其他元素的包含/相邻/对齐关系。

    返回列表，与 items 一一对应。
    - contains: 此元素包含的子元素索引列表
    - contained_by: 被哪个元素包含（None 表示无父容器）
    - adjacent: 紧邻元素索引（中心距 < 自身尺寸 × 0.6）
    - aligned_row: 同行元素索引（y 中心差 < 自身高 × 0.5）
    - aligned_col: 同列元素索引（x 中心差 < 自身宽 × 0.5）
    """
    n = len(items)
    rels = [
        {"contains": [], "contained_by": None, "adjacent": [], "aligned_row": [], "aligned_col": []}
        for _ in range(n)
    ]

    bboxes = [item.get("bbox", [0, 0, 0, 0]) for item in items]

    for i in range(n):
        b = bboxes[i]
        w = max(1, b[2] - b[0])
        h = max(1, b[3] - b[1])
        cx = (b[0] + b[2]) / 2.0
        cy = (b[1] + b[3]) / 2.0
        area = w * h

        for j in range(n):
            if i == j:
                continue
            bj = bboxes[j]
            wj = max(1, bj[2] - bj[0])
            hj = max(1, bj[3] - bj[1])
            cxj = (bj[0] + bj[2]) / 2.0
            cyj = (bj[1] + bj[3]) / 2.0
            area_j = wj * hj

            # 包含关系：A 包含 B（A 的 bbox 完全覆盖 B，且面积大 1.5 倍以上）
            if (b[0] <= bj[0] and b[1] <= bj[1] and b[2] >= bj[2] and b[3] >= bj[3]
                    and area > area_j * 1.5):
                rels[i]["contains"].append(j)
                rels[j]["contained_by"] = i

            # 相邻：中心距 < 两元素较大尺寸 × 0.6
            max_dim = max(w, wj, h, hj)
            if ((cx - cxj) ** 2 + (cy - cyj) ** 2) ** 0.5 < max_dim * 0.6:
                rels[i]["adjacent"].append(j)

            # 同行：y 中心差 < 两元素较矮高 × 0.5
            if abs(cy - cyj) < max(h, hj) * 0.5:
                rels[i]["aligned_row"].append(j)

            # 同列：x 中心差 < 两元素较窄宽 × 0.5
            if abs(cx - cxj) < max(w, wj) * 0.5:
                rels[i]["aligned_col"].append(j)

    return rels


def classify_text_pattern(text: str) -> str:
    """基于文本模式（非内容）进行分类，语言无关。"""
    if not text:
        return "empty"
    if re.match(r"^[\w.+-]+@[\w-]+\.\w{2,}$", text):
        return "email_pattern"
    if re.match(r"https?://", text):
        return "url_pattern"
    if re.match(r"^\+?\d[\d\s\-\(\)]{6,}$", text):
        return "phone_pattern"
    if re.match(r"^[\d\w._-]+$", text) and len(text) >= 6:
        return "code_pattern"
    if text.endswith(":") or text.endswith("："):
        return "label_pattern"
    if re.match(r"^[\d.,%$€£¥+\-*/=<>]+$", text):
        return "numeric_pattern"
    if len(text) <= 3:
        return "short"
    if len(text) > 50:
        return "paragraph"
    return "normal"


def detect_layout(
    items: list[dict[str, Any]],
    img_w: int,
    img_h: int,
) -> dict[str, Any]:
    """检测页面级通用结构模式，完全基于空间关系，语言无关。"""
    n = len(items)
    if n == 0:
        return {"img_size": [img_w, img_h], "item_count": 0, "patterns": {}}

    # 聚类
    groups = _cluster_items(items)
    cluster_summary: list[dict[str, Any]] = []
    for cid, indices in enumerate(groups):
        if not indices:
            continue
        c_bbox = _cluster_bbox(indices, items)
        c_geom = compute_geometry(c_bbox, img_w, img_h)
        cluster_summary.append({
            "id": cid,
            "size": len(indices),
            "arrangement": _arrangement(indices, items),
            "region": c_geom["region"],
        })

    # 检测页面模式
    patterns: dict[str, bool] = {
        "has_top_nav": any(
            c["region"].startswith("top") and c["arrangement"] == "horizontal" and c["size"] >= 3
            for c in cluster_summary),
        "has_form": any(
            c["region"].startswith("center") and c["arrangement"] == "vertical" and c["size"] >= 3
            for c in cluster_summary),
        "has_grid": any(
            c["arrangement"] == "grid" and c["size"] >= 4
            for c in cluster_summary),
        "has_sidebar": any(
            c["region"] in ("left", "top-left") and c["arrangement"] == "vertical" and c["size"] >= 3
            for c in cluster_summary),
        "has_footer": any(
            c["region"].startswith("bottom") and c["arrangement"] == "horizontal" and c["size"] >= 2
            for c in cluster_summary),
    }

    return {
        "img_size": [img_w, img_h],
        "item_count": n,
        "patterns": patterns,
        "cluster_summary": cluster_summary,
    }


def merge_web_results(
    image_path: str,
    ocr_items: list[dict[str, Any]],
    min_ui_confidence: float,
) -> tuple[str, list[dict[str, Any]], str, dict[str, Any] | None]:
    """网页模式：OCR 全图 + YOLO UI 定位 + 合并 + 布局分析。"""
    log("Web 模式：OCR 全图识别 + YOLO UI 定位")

    # 获取图片尺寸
    with Image.open(image_path) as img:
        img_w, img_h = img.size

    ui_items = run_yolo_detection(image_path)
    log(f"YOLO 检测到 {len(ui_items)} 个 UI 元素（阈值={BOX_THRESHOLD}）")

    ui_with_text, unassigned = assign_text_to_ui(ocr_items, ui_items)

    # 过滤空 + 低置信度的 UI 误检：text 为空且 confidence < 阈值直接丢弃
    before = len(ui_with_text)
    kept: list[dict[str, Any]] = []
    dropped = 0
    for item in ui_with_text:
        if not item.get("text") and item.get("confidence", 0.0) < min_ui_confidence:
            dropped += 1
            continue
        kept.append(item)
    ui_with_text = kept
    if dropped:
        log(f"过滤 {dropped}/{before} 个空+低置信（<{min_ui_confidence}）UI 误检")

    # 合并所有元素：UI 元素 + 未匹配的 OCR 段落
    all_items = ui_with_text + unassigned

    # 排序：从上到下、从左到右
    def sort_key(item: dict[str, Any]) -> tuple[int, int]:
        bbox = item.get("bbox")
        if bbox:
            return (bbox[1], bbox[0])
        return (0, 0)

    all_items.sort(key=sort_key)

    # --- 布局分析：注入通用结构线索 ---
    # 聚类
    groups = _cluster_items(all_items)
    # 每个 item 所属的 cluster
    item_cluster: dict[int, int] = {}
    for cid, indices in enumerate(groups):
        for idx in indices:
            item_cluster[idx] = cid
    cluster_geoms: dict[int, dict[str, Any]] = {}
    for cid, indices in enumerate(groups):
        c_bbox = _cluster_bbox(indices, all_items)
        cluster_geoms[cid] = compute_geometry(c_bbox, img_w, img_h)

    # 为每个 item 注入线索
    for idx, item in enumerate(all_items):
        cid = item_cluster.get(idx)
        item["geometry"] = compute_geometry(item.get("bbox", [0, 0, 0, 0]), img_w, img_h)
        if cid is not None:
            cg = cluster_geoms[cid]
            item["cluster"] = {
                "id": cid,
                "size": len(groups[cid]),
                "arrangement": _arrangement(groups[cid], all_items),
                "region": cg["region"],
            }
        else:
            item["cluster"] = {"id": -1, "size": 1, "arrangement": "single", "region": "unknown"}

    # 页面级布局
    layout = detect_layout(all_items, img_w, img_h)

    # 生成全文
    text_parts: list[str] = []
    for item in all_items:
        if item.get("text"):
            text_parts.append(item["text"])
        else:
            text_parts.append("[ui_element]")

    text = "\n".join(text_parts)
    model_name = f"{YOLO_MODEL_DISPLAY} + {PPOCR_MODEL_DISPLAY}"
    return text, all_items, model_name, layout


# ---------------------------------------------------------------------------
# VLM 引擎（Qwen2.5-VL，transformers）
# ---------------------------------------------------------------------------
_vlm_model: Any = None
_vlm_processor: Any = None


def load_vlm() -> tuple[Any, Any]:
    """加载 Qwen2.5-VL 模型与处理器。

    优先使用本地 VLM_DIR 权重；自动检测 CUDA/MPS 设备。
    """
    global _vlm_model, _vlm_processor
    if _vlm_model is not None and _vlm_processor is not None:
        return _vlm_model, _vlm_processor

    try:
        import torch  # type: ignore[import-untyped]
        from transformers import (  # type: ignore[import-untyped]
            AutoProcessor,
            Qwen2_5_VLForConditionalGeneration,
        )
    except ImportError as exc:
        emit_error("MODEL_RUNTIME_MISSING", f"transformers 未安装或无法导入：{exc}")
        sys.exit(1)

    device = get_device()
    if device.startswith("cuda"):
        torch_dtype = torch.bfloat16
    else:
        torch_dtype = torch.float32

    kw: dict[str, Any] = {
        "torch_dtype": torch_dtype,
        "device_map": "auto",
    }
    # AWQ 权重：本地目录含量化权重时由 transformers 自动识别
    log(f"加载 {VLM_MODEL_DISPLAY}（device={device}）…")
    try:
        _vlm_processor = AutoProcessor.from_pretrained(str(VLM_DIR))
        _vlm_model = Qwen2_5_VLForConditionalGeneration.from_pretrained(str(VLM_DIR), **kw)
    except Exception as exc:
        emit_error("MODEL_INITIALIZATION_FAILED", f"VLM 初始化失败：{exc}")
        sys.exit(1)
    return _vlm_model, _vlm_processor


def release_vlm() -> None:
    """释放 VLM 模型的 GPU/CPU 资源，供 mix 模式顺序执行时释放显存。"""
    global _vlm_model, _vlm_processor
    if _vlm_model is not None:
        try:
            import torch
            _vlm_model.to("cpu")
            del _vlm_model
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
    _vlm_model = None
    _vlm_processor = None


def _parse_vlm_json(text: str) -> dict[str, Any]:
    """从 VLM 回答中解析结构化 JSON；失败回退到 raw 文本。"""
    text = text.strip()
    # 去掉可能的 markdown 代码块围栏
    if text.startswith("```"):
        text = re.sub(r"^```\w*\n|```$", "", text).strip()
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    # 尝试截取第一个 { 到最后一个 } 之间的 JSON
    try:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            data = json.loads(text[start:end + 1])
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {"raw": text}


def run_vlm(
    image_path: str,
    prompt: str,
    ocr_context: str | None = None,
    web_mode: bool = False,
) -> dict[str, Any]:
    """运行 VLM 推理，返回结构化 JSON。

    - web_mode 时额外叠加 YOLO UI 坐标参考。
    - ocr_context 非空时（mix 模式）注入 OCR 文字结果。
    """
    from transformers import TextInput  # noqa: F401  (生成参数类型)

    model, processor = load_vlm()

    # 组装消息
    content: list[dict[str, Any]] = [{"type": "image", "image": image_path}]
    if web_mode:
        ui_items = run_yolo_detection(image_path)
        if ui_items:
            coords = [
                {"bbox": it["bbox"], "confidence": round(it.get("confidence", 0), 3)}
                for it in ui_items
            ]
            content.append({
                "type": "text",
                "text": f"以下是 YOLO 检测到的 UI 元素坐标（参考用）：{json.dumps(coords, ensure_ascii=False)}",
            })

    full_prompt = prompt
    if ocr_context:
        full_prompt = (
            f"{ocr_context}\n\n{prompt}\n\n{VLM_JSON_INSTRUCTION}"
        )
    elif web_mode:
        full_prompt = f"{prompt}\n\n{VLM_JSON_INSTRUCTION}"
    else:
        full_prompt = f"{prompt}\n\n{VLM_JSON_INSTRUCTION}"

    content.append({"type": "text", "text": full_prompt})
    messages = [{"role": "user", "content": content}]

    try:
        text_input = processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = processor(text=[text_input], images=[image_path], return_tensors="pt")
    except Exception as exc:
        emit_error("MODEL_RECOGNITION_FAILED", f"VLM 输入处理失败：{exc}")
        sys.exit(1)

    device = get_device()
    inputs = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in inputs.items()}

    try:
        import torch
        with torch.inference_mode():
            generated_ids = model.generate(
                **inputs,
                max_new_tokens=1024,
                do_sample=False,
                temperature=None,
                top_p=None,
            )
        generated_ids = generated_ids[:, inputs["input_ids"].shape[1]:]
        response = processor.batch_decode(
            generated_ids, skip_special_tokens=True, clean_up_tokenization_spaces=False
        )[0]
    except Exception as exc:
        emit_error("MODEL_RECOGNITION_FAILED", f"VLM 推理失败：{exc}")
        sys.exit(1)

    parsed = _parse_vlm_json(response)
    raw = parsed.get("raw") or response
    summary = parsed.get("summary") or raw
    intent = parsed.get("intent") or ""
    elements = parsed.get("elements")
    if not isinstance(elements, list):
        elements = []

    return {
        "text": summary,
        "raw": raw,
        "intent": intent,
        "summary": summary,
        "elements": elements,
        "engine": "qwen2.5-vl-7b",
        "mode": "vlm",
    }


def run_inference(
    image_path: str,
    ocr_engine: str,
    web_mode: bool,
    min_ui_confidence: float,
    mode: str = "ocr",
    prompt: str | None = None,
) -> None:
    if mode in ("vlm", "mix"):
        run_vlm_inference(image_path, web_mode, prompt, mode)
        return

    # ---- OCR 模式（现有逻辑）----
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
        text, items, _model_name, layout = merge_web_results(image_path, ocr_items, min_ui_confidence)
    else:
        items = ocr_items
        layout = None

    # 移除对 AI 无意义的字段
    for item in items:
        item.pop("confidence", None)
        item.pop("source", None)

    payload: dict[str, Any] = {
        "text": text,
        "items": items,
        "mode": "ocr",
    }
    if layout:
        payload["layout"] = layout
    emit(payload)


def run_vlm_inference(image_path: str, web_mode: bool, prompt: str | None, mode: str) -> None:
    """VLM / mix 模式入口。

    - vlm：纯 VLM，直接看原图（可选 YOLO 坐标）。
    - mix：顺序执行 —— 先 OCR，释放 OCR 资源后，再加载 VLM 并注入 OCR 结果。
    """
    ocr_context: str | None = None
    if mode == "mix":
        try:
            text, ocr_items = run_ppocr(image_path)
        except Exception as exc:
            emit_error("MODEL_INITIALIZATION_FAILED", f"OCR 阶段失败：{exc}")
            sys.exit(1)
        # 释放 OCR 资源，避免与 VLM 争用
        release_ocr()
        if ocr_items:
            lines = [
                f"{it.get('text', '')} {('bbox=' + str(it['bbox'])) if 'bbox' in it else ''}".rstrip()
                for it in ocr_items
                if it.get("text")
            ]
            ocr_context = "OCR 识别结果（文字与坐标，可能不完整）：\n" + "\n".join(lines)
        prompt = prompt or MIX_DEFAULT_PROMPT
    else:
        prompt = prompt or VLM_DEFAULT_PROMPT

    result = run_vlm(image_path, prompt, ocr_context, web_mode)
    emit(result)


def release_ocr() -> None:
    """释放 OCR 引擎（RapidOCR/YOLO）占用的资源。"""
    global _ppocr_engine, _yolo_model
    _ppocr_engine = None
    _yolo_model = None
    try:
        import gc
        gc.collect()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 自检 / 主入口
# ---------------------------------------------------------------------------
def self_test(compute: str = "both") -> bool:
    import traceback
    missing = verify_model_integrity(compute)
    if missing:
        log("模型文件不完整，缺失：")
        for item in missing:
            log(f"  - {item}")
        return False
    want_ocr = compute in ("ocr", "both")
    want_vlm = compute in ("vlm", "both")
    if want_ocr:
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
    if want_vlm:
        try:
            load_vlm()
        except Exception as exc:
            log(f"VLM 自检失败：{exc}")
            log(traceback.format_exc())
            return False
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="vcli 视觉推理（PP-OCRv6 + YOLO + Qwen2.5-VL）")
    parser.add_argument("--init", action="store_true", help="下载全部模型")
    parser.add_argument("--compute", choices=["ocr", "vlm", "both"], default="both",
                        help="init/self-test 涉及的模型范围（默认 both）")
    parser.add_argument("--quant", choices=["bf16", "awq"], default="bf16",
                        help="VLM 量化版本（默认 bf16）")
    parser.add_argument("--self-test", action="store_true", help="验证模型可加载")
    parser.add_argument("--image", help="图片文件路径")
    parser.add_argument("--mode", choices=["ocr", "vlm", "mix"], default="ocr",
                        help="识别模式（默认 ocr）")
    parser.add_argument("--prompt", help="VLM/mix 模式的自定义问题（默认有内置模板）")
    parser.add_argument("--ocr", choices=["ppocrv6"], default="ppocrv6", help="OCR 引擎（默认 ppocrv6）")
    parser.add_argument("--web", action="store_true", help="启用 YOLO UI 元素检测（网页/UI 场景）")
    parser.add_argument(
        "--min-confidence",
        type=float,
        default=DEFAULT_MIN_UI_CONFIDENCE,
        help=f"空 UI 元素保留阈值（默认 {DEFAULT_MIN_UI_CONFIDENCE}，仅 --web 生效）",
    )
    args = parser.parse_args()

    if args.init:
        try:
            download_all_models(args.compute, args.quant)
        except Exception as exc:
            emit_error("MODEL_INITIALIZATION_FAILED", f"模型下载失败：{exc}")
            sys.exit(1)
        emit({"ok": True})
        sys.exit(0)

    if args.self_test:
        ok = self_test(args.compute)
        emit({"ok": ok})
        sys.exit(0 if ok else 1)

    if not args.image:
        emit_error("IMAGE_READ_ERROR", "未指定图片路径")
        sys.exit(1)

    if not os.path.isfile(args.image):
        emit_error("IMAGE_READ_ERROR", f"图片不存在：{args.image}")
        sys.exit(1)

    # 按模式决定需要校验的模型范围
    compute = "both"
    if args.mode == "ocr":
        compute = "ocr"
    elif args.mode == "vlm":
        compute = "vlm"
    ensure_models_ready(compute)
    run_inference(args.image, args.ocr, args.web, args.min_confidence, args.mode, args.prompt)


if __name__ == "__main__":
    main()
