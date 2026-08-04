---
name: transx-translate
description: "Translate text, supported local files, or image text through DLX with the bundled Python script. Use for inline text, stdin, txt, md, csv, log, docx, xlsx, pptx, pdf, or image (png/jpg/webp/bmp/tiff) translation."
---

# TransX Python script

Use only `scripts/translate.py`. Add `--json`.

```text
python <skill-dir>/scripts/translate.py translate "Hello world" --to ZH --source auto --json
python <skill-dir>/scripts/translate.py translate --file ./paper.pdf --to ZH --source auto --json
```

For image OCR, run the local script first:

```text
python <skill-dir>/ocr-python/ocr.py --image ./screenshot.png --save
```

Install the fixed PDF dependency when it is missing:

```text
python -m pip install -r "<skill-dir>/requirements.txt"
```

Direct text is limited to 1500 characters. Files are limited to 20MB, 100000 translatable characters, and 500 requests. Images are limited to 20MB and 40 million pixels.

File translation writes `<name>_<TARGET>.<ext>` beside the source. PDF writes DOCX. Report `output_file`; return `data` only when `fallback` is true. Use `--output` only when the user provides a path.

Image OCR requires Python 3.10+ and the OCR extension (`.venv-ocr`). This mode recognizes standalone images only. Use Node.js or CLI mode for PDF, DOCX, PPTX, and Markdown images.

`--save` creates `recognition_file` beside the image. Show its preview and path, let the user review the full text, then ask whether to translate it. Only after explicit confirmation, run `scripts/translate.py translate --file <recognition_file> --to <lang> --source auto --json`. The recognition file preserves boxes and confidence when present. Never send recognized text before confirmation.

Run `python <skill-dir>/scripts/translate.py init` when configuration is missing. Get the DLX API Key from https://connect.linux.do/. History is stored in `~/.transx/history/`.

Never expose the API key. Send only requested content to the service.

To switch modes, read `assets/SKILL.original.md`, run `python <skill-dir>/scripts/configure_skill.py reset`, and follow the restored setup. Do not delete scripts or uninstall the CLI.
