import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { strToU8, unzipSync, zipSync } from "fflate";

import { compareVersions, getPosixProfilePath } from "../dist/installer.js";
import { parseYesNo } from "../dist/input.js";
import { mapWithConcurrency } from "../dist/concurrent.js";
import { prepareFileTranslation } from "../dist/file-document.js";
import { buildOcrPreview, formatOcrIntermediate, writeOcrIntermediate } from "../dist/ocr/intermediate.js";
import { processRenderedPdfPages } from "../dist/ocr/pdf-renderer.js";
import { processVisualInputSources } from "../dist/ocr/visual-input.js";
import { getBinDirectory, getConfigRoot, getInstallRoot } from "../dist/paths.js";
import { formatIntermediate as formatSkillIntermediate } from "../skills/transx-translate/ocr-node/intermediate.mjs";
import { processVisualInputSources as processSkillVisualInputSources } from "../skills/transx-translate/ocr-node/visual-input.mjs";
import { buildInteractiveFrame, getInteractiveMenuItems } from "../dist/ui.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function execFileWithInput(file, args, input, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        reject(Object.assign(
          new Error(`process exited with code ${code}; stdout=${stdout}; stderr=${stderr}`),
          { code, stdout, stderr },
        ));
      }
    });
    child.stdin.end(input);
  });
}

test("package and lock file report version 1.0.7", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));

  assert.equal(packageJson.version, "1.0.7");
  assert.equal(packageLock.version, "1.0.7");
  assert.equal(packageLock.packages[""].version, "1.0.7");
});

test("installation paths and shell profiles are correct on Windows, macOS, and Linux", () => {
  const windowsEnv = {
    HOME: "C:\\Users\\demo",
    LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local",
  };
  const posixEnv = { HOME: "/home/demo" };

  assert.equal(getInstallRoot("win32", windowsEnv), "C:\\Users\\demo\\AppData\\Local\\.transx");
  assert.equal(getBinDirectory("win32", windowsEnv), "C:\\Users\\demo\\AppData\\Local\\.transx\\bin");
  assert.equal(getConfigRoot(posixEnv, "linux"), "/home/demo/.transx");
  assert.equal(getInstallRoot("linux", posixEnv), "/home/demo/.transx");
  assert.equal(getBinDirectory("darwin", { HOME: "/Users/demo" }), "/Users/demo/.transx/bin");

  assert.equal(getPosixProfilePath("darwin", "/bin/zsh", "/Users/demo"), "/Users/demo/.zshrc");
  assert.equal(getPosixProfilePath("darwin", "/bin/bash", "/Users/demo"), "/Users/demo/.bash_profile");
  assert.equal(getPosixProfilePath("linux", "/bin/bash", "/home/demo"), "/home/demo/.bashrc");
  assert.equal(getPosixProfilePath("linux", "/bin/sh", "/home/demo"), "/home/demo/.profile");
});

test("public installation docs use the native path lookup command on each platform", async () => {
  for (const file of ["README.md", "docs/index.html", "docs/docs.html"]) {
    const content = await readFile(path.join(root, file), "utf8");
    assert.match(content, /Windows[^\n<]*.*where transx/is, `${file} is missing the Windows command`);
    assert.match(content, /macOS\s*\/?\s*Linux[^\n<]*.*which transx/is, `${file} is missing the macOS/Linux command`);
  }
});

test("config view exposes the complete local API key", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "transx-config-test-"));
  const apiKey = "test-api-key-123456";
  try {
    const configDirectory = path.join(temporaryHome, ".transx");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, "credentials.json"),
      `${JSON.stringify({ version: 1, apiKey })}\n`,
      "utf8",
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(root, "dist", "cli.js"), "config"],
      {
        env: {
          ...process.env,
          HOME: temporaryHome,
          USERPROFILE: temporaryHome,
          DLX_API_KEY: "",
        },
        windowsHide: true,
      },
    );
    const output = JSON.parse(stdout);
    assert.equal(output.apiKey, apiKey);
    assert.match(stdout, new RegExp(apiKey));
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test("interactive menus are explicit about read-only configuration", () => {
  for (const ocrReady of [false, true]) {
    const configItem = getInteractiveMenuItems(true, ocrReady)
      .find((item) => item.value === "config");
    assert.equal(configItem?.label, "查看当前配置");
    assert.match(configItem?.description ?? "", /只读/);
  }
});

