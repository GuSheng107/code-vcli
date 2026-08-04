---
name: transx-translate
description: "Translate text and local files through DLX, or locally recognize text in images and images inside PDF, DOCX, PPTX, and Markdown before confirmed translation."
---

# TransX CLI

Use only `transx`. Add `--json`.

```text
transx translate "Hello world" --to ZH --source auto --json
transx translate --file ./paper.pdf --to ZH --source auto --json
```

Use `auto` unless the source language is specified. Infer the target language when clear.

Direct text is limited to 1500 characters. Files are limited to 20MB, 100000 translatable characters, and 500 requests. OCR inputs are limited to 20MB and 40 million pixels per image or PDF page; PDFs are limited to 100 pages.

File translation writes `<name>_<TARGET>.<ext>` beside the source. PDF writes DOCX. Report `output_file`; return `data` only when `fallback` is true. Use `--output` only when the user provides a path.

OCR requires Python 3.10+ and `transx ocr enable`. It accepts images, PDF, DOCX, PPTX, and Markdown. Remote Markdown images are skipped. Model: PP-OCRv6 Quality with RapidOCR + OpenVINO.

For OCR translation, follow this order:

1. Run `transx ocr recognize <path> --json`. This is local, does not call DLX, and creates `recognition_file` beside the source.
2. Show the preview and `recognition_file`. Let the user review the full recognized text in that file.
3. Ask whether to translate the recognition file.
4. Only after explicit confirmation, run `transx translate --file <recognition_file> --to <lang> --source auto --json`. This reuses the concurrent file translation flow. Do not call `transx translate --image` from the Skill.

The recognition file preserves source labels, page or slide metadata, boxes, and confidence when present. Never send recognized text before confirmation.

Run `transx init` when configuration is missing. Get the DLX API Key from https://connect.linux.do/. Translation history is stored in `~/.transx/history/`.

Never expose the API key. Send only requested content to the service.

To switch modes, read `assets/SKILL.original.md`, run `node <skill-dir>/scripts/configure-skill.mjs reset`, and follow the restored setup. Do not delete scripts or uninstall the CLI.
