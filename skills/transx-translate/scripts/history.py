"""Write translation history in the same format used by TransX CLI."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import tempfile
import time
import uuid


HISTORY_DIR = Path.home() / ".transx" / "history"
LOCK_PATH = HISTORY_DIR / ".lock"


def china_timestamp() -> str:
    current = datetime.now(timezone.utc) + timedelta(hours=8)
    return current.strftime("%Y-%m-%d %H:%M:%S.") + f"{current.microsecond // 1000:03d}"


def write_json_atomic(path: Path, value: object) -> None:
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


def acquire_lock() -> int:
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            return os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            try:
                if time.time() - LOCK_PATH.stat().st_mtime > 30:
                    LOCK_PATH.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                continue
            time.sleep(0.05)
    raise RuntimeError("翻译历史正在被其他进程使用，请稍后重试")


def rebuild_index(updated_at: str, last_warning_at: str | None) -> dict[str, object]:
    records: list[dict[str, object]] = []
    total_bytes = 0
    for file_path in sorted(HISTORY_DIR.glob("????-??-??.json")):
        raw = file_path.read_bytes()
        total_bytes += len(raw)
        parsed = json.loads(raw.decode("utf-8"))
        if isinstance(parsed, dict) and isinstance(parsed.get("records"), list):
            records.extend(parsed["records"])
    timestamps = sorted(
        record["createdAt"]
        for record in records
        if isinstance(record, dict) and isinstance(record.get("createdAt"), str)
    )
    return {
        "version": 1,
        "updatedAt": updated_at,
        "totalRecords": len(records),
        "totalBytes": total_bytes,
        "oldestAt": timestamps[0] if timestamps else None,
        "newestAt": timestamps[-1] if timestamps else None,
        "lastWarningAt": last_warning_at,
    }


def append_history(
    source_lang: str,
    target_lang: str,
    input_text: str | None = None,
    output_text: str | None = None,
    *,
    source_file_path: str | None = None,
    output_file_path: str | None = None,
) -> None:
    lock_fd = acquire_lock()
    try:
        created_at = china_timestamp()
        date = created_at[:10]
        daily_path = HISTORY_DIR / f"{date}.json"
        if daily_path.exists():
            daily = json.loads(daily_path.read_text(encoding="utf-8"))
            if not isinstance(daily, dict) or not isinstance(daily.get("records"), list):
                raise RuntimeError(f"翻译历史文件无效：{daily_path.name}")
        else:
            daily = {"version": 1, "date": date, "records": []}
        record: dict[str, object] = {
            "id": str(uuid.uuid4()),
            "createdAt": created_at,
            "sourceLang": source_lang,
            "targetLang": target_lang,
        }
        if source_file_path is not None:
            source_path = Path(source_file_path)
            output_path = Path(output_file_path) if output_file_path else None
            record.update(
                {
                    "format": "file",
                    "sourceFilePath": str(source_path),
                    "sourceFileName": source_path.name,
                    "outputFilePath": str(output_path) if output_path else None,
                    "outputFileName": output_path.name if output_path else None,
                }
            )
        else:
            record.update(
                {
                    "format": "plain",
                    "input": input_text or "",
                    "output": output_text or "",
                }
            )
        daily["records"].append(record)
        write_json_atomic(daily_path, daily)
        index_path = HISTORY_DIR / "index.json"
        last_warning_at = None
        if index_path.exists():
            try:
                previous = json.loads(index_path.read_text(encoding="utf-8"))
                last_warning_at = previous.get("lastWarningAt") if isinstance(previous, dict) else None
            except (OSError, json.JSONDecodeError):
                pass
        write_json_atomic(index_path, rebuild_index(created_at, last_warning_at))
    finally:
        os.close(lock_fd)
        LOCK_PATH.unlink(missing_ok=True)