test("interactive menu always offers OCR installation until the feature is ready", () => {
  assert.ok(getInteractiveMenuItems(true, false).some((item) => item.value === "ocr_enable"));
  assert.ok(getInteractiveMenuItems(true, true).some((item) => item.value === "translate_image"));
});

test("interactive frame uses the concise CLI label and keeps its border complete", () => {
  const frame = buildInteractiveFrame({
    version: "1.0.7",
    initialized: true,
    items: getInteractiveMenuItems(true, false),
    selectedIndex: 0,
    color: false,
  });

  assert.match(frame, /└──────────────────────────────┘/);
  assert.match(frame, /可交互 CLI/);
  assert.doesNotMatch(frame, /数字键直达|↑↓ 选择/);
});

test("version comparison never treats an older registry version as an update", () => {
  assert.equal(compareVersions("1.0.2", "1.0.4"), -1);
  assert.equal(compareVersions("1.0.4", "1.0.4"), 0);
  assert.equal(compareVersions("1.0.5", "1.0.4"), 1);
  assert.equal(compareVersions("1.0.4-beta.2", "1.0.4-beta.1"), 1);
  assert.equal(compareVersions("1.0.4", "1.0.4-beta.2"), 1);
});

test("file translation worker preserves order and the configured concurrency", async () => {
  const values = Array.from({ length: 12 }, (_, index) => index);
  let active = 0;
  let maxActive = 0;
  const results = await mapWithConcurrency(values, 5, 0, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10 + (value % 3) * 5));
    active -= 1;
    return `translated-${value}`;
  });
  assert.equal(maxActive, 5);
  assert.deepEqual(results, values.map((value) => `translated-${value}`));
});

test("y/n confirmation accepts only upper and lower case single letters", () => {
  for (const value of ["y", "Y"]) assert.equal(parseYesNo(value), true);
  for (const value of ["n", "N"]) assert.equal(parseYesNo(value), false);
  for (const value of ["", "yes", "YES", "no", "NO", "1", "是", "maybe"]) {
    assert.equal(parseYesNo(value), null);
  }
});

test("CLI and Skill OCR dependencies use the same exact versions", async () => {
  const cliRequirements = await readFile(path.join(root, "resources", "ocr", "requirements-ocr.txt"), "utf8");
  const skillRequirements = await readFile(
    path.join(root, "skills", "transx-translate", "ocr-python", "requirements-ocr.txt"),
    "utf8",
  );

  assert.equal(skillRequirements, cliRequirements);
  assert.match(cliRequirements, /^rapidocr==3\.9\.2$/m);
  assert.match(cliRequirements, /^openvino==2026\.2\.1; sys_platform == "win32"$/m);
  assert.match(cliRequirements, /^openvino==2026\.2\.1; sys_platform == "linux"$/m);
  assert.match(cliRequirements, /^openvino==2026\.2\.1; sys_platform == "darwin" and platform_machine == "arm64"$/m);
  assert.match(cliRequirements, /^openvino==2025\.0\.0; sys_platform == "darwin" and platform_machine == "x86_64"$/m);
  assert.match(cliRequirements, /^opencv-python==4\.10\.0\.84$/m);
  for (const line of cliRequirements.trim().split(/\r?\n/)) {
    assert.match(line.split(";", 1)[0].trim(), /^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+$/);
  }
});

test("Python Skill entry points force UTF-8 output for agent calls", async () => {
  for (const file of [
    "skills/transx-translate/scripts/configure_skill.py",
    "skills/transx-translate/scripts/translate.py",
    "skills/transx-translate/ocr-python/ocr.py",
    "resources/ocr/ocr.py",
  ]) {
    const content = await readFile(path.join(root, file), "utf8");
    assert.match(content, /sys\.stdout\.reconfigure\(encoding="utf-8"\)/, `${file} does not set UTF-8 stdout`);
    assert.match(content, /sys\.stderr\.reconfigure\(encoding="utf-8"\)/, `${file} does not set UTF-8 stderr`);
  }
});

test("CLI and Node Skill lock the compatible PDF canvas dependency", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const skillPackageJson = JSON.parse(await readFile(
    path.join(root, "skills", "transx-translate", "package.json"),
    "utf8",
  ));
  const skillPackageLock = JSON.parse(await readFile(
    path.join(root, "skills", "transx-translate", "package-lock.json"),
    "utf8",
  ));

  for (const manifest of [packageJson, packageLock.packages[""], skillPackageJson, skillPackageLock.packages[""]]) {
    assert.equal(manifest.dependencies["@napi-rs/canvas"], "0.1.100");
    assert.equal(manifest.dependencies.unpdf, "1.7.0");
  }
});

