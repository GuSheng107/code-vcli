#!/usr/bin/env python3
"""Persist the TransX workflow and replace SKILL.md with its focused version."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


SKILL_ROOT = Path(__file__).resolve().parent.parent
ASSETS = SKILL_ROOT / "assets"
PREFERENCE = Path.home() / ".transx" / "skill-preference.json"
VENV_DIR = SKILL_ROOT / ".venv-ocr"
OCR_PYTHON_SCRIPT = SKILL_ROOT / "ocr-python" / "ocr.py"
OCR_REQUIREMENTS = SKILL_ROOT / "ocr-python" / "requirements-ocr.txt"
PYTHON_MIN_VERSION = (3, 10)
OCR_ENGINE = "rapidocr-openvino"
OCR_DOWNLOAD_SIZE_ESTIMATE = "约 180 MB"


def write_json_atomic(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        if os.name != "nt":
            os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def replace_skill(template_name: str) -> None:
    source = ASSETS / template_name
    target = SKILL_ROOT / "SKILL.md"
    temporary = target.with_name(f".{target.name}.tmp")
    shutil.copyfile(source, temporary)
    os.replace(temporary, target)


def check_python_available() -> str | None:
    candidates = ["python3", "python"] if os.name != "nt" else ["python", "python3", "py"]
    for candidate in candidates:
        try:
            args = ["-3", "--version"] if candidate == "py" else ["--version"]
            result = subprocess.run(
                [candidate, *args],
                capture_output=True,
                text=True,
                shell=(os.name == "nt"),
            )
            output = (result.stdout or result.stderr).strip()
            import re
            match = re.search(r"Python (\d+)\.(\d+)\.(\d+)", output)
            if not match:
                continue
            major, minor = int(match.group(1)), int(match.group(2))
            if (major, minor) < PYTHON_MIN_VERSION:
                continue
            return candidate
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def get_venv_python() -> Path:
    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def create_venv(python_path: str) -> None:
    subprocess.run(
        [python_path, "-m", "venv", str(VENV_DIR)],
        check=True,
        capture_output=True,
    )


def install_requirements(venv_python: Path) -> None:
    subprocess.run(
        [str(venv_python), "-m", "pip", "install",
         "--disable-pip-version-check", "--no-input",
         "-r", str(OCR_REQUIREMENTS)],
        check=True,
        timeout=600,
    )


def run_ocr_self_test(venv_python: Path) -> bool:
    try:
        result = subprocess.run(
            [str(venv_python), str(OCR_PYTHON_SCRIPT), "--self-test"],
            capture_output=True,
            text=True,
            timeout=600,
        )
        output = (result.stdout or result.stderr).strip()
        if not output:
            return False
        parsed = json.loads(output)
        return parsed.get("ok") is True
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return False


def install_ocr() -> bool:
    python_path = check_python_available()
    if not python_path:
        print(f"未找到 Python {PYTHON_MIN_VERSION[0]}.{PYTHON_MIN_VERSION[1]}+ 环境。"
              "图片识别翻译扩展需要 Python，已跳过。", file=sys.stderr)
        return False

    print("正在创建 OCR 虚拟环境…", file=sys.stderr)
    create_venv(python_path)

    venv_python = get_venv_python()
    print("正在安装 RapidOCR 依赖（首次可能需要数分钟）…", file=sys.stderr)
    install_requirements(venv_python)

    print("正在执行 OCR 自检…", file=sys.stderr)
    ok = run_ocr_self_test(venv_python)
    if not ok:
        print("OCR 自检失败，图片识别翻译扩展未启用。", file=sys.stderr)
        shutil.rmtree(VENV_DIR, ignore_errors=True)
        return False
    return True


def remove_ocr() -> None:
    shutil.rmtree(VENV_DIR, ignore_errors=True)


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"cli", "script", "reset"}:
        print("usage: configure_skill.py <cli|script|reset>", file=sys.stderr)
        return 2

    mode = sys.argv[1]
    if mode == "reset":
        PREFERENCE.unlink(missing_ok=True)
        replace_skill("SKILL.original.md")
        remove_ocr()
        print(json.dumps({"ok": True, "configured": False}, ensure_ascii=False))
        return 0

    # 询问是否启用 OCR
    print("\n是否启用图片识别翻译扩展？", file=sys.stderr)
    print("- 使用 PP-OCRv6 Quality 本地识别", file=sys.stderr)
    print("- 图片不会上传", file=sys.stderr)
    print("- 确认后才发送识别文字", file=sys.stderr)
    print(f"- 需要 Python {PYTHON_MIN_VERSION[0]}.{PYTHON_MIN_VERSION[1]}+ 环境和"
          f"{OCR_DOWNLOAD_SIZE_ESTIMATE}下载", file=sys.stderr)
    print("\n是否下载并开启？ [y/n] ", end="", file=sys.stderr, flush=True)

    answer = input().strip().lower()
    while answer not in ("y", "n"):
        print("是否下载并开启？ [y/n] ", end="", file=sys.stderr, flush=True)
        answer = input().strip().lower()
    enable_ocr = answer == "y"

    ocr_enabled = False
    if enable_ocr:
        try:
            ocr_enabled = install_ocr()
        except Exception as exc:
            print(f"OCR 安装失败：{exc}\n图片识别翻译扩展未启用。", file=sys.stderr)
            remove_ocr()
            ocr_enabled = False
    else:
        print("已跳过图片识别翻译扩展。未来可重新运行配置以启用。", file=sys.stderr)

    runtime = None if mode == "cli" else "python"
    write_json_atomic(
        PREFERENCE,
        {
            "version": 1,
            "mode": mode,
            "runtime": runtime,
            "ocr_enabled": ocr_enabled,
            "ocr_engine": OCR_ENGINE if ocr_enabled else None,
            "ocr_model": "ppocr-v6-small" if ocr_enabled else None,
            "ocr_model_display": "PP-OCRv6 Quality" if ocr_enabled else None,
            "ocr_feature_version": "1" if ocr_enabled else None,
        },
    )
    replace_skill("SKILL.cli.md" if mode == "cli" else "SKILL.python.md")
    print(json.dumps({"ok": True, "mode": mode, "runtime": runtime, "ocr_enabled": ocr_enabled}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
