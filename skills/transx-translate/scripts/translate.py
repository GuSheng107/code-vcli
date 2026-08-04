#!/usr/bin/env python3
"""Standalone DLX translator."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import getpass
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from typing import NoReturn
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from history import append_history
from file_document import (
    FileDocumentError,
    prepare_file_translation,
    translated_text,
    write_translated_file,
)


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


CONFIG_PATH = Path.home() / ".transx" / "credentials.json"
ENDPOINT = "https://api.deeplx.org/{key}/translate"
RETRIES = 2
USER_AGENT = "Mozilla/5.0 (compatible; TransX; +https://github.com/GuSheng107/transx-cli)"

TRANSLATION_TEXT_MAX_CHARS = 1_500
FILE_REQUEST_DELAY_SECONDS = 0.2
FILE_TRANSLATION_CONCURRENCY = 5


class TranslationError(Exception):
    def __init__(self, code: str, message: str, exit_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def fail(code: str, message: str, exit_code: int) -> NoReturn:
    raise TranslationError(code, message, exit_code)


def json_line(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def write_credentials(api_key: str) -> None:
    normalized = api_key.strip()
    if not normalized:
        fail("CONFIG_INVALID", "API Key 不能为空", 3)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".credentials.", dir=CONFIG_PATH.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump({"version": 1, "apiKey": normalized}, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        if os.name != "nt":
            os.chmod(temporary, 0o600)
        os.replace(temporary, CONFIG_PATH)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def resolve_api_key() -> str:
    environment_key = os.environ.get("DLX_API_KEY", "").strip()
    if environment_key:
        return environment_key
    try:
        stored = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail("CONFIG_NOT_INITIALIZED", "缺少 DLX API Key，请先运行 translate.py init。获取：https://connect.linux.do/", 3)
    except (OSError, json.JSONDecodeError) as error:
        fail("CONFIG_INVALID", f"无法读取本地配置：{error}", 3)
    api_key = stored.get("apiKey") if isinstance(stored, dict) else None
    if not isinstance(api_key, str) or not api_key.strip():
        fail("CONFIG_INVALID", "本地配置缺少有效 API Key", 3)
    return api_key.strip()


def request_translation(
    text: str,
    target: str,
    source: str,
    timeout: float,
) -> dict[str, object]:
    if not text.strip():
        fail("INVALID_ARGUMENT", "待翻译文本不能为空", 2)
    if len(text) > TRANSLATION_TEXT_MAX_CHARS:
        fail(
            "INVALID_ARGUMENT",
            f"文本超过 DLX 单次上限 {TRANSLATION_TEXT_MAX_CHARS} 字符，请分段或分批翻译",
            2,
        )
    payload = {
        "text": text,
        "source_lang": source,
        "target_lang": target.upper(),
    }
    endpoint = ENDPOINT.format(key=quote(resolve_api_key(), safe=""))
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    for attempt in range(RETRIES + 1):
        request = Request(
            endpoint,
            data=encoded,
            headers={"content-type": "application/json", "user-agent": USER_AGENT},
            method="POST",
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                fail("API_RESPONSE_INVALID", "DLX 返回的不是有效 JSON", 6)
            if not isinstance(body, dict):
                fail("API_RESPONSE_INVALID", "DLX 返回的 JSON 结构无效", 6)
            if body.get("code") not in (None, 200):
                fail("API_HTTP_ERROR", str(body.get("message") or "DLX 返回业务错误"), 5)
            if not isinstance(body.get("data"), str):
                fail("API_RESPONSE_INVALID", "DLX 响应缺少字符串字段 data", 6)
            return {
                "ok": True,
                "data": body["data"],
                "source_lang": source,
                "target_lang": target.upper(),
                "provider": "dlx",
            }
        except HTTPError as error:
            if attempt < RETRIES and error.code >= 500:
                time.sleep(0.3 * (2**attempt))
                continue
            fail("API_HTTP_ERROR", f"DLX 请求失败，HTTP {error.code}", 5)
        except (URLError, TimeoutError) as error:
            if attempt < RETRIES:
                time.sleep(0.3 * (2**attempt))
                continue
            fail("NETWORK_ERROR", f"无法连接 DLX 服务：{error}", 4)
    fail("NETWORK_ERROR", "无法连接 DLX 服务", 4)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DLX translation client")
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="save the DLX API key")
    init.add_argument("--key-stdin", action="store_true", help="read API key from stdin")
    translate = commands.add_parser("translate", help="translate text")
    translate.add_argument("text", nargs="*", help="text; read stdin when omitted")
    translate.add_argument("-t", "--to", required=True, help="target language code")
    translate.add_argument("-s", "--source", default="auto", help="source language code")
    translate.add_argument("--timeout", type=float, default=20.0, help="timeout in seconds")
    translate.add_argument("--json", action="store_true", help="emit one-line JSON")
    translate.add_argument("-f", "--file", help="extract text from file (txt/md/csv/log/docx/xlsx/pptx/pdf)")
    translate.add_argument("-o", "--output", help="translated output file path")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "init":
        key = sys.stdin.read().rstrip("\r\n") if args.key_stdin else getpass.getpass("DLX API Key（获取：https://connect.linux.do/）：")
        write_credentials(key)
        print(json_line({"ok": True, "config": str(CONFIG_PATH)}))
        return 0

    if args.timeout <= 0:
        fail("INVALID_ARGUMENT", "--timeout 必须是正数秒", 2)
    if args.file and args.text:
        fail("INVALID_ARGUMENT", "--file 与位置文本不能同时使用", 2)
    if args.output and not args.file:
        fail("INVALID_ARGUMENT", "--output 只能与 --file 一起使用", 2)
    if args.file:
        prepared = prepare_file_translation(args.file)
        print(f"文件翻译速度较慢，共 {len(prepared.units)} 个请求", file=sys.stderr)
        translations = [""] * len(prepared.units)
        completed = 0
        for start in range(0, len(prepared.units), FILE_TRANSLATION_CONCURRENCY):
            indexes = range(start, min(start + FILE_TRANSLATION_CONCURRENCY, len(prepared.units)))
            with ThreadPoolExecutor(max_workers=FILE_TRANSLATION_CONCURRENCY) as executor:
                futures = {
                    executor.submit(request_translation, prepared.units[index], args.to, args.source, args.timeout): index
                    for index in indexes
                }
                for future in as_completed(futures):
                    index = futures[future]
                    translations[index] = str(future.result()["data"])
                    completed += 1
                    print(f"翻译进度 {completed}/{len(prepared.units)}", file=sys.stderr)
            if start + FILE_TRANSLATION_CONCURRENCY < len(prepared.units):
                time.sleep(FILE_REQUEST_DELAY_SECONDS)
        data = translated_text(prepared, translations)
        output_path, fallback = write_translated_file(prepared, translations, args.to.upper(), args.output)
        try:
            append_history(
                args.source,
                args.to.upper(),
                source_file_path=str(prepared.source_path),
                output_file_path=str(output_path) if output_path else None,
            )
        except Exception as error:
            print(f"历史记录写入失败：{error}", file=sys.stderr)
        response = {
            "ok": True,
            "data": data,
            "source_lang": args.source,
            "target_lang": args.to.upper(),
            "provider": "dlx",
            "output_file": str(output_path) if output_path else None,
            "output_format": prepared.output_extension.removeprefix("."),
            "fallback": fallback,
        }
        if args.json:
            print(json_line(response))
        elif output_path:
            print(f"译文已保存：{output_path}")
        else:
            print("无法写入译文文件，已返回文本", file=sys.stderr)
            print(data)
        return 0

    text = " ".join(args.text) if args.text else ("" if sys.stdin.isatty() else sys.stdin.read())
    result = request_translation(text, args.to, args.source, args.timeout)
    try:
        append_history(args.source, args.to.upper(), text, str(result["data"]))
    except Exception as error:  # Translation still succeeded; match CLI's non-fatal history behavior.
        print(f"历史记录写入失败：{error}", file=sys.stderr)
    print(json_line(result) if args.json else result["data"])
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (TranslationError, FileDocumentError) as error:
        payload = {"ok": False, "error": {"code": error.code, "message": str(error)}}
        print(json_line(payload), file=sys.stderr)
        raise SystemExit(error.exit_code)