test("downloadable Skill archive contains the complete OCR runtime without local environments", async () => {
  const archive = unzipSync(await readFile(path.join(root, "docs", "transx-skills.zip")));
  const entries = Object.keys(archive);
  for (const expected of [
    "transx-translate/ocr-node/ocr.mjs",
    "transx-translate/ocr-node/intermediate.mjs",
    "transx-translate/ocr-node/pdf-renderer.mjs",
    "transx-translate/ocr-node/visual-input.mjs",
    "transx-translate/ocr-python/ocr.py",
    "transx-translate/ocr-python/requirements-ocr.txt",
  ]) {
    assert.ok(entries.includes(expected), `${expected} is missing from the Skill archive`);
  }
  assert.ok(entries.every((entry) => !/(?:node_modules|\.venv-ocr|__pycache__|\.pyc$)/.test(entry)));
});

test("PDF pages render to non-empty PNG files through napi canvas", async () => {
  const temporaryPaths = [];
  const pages = await processRenderedPdfPages(
    path.join(root, "test-files", "sample.pdf"),
    async (page) => {
      temporaryPaths.push(page.imagePath);
      const png = await readFile(page.imagePath);
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(png.byteLength > 1_000);
      assert.ok(page.width > 0);
      assert.ok(page.height > 0);
      return page.page;
    },
  );

  assert.deepEqual(pages, [1]);
  for (const temporaryPath of temporaryPaths) {
    await assert.rejects(readFile(temporaryPath));
  }
});

