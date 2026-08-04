---
name: transx-translate
description: "Translate text and local files through DLX, or locally recognize text in images and images inside PDF, DOCX, PPTX, and Markdown before confirmed translation."
---

# TransX Node.js script

Use only `scripts/translate.mjs`. Add `--json`.

```text
node <skill-dir>/scripts/translate.mjs translate "Hello world" --to ZH --source auto --json
node <skill-dir>/scripts/translate.mjs translate --file ./paper.pdf --to ZH --source auto --json
```

For OCR, run the local bridge first:

```text
node <skill-dir>/ocr-node/ocr.mjs recognize ./screenshot.png --json
node <skill-dir>/ocr-node/ocr.mjs recognize ./scan.pdf --json
node <skill-dir>/ocr-node/ocr.mjs recognize ./report.docx --json
```

Install fixed dependencies when `node_modules` is missing:

```text
npm ci --omit=dev --prefix "<skill-dir>"
```

Direct text is limited to 1500 characters. Files are limited to 20MB, 100000 translatable characters, and 500 requests. OCR inputs are limited to 20MB and 40 million pixels per image or PDF page; PDFs are limited to 100 pages.

File translation writes `<name>_<TARGET>.<ext>` beside the source. PDF writes DOCX. Report `output_file`; return `data` only when `fallback` is true. Use `--output` only when the user provides a path.

OCR requires Python 3.10+ and the OCR extension (`.venv-ocr`). It accepts images, PDF, DOCX, PPTX, and Markdown. Remote Markdown images are skipped. Model: PP-OCRv6 Quality with RapidOCR + OpenVINO.

The OCR bridge creates `recognition_file` beside the source. Show its preview and path, let the user review the full text, then ask whether to translate it. Only after explicit confirmation, run `scripts/translate.mjs translate --file <recognition_file> --to <lang> --source auto --json`. This keeps the concurrent file translation flow. The recognition file preserves source labels, page or slide metadata, boxes, and confidence when present. Never send recognized text before confirmation.

Run `node <skill-dir>/scripts/translate.mjs init` when configuration is missing. Get the DLX API Key from https://connect.linux.do/. History is stored in `~/.transx/history/`.

Never expose the API key. Send only requested content to the service.

To switch modes, read `assets/SKILL.original.md`, run `node <skill-dir>/scripts/configure-skill.mjs reset`, and follow the restored setup. Do not delete scripts or uninstall the CLI.
