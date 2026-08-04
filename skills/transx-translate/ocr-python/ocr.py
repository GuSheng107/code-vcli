#!/usr/bin/env python3
"""TransX OCR Python 脚本 — Skills 模式使用

使用 RapidOCR (PP-OCRv6) 进行本地离线 OCR。
接受图片路径，输出 JSON 格式的识别结果。
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


SKILL_ROOT = Path(__file__).resolve().parent.parent
VENV_DIR = SKILL_ROOT / ".venv-ocr"
PREVIEW_MAX_CHARS = 2_000


def ensure_venv() -> None:
    """若不在 .venv-ocr 中运行且该环境存在，则用其 Python 重新执行本脚本。"""
    venv_python = VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    try:
        if Path(sys.executable).resolve() == venv_python.resolve():
            return
    except OSError:
        return
    if not venv_python.exists():
        return
    os.execv(str(venv_python), [str(venv_python), *sys.argv])


def load_engine() -> Any:
    """加载已锁定的 RapidOCR 及 OpenVINO 推理引擎。"""
    try:
        from rapidocr import RapidOCR  # type: ignore[import-untyped]
        from rapidocr.utils.typings import EngineType  # type: ignore[import-untyped]
    except ImportError as exc:
        print(json.dumps({
            "ok": False,
            "error": {
                "code": "OCR_RUNTIME_MISSING",
                "message": f"RapidOCR 未安装或无法导入：{exc}",
            },
        }, ensure_ascii=False))
        sys.exit(1)

    try:
        engine = EngineType.OPENVINO
        return RapidOCR(params={
            "Det.engine_type": engine,
            "Cls.engine_type": engine,
            "Rec.engine_type": engine,
        })
    except ImportError as exc:
        print(json.dumps({
            "ok": False,
            "error": {
                "code": "OCR_RUNTIME_MISSING",
                "message": f"OCR 推理引擎不可用：{exc}",
            },
        }, ensure_ascii=False))
        sys.exit(1)
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "error": {
                "code": "OCR_INITIALIZATION_FAILED",
                "message": f"OCR 初始化失败：{exc}",
            },
        }, ensure_ascii=False))
        sys.exit(1)


def run_ocr(engine: Any, image_path: str) -> list[dict[str, Any]]:
    """执行 OCR 并返回文本区域。"""
    result = engine(image_path)
    boxes = result.boxes if result.boxes is not None else []
    txts = result.txts if result.txts is not None else []
    scores = result.scores if result.scores is not None else []
    items: list[dict[str, Any]] = []
    for index, text in enumerate(txts):
        if not text:
            continue
        item: dict[str, Any] = {"text": text}
        if index < len(scores) and scores[index] is not None:
            item["confidence"] = float(scores[index])
        if index < len(boxes) and boxes[index] is not None:
            item["box"] = [[int(point[0]), int(point[1])] for point in boxes[index]]
        items.append(item)
    return items


def self_test() -> bool:
    """自检：生成测试图片并执行 OCR，验证引擎和模型可用。"""
    try:
        from PIL import Image, ImageDraw, ImageFont  # type: ignore[import-untyped]
    except ImportError:
        print(json.dumps({
            "ok": False,
            "error": {"code": "OCR_RUNTIME_MISSING", "message": "Pillow 未安装"},
        }, ensure_ascii=False))
        return False

    engine = load_engine()

    # 生成一张包含简单文字的测试图片
    img = Image.new("RGB", (200, 60), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 24)
    except (OSError, IOError):
        font = ImageFont.load_default()
    draw.text((10, 15), "Hello Test", fill=(0, 0, 0), font=font)

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        img.save(tmp, format="PNG")
        tmp_path = tmp.name

    try:
        items = run_ocr(engine, tmp_path)
        return len(items) > 0
    except Exception:
        return False
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def write_intermediate(image_path: str, items: list[dict[str, Any]]) -> Path:
    source = Path(image_path).resolve()
    output_path: Path | None = None
    for suffix in range(1000):
        index = "" if suffix == 0 else f".{suffix}"
        candidate = source.with_name(f"{source.stem}_OCR{index}.md")
        if not candidate.exists():
            output_path = candidate
            break
    if output_path is None:
        raise OSError("无法为 OCR 识别结果分配中间文件")

    lines = [
        "## 图片",
        "",
        '<!-- {"sourceIndex":1,"kind":"image"} -->',
        "",
    ]
    for item in items:
        metadata = {
            key: item[key]
            for key in ("confidence", "box")
            if key in item
        }
        if metadata:
            lines.append(f"<!-- {json.dumps(metadata, ensure_ascii=False, separators=(',', ':'))} -->")
        lines.extend([str(item["text"]), ""])
    output_path.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    return output_path


def main() -> None:
    ensure_venv()
    parser = argparse.ArgumentParser(description="TransX OCR 图片文字识别")
    parser.add_argument("--image", help="图片文件路径")
    parser.add_argument("--save", action="store_true", help="保存可查看、可翻译的 OCR 中间文件")
    parser.add_argument("--self-test", action="store_true", help="执行自检")
    args = parser.parse_args()

    if args.self_test:
        ok = self_test()
        print(json.dumps({"ok": ok}, ensure_ascii=False))
        sys.exit(0 if ok else 1)

    if not args.image:
        print(json.dumps({
            "ok": False,
            "error": {"code": "IMAGE_READ_ERROR", "message": "未指定图片路径"},
        }, ensure_ascii=False))
        sys.exit(1)

    image_path = args.image
    if not os.path.isfile(image_path):
        print(json.dumps({
            "ok": False,
            "error": {"code": "IMAGE_READ_ERROR", "message": f"图片不存在：{image_path}"},
        }, ensure_ascii=False))
        sys.exit(1)

    engine = load_engine()

    try:
        items = run_ocr(engine, image_path)
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "error": {"code": "OCR_RECOGNITION_FAILED", "message": str(exc)},
        }, ensure_ascii=False))
        sys.exit(1)

    if not items:
        print(json.dumps({
            "ok": False,
            "error": {"code": "OCR_TEXT_EMPTY", "message": "未识别到文字"},
        }, ensure_ascii=False))
        sys.exit(1)

    texts = [item["text"] for item in items]
    source_text = "\n".join(texts)
    if args.save:
        try:
            output_path = write_intermediate(image_path, items)
        except OSError as exc:
            print(json.dumps({
                "ok": False,
                "error": {"code": "FILE_WRITE_ERROR", "message": str(exc)},
            }, ensure_ascii=False))
            sys.exit(1)
        preview = source_text[:PREVIEW_MAX_CHARS]
        truncated = len(source_text) > PREVIEW_MAX_CHARS
        print(json.dumps({
            "ok": True,
            "data": {
                "recognition_file": str(output_path),
                "preview": f"{preview}\n…" if truncated else preview,
                "preview_truncated": truncated,
                "source_count": 1,
                "item_count": len(items),
                "ocr": {
                    "engine": "rapidocr-openvino",
                    "model": "PP-OCRv6 Quality",
                    "local": True,
                    "source_type": "image",
                },
            },
        }, ensure_ascii=False))
        return
    print(json.dumps({
        "ok": True,
        "text": source_text,
        "items": items,
        "engine": "rapidocr-openvino",
        "model": "PP-OCRv6 Quality",
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