test("OCR writes a reviewable intermediate file with source and coordinate metadata", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "transx-ocr-intermediate-"));
  try {
    const inputPath = path.join(temporaryDirectory, "scan.pdf");
    await writeFile(inputPath, "fixture");
    const result = {
      text: "LOCAL OCR",
      sourceCount: 1,
      sourceType: "pdf",
      engine: "rapidocr-openvino",
      model: "PP-OCRv6 Quality",
      items: [{
        text: "LOCAL OCR",
        confidence: 0.99,
        box: [[1, 2], [101, 2], [101, 22], [1, 22]],
        sourceIndex: 1,
        source: "第 1 页",
        page: 1,
      }],
      sources: [{
        sourceIndex: 1,
        label: "第 1 页",
        kind: "page",
        page: 1,
        text: "LOCAL OCR",
        items: [{
          text: "LOCAL OCR",
          confidence: 0.99,
          box: [[1, 2], [101, 2], [101, 22], [1, 22]],
          sourceIndex: 1,
          source: "第 1 页",
          page: 1,
        }],
      }],
    };
    const formatted = formatOcrIntermediate(result);
    assert.equal(formatSkillIntermediate(result), formatted);
    assert.match(formatted, /## 第 1 页/);
    assert.match(formatted, /LOCAL OCR/);
    assert.match(formatted, /"confidence":0\.99/);
    assert.match(formatted, /"box":\[\[1,2\]/);

    const first = await writeOcrIntermediate(inputPath, result);
    const second = await writeOcrIntermediate(inputPath, result);
    assert.equal(first.path, path.join(temporaryDirectory, "scan_OCR.md"));
    assert.equal(second.path, path.join(temporaryDirectory, "scan_OCR.1.md"));
    assert.equal(await readFile(first.path, "utf8"), formatted);
    assert.equal(first.preview, "[第 1 页]\nLOCAL OCR");
    assert.equal(first.previewTruncated, false);
    const prepared = await prepareFileTranslation(first.path);
    const translatableText = prepared.units.map((unit) => unit.text).join("\n");
    assert.match(translatableText, /LOCAL OCR/);
    assert.doesNotMatch(translatableText, /confidence|box|sourceIndex/);

    const longResult = {
      ...result,
      text: "A".repeat(2_100),
      sources: [{ ...result.sources[0], text: "A".repeat(2_100) }],
    };
    assert.equal(buildOcrPreview(longResult).truncated, true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("OCR extracts local images from DOCX, PPTX, and Markdown with source labels", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "transx-embedded-images-"));
  try {
    const imagePath = path.join(temporaryDirectory, "note.png");
    await writeFile(imagePath, tinyPng);
    const fixtures = [
      {
        type: "docx",
        file: path.join(temporaryDirectory, "sample.docx"),
        data: zipSync({ "word/media/image1.png": tinyPng }),
        label: "文档图片 1",
      },
      {
        type: "pptx",
        file: path.join(temporaryDirectory, "sample.pptx"),
        data: zipSync({
          "ppt/media/image1.png": tinyPng,
          "ppt/slides/_rels/slide2.xml.rels": strToU8(
            '<Relationships><Relationship Id="rId1" Target="../media/image1.png"/></Relationships>',
          ),
        }),
        label: "幻灯片 2 · 图片 1",
      },
      {
        type: "markdown",
        file: path.join(temporaryDirectory, "sample.md"),
        data: strToU8("![说明](./note.png)\n![远程](https://example.com/skip.png)\n"),
        label: "Markdown 图片 1 · note.png",
      },
    ];

    for (const fixture of fixtures) {
      await writeFile(fixture.file, fixture.data);
      for (const processInput of [processVisualInputSources, processSkillVisualInputSources]) {
        const temporaryPaths = [];
        const output = await processInput(fixture.file, async (source) => {
          temporaryPaths.push(source.imagePath);
          assert.deepEqual(await readFile(source.imagePath), tinyPng);
          return source.label;
        });
        assert.equal(output.sourceType, fixture.type);
        assert.deepEqual(output.results, [fixture.label]);
        for (const temporaryPath of temporaryPaths) {
          if (temporaryPath !== imagePath) await assert.rejects(readFile(temporaryPath));
        }
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("non-interactive JSON image translation stops after OCR until confirmation", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "transx-confirmation-test-"));
  try {
    const featureDirectory = path.join(temporaryHome, ".transx", "features", "ocr");
    const pythonDirectory = process.platform === "win32"
      ? path.join(featureDirectory, "venv", "Scripts")
      : path.join(featureDirectory, "venv", "bin");
    const pythonPath = path.join(pythonDirectory, process.platform === "win32" ? "python.exe" : "python");
    await mkdir(pythonDirectory, { recursive: true });
    await copyFile(process.execPath, pythonPath);
    await writeFile(path.join(featureDirectory, "ocr.py"),
      'console.log(JSON.stringify({ok:true,text:"LOCAL OCR",items:[{text:"LOCAL OCR",confidence:0.99}]}));\n');
    await writeFile(path.join(featureDirectory, "state.json"), JSON.stringify({
      status: "ready",
      feature_version: "1",
      engine: "rapidocr-openvino",
      model: "ppocr-v6-small",
      model_display: "PP-OCRv6 Quality",
      runtime_version: "test",
      platform: process.platform,
      arch: process.arch,
      installed_at: new Date(0).toISOString(),
      verified: true,
    }));
    const imagePath = path.join(temporaryHome, "input.png");
    await writeFile(imagePath, tinyPng);

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [path.join(root, "dist", "cli.js"), "translate", "--image", imagePath, "--to", "EN", "--json"],
      {
        env: {
          ...process.env,
          HOME: temporaryHome,
          USERPROFILE: temporaryHome,
          LOCALAPPDATA: path.join(temporaryHome, "AppData", "Local"),
          DLX_API_KEY: "",
        },
        windowsHide: true,
      },
    );
    const output = JSON.parse(stdout.trim());
    assert.equal(output.data.status, "awaiting_confirmation");
    assert.equal(output.data.translation_sent, false);
    assert.equal(output.data.preview, "[图片]\nLOCAL OCR");
    assert.equal(output.data.preview_truncated, false);
    assert.equal(output.data.source_count, 1);
    assert.equal(output.data.item_count, 1);
    assert.equal(output.data.recognition_file, path.join(temporaryHome, "input_OCR.md"));
    const intermediate = await readFile(output.data.recognition_file, "utf8");
    assert.match(intermediate, /## 图片/);
    assert.match(intermediate, /LOCAL OCR/);
    assert.match(intermediate, /"confidence":0\.99/);
    assert.match(stderr, /正在识别/);
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test("image translation sends recognized text only after explicit y confirmation", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "transx-confirmed-translation-test-"));
  try {
    const featureDirectory = path.join(temporaryHome, ".transx", "features", "ocr");
    const pythonDirectory = process.platform === "win32"
      ? path.join(featureDirectory, "venv", "Scripts")
      : path.join(featureDirectory, "venv", "bin");
    const pythonPath = path.join(pythonDirectory, process.platform === "win32" ? "python.exe" : "python");
    await mkdir(pythonDirectory, { recursive: true });
    await copyFile(process.execPath, pythonPath);
    await writeFile(
      path.join(featureDirectory, "ocr.py"),
      'console.log(JSON.stringify({ok:true,text:"LOCAL OCR",items:[{text:"LOCAL OCR",confidence:0.99}]}));\n',
    );
    await writeFile(path.join(featureDirectory, "state.json"), JSON.stringify({
      status: "ready",
      feature_version: "1",
      engine: "rapidocr-openvino",
      model: "ppocr-v6-small",
      model_display: "PP-OCRv6 Quality",
      runtime_version: "test",
      platform: process.platform,
      arch: process.arch,
      installed_at: new Date(0).toISOString(),
      verified: true,
    }));
    const fetchPreload = path.join(temporaryHome, "mock-fetch.cjs");
    await writeFile(fetchPreload, `
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(String(options?.body ?? "{}"));
  process.stderr.write("MOCK_TRANSLATION_REQUEST:" + JSON.stringify(payload) + "\\n");
  return new Response(JSON.stringify({ code: 200, data: "TRANSLATED" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`);
    const imagePath = path.join(temporaryHome, "input.png");
    await writeFile(imagePath, tinyPng);
    const args = [path.join(root, "dist", "cli.js"), "translate", "--image", imagePath, "--to", "EN"];
    const options = {
      env: {
        ...process.env,
        HOME: temporaryHome,
        USERPROFILE: temporaryHome,
        LOCALAPPDATA: path.join(temporaryHome, "AppData", "Local"),
        DLX_API_KEY: "test-key",
        NODE_OPTIONS: `--require=${fetchPreload}`,
      },
      windowsHide: true,
    };

    const declined = await execFileWithInput(process.execPath, args, "N\n", options);
    assert.match(declined.stdout, /已取消/);
    assert.doesNotMatch(declined.stderr, /MOCK_TRANSLATION_REQUEST/);

    const confirmed = await execFileWithInput(process.execPath, args, "Y\n", options);
    assert.match(confirmed.stderr, /已确认，进入文件翻译流程/);
    assert.match(confirmed.stderr, /MOCK_TRANSLATION_REQUEST:/);
    assert.match(confirmed.stdout, /译文已保存/);
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test("confirmed OCR translation reuses the concurrent file pipeline", async () => {
  const source = await readFile(path.join(root, "src", "cli.ts"), "utf8");
  assert.match(source, /filePath: intermediate\.path/);
  assert.match(source, /mapWithConcurrency\([\s\S]*FILE_TRANSLATION_CONCURRENCY/);
  assert.doesNotMatch(source, /开始翻译 .*个文字区域/);
});

test("CLI and Skill OCR metadata stay consistent", async () => {
  const sources = await Promise.all([
    "src/ocr/constants.ts",
    "skills/transx-translate/scripts/configure-skill.mjs",
    "skills/transx-translate/scripts/configure_skill.py",
    "skills/transx-translate/ocr-node/ocr.mjs",
    "skills/transx-translate/SKILL.md",
    "skills/transx-translate/assets/SKILL.original.md",
    "skills/transx-translate/assets/SKILL.cli.md",
    "skills/transx-translate/assets/SKILL.node.md",
    "skills/transx-translate/assets/SKILL.python.md",
  ].map(async (file) => [file, await readFile(path.join(root, file), "utf8")]));

  const sourceMap = Object.fromEntries(sources);
  assert.match(sourceMap["src/ocr/constants.ts"], /OCR_ENGINE = "rapidocr-openvino"/);
  assert.match(sourceMap["skills/transx-translate/scripts/configure-skill.mjs"], /OCR_ENGINE = "rapidocr-openvino"/);
  assert.match(sourceMap["skills/transx-translate/scripts/configure_skill.py"], /OCR_ENGINE = "rapidocr-openvino"/);

  for (const [file, content] of sources) {
    assert.doesNotMatch(content, /Python 3\.[89]\+/, `${file} contains an obsolete Python requirement`);
    assert.doesNotMatch(content, /(?:about |约 )(?:80|120) MB/, `${file} contains an obsolete download estimate`);
  }

  assert.match(sourceMap["skills/transx-translate/scripts/configure-skill.mjs"], /PYTHON_MIN_VERSION = "3\.10"/);
  assert.match(sourceMap["skills/transx-translate/scripts/configure_skill.py"], /PYTHON_MIN_VERSION = \(3, 10\)/);
  assert.match(sourceMap["skills/transx-translate/scripts/configure-skill.mjs"], /OCR_DOWNLOAD_SIZE_ESTIMATE = "约 180 MB"/);
  assert.match(sourceMap["skills/transx-translate/scripts/configure_skill.py"], /OCR_DOWNLOAD_SIZE_ESTIMATE = "约 180 MB"/);
  assert.match(sourceMap["skills/transx-translate/SKILL.md"], /Python 3\.10\+ and downloads about 180 MB/);
  assert.match(sourceMap["skills/transx-translate/assets/SKILL.original.md"], /Python 3\.10\+ and downloads about 180 MB/);
  assert.match(sourceMap["skills/transx-translate/SKILL.md"], /reviewable intermediate file/);
  assert.match(sourceMap["skills/transx-translate/assets/SKILL.cli.md"], /recognition_file/);
  assert.match(sourceMap["skills/transx-translate/assets/SKILL.cli.md"], /concurrent file translation flow/);
  assert.match(sourceMap["skills/transx-translate/assets/SKILL.node.md"], /recognition_file/);
  assert.match(sourceMap["skills/transx-translate/assets/SKILL.python.md"], /--save/);
});

test("OCR confirmation prompts use one case-insensitive y/n convention", async () => {
  const sources = await Promise.all([
    "src/ocr/feature-installer.ts",
    "src/ocr/command.ts",
    "skills/transx-translate/scripts/configure-skill.mjs",
    "skills/transx-translate/scripts/configure_skill.py",
  ].map(async (file) => [file, await readFile(path.join(root, file), "utf8")]));

  for (const [file, content] of sources) {
    assert.doesNotMatch(content, /\[(?:Y\/n|y\/N|Y\/N|1\/2)\]/, `${file} contains a non-standard confirmation prompt`);
  }
  assert.match(sources[0][1], /是否下载并开启？ \[y\/n\]/);
  assert.match(sources[2][1], /是否下载并开启？ \[y\/n\]/);
  assert.match(sources[3][1], /是否下载并开启？ \[y\/n\]/);
  assert.match(sources[2][1], /\.toLowerCase\(\)/);
  assert.match(sources[3][1], /\.lower\(\)/);
  for (const [file, content] of [sources[0], sources[2], sources[3]]) {
    assert.match(content, /确认后才发送识别文字/, `${file} does not explain the confirmation boundary`);
  }
});

test("public OCR documentation matches the shipped OpenVINO feature", async () => {
  const files = ["README.md", "docs/docs.html", "docs/skills.html"];
  for (const file of files) {
    const content = await readFile(path.join(root, file), "utf8");
    assert.match(content, /Python 3\.10\+/);
    assert.match(content, /180 MB/);
    assert.match(content, /RapidOCR \+ OpenVINO/);
    assert.doesNotMatch(content, /ONNX|DLL|(?:about |约 )80 MB|Python 3\.[89]\+/i);
  }
  for (const file of ["README.md", "docs/docs.html"]) {
    const content = await readFile(path.join(root, file), "utf8");
    assert.match(content, /_OCR\.md/);
    assert.match(content, /recognition_file/);
    assert.match(content, /并发/);
  }
});

test("JSON OCR errors remain machine-readable and return exit code 6", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "transx-ocr-test-"));
  try {
    for (const args of [
      ["ocr", "recognize", "missing.png", "--json"],
      ["translate", "--image", "missing.png", "--to", "EN", "--json"],
    ]) {
      await assert.rejects(
        execFileAsync(process.execPath, [path.join(root, "dist", "cli.js"), ...args], {
          env: {
            ...process.env,
            HOME: temporaryHome,
            USERPROFILE: temporaryHome,
            LOCALAPPDATA: path.join(temporaryHome, "AppData", "Local"),
          },
          windowsHide: true,
        }),
        (error) => {
          assert.equal(error.code, 6);
          const output = JSON.parse(error.stdout.trim());
          assert.equal(output.ok, false);
          assert.equal(output.error.code, "OCR_NOT_INSTALLED");
          return true;
        },
      );
    }
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});
