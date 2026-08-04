---
name: transx-translate
description: "Translate text, supported local files, or image text through DLX using one saved workflow: Python script, Node.js script, or TransX CLI. On first use, detect runtimes, ask once, install the selected workflow dependencies, optionally enable the OCR extension, configure the API key, and replace this file with the selected workflow."
---

# TransX Translate

## First use

Resolve `<skill-dir>` from this file. Never expose the API key.
Get the DLX API Key from https://connect.linux.do/.

1. Detect Python 3, Node.js, `npx`, and `transx`; record the Node.js version.
2. Reuse a valid choice from `~/.transx/skill-preference.json`.
3. If neither Python nor Node.js exists, ask the user to install Python 3 and then select Python.
4. Otherwise ask once: Python script, Node.js script (recommended for OCR files), or TransX CLI.
5. The configure script then asks whether to enable OCR. It requires Python 3.10+ and downloads about 180 MB. Node.js and CLI modes recognize standalone images and images inside PDF, DOCX, PPTX, and Markdown. Python mode recognizes standalone images only. OCR writes a reviewable intermediate file and sends it to translation only after confirmation.

### Python script

```text
python -m pip install -r "<skill-dir>/requirements.txt"
python <skill-dir>/scripts/translate.py init
python <skill-dir>/scripts/configure_skill.py script
```

### Node.js script

Requires Node.js 18 or newer.

```text
npm ci --omit=dev --prefix "<skill-dir>"
node <skill-dir>/scripts/translate.mjs init
node <skill-dir>/scripts/configure-skill.mjs script
```

### TransX CLI

Requires Node.js 22 or newer and `npm`.

```text
npm i @gushengcode/transx-cli
transx init
node <skill-dir>/scripts/configure-skill.mjs cli
```

Re-read the replaced `SKILL.md` and continue the translation.

All modes use `~/.transx/credentials.json` and `~/.transx/history/`. Changing modes only replaces `SKILL.md` and the preference file.
