#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { stdin, stderr, stdout } from "node:process";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.dirname(scriptDirectory);
const assets = path.join(skillRoot, "assets");
const preference = path.join(os.homedir(), ".transx", "skill-preference.json");
const venvDir = path.join(skillRoot, ".venv-ocr");
const ocrPythonScript = path.join(skillRoot, "ocr-python", "ocr.py");
const ocrRequirements = path.join(skillRoot, "ocr-python", "requirements-ocr.txt");

const PYTHON_MIN_VERSION = "3.10";
const OCR_ENGINE = "rapidocr-openvino";
const OCR_DOWNLOAD_SIZE_ESTIMATE = "约 180 MB";

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function replaceSkill(templateName) {
  const target = path.join(skillRoot, "SKILL.md");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(path.join(assets, templateName), temporary);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readStdinLine() {
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  return await new Promise((resolve) => {
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.once("data", (line) => {
      resolve(line.trim());
    });
  });
}

async function checkPythonAvailable() {
  const candidates = process.platform === "win32"
    ? ["python", "python3", "py"]
    : ["python3", "python"];
  for (const candidate of candidates) {
    try {
      const args = candidate === "py" ? ["-3", "--version"] : ["--version"];
      const { stdout, stderr: err } = await execFileAsync(candidate, args, { windowsHide: true });
      const output = (stdout || err).trim();
      const match = output.match(/Python (\d+)\.(\d+)\.(\d+)/);
      if (!match) continue;
      const major = Number(match[1]);
      const minor = Number(match[2]);
      const minParts = PYTHON_MIN_VERSION.split(".").map(Number);
      const minMajor = minParts[0] ?? 3;
      const minMinor = minParts[1] ?? 10;
      if (major < minMajor || (major === minMajor && minor < minMinor)) continue;
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function createVenv(pythonPath) {
  await execFileAsync(pythonPath, ["-m", "venv", venvDir], { windowsHide: true });
}

function getVenvPython() {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

async function installRequirements(venvPython) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      venvPython,
      ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", ocrRequirements],
      { windowsHide: true, stdio: ["ignore", "inherit", "inherit"] },
    );
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("安装 Python 依赖超时"));
    }, 600_000);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`pip 退出码 ${code ?? "unknown"}`));
    });
  });
}

async function runOcrSelfTest(venvPython) {
  try {
    const { stdout, stderr: err, code } = await execFileAsync(
      venvPython,
      [ocrPythonScript, "--self-test"],
      { windowsHide: true, timeout: 600_000 },
    );
    const output = (stdout || err).trim();
    if (!output) return false;
    const parsed = JSON.parse(output);
    return parsed.ok === true;
  } catch {
    return false;
  }
}

async function installOcr() {
  const pythonPath = await checkPythonAvailable();
  if (!pythonPath) {
    stderr.write(`未找到 Python ${PYTHON_MIN_VERSION}+ 环境。图片识别翻译扩展需要 Python，已跳过。\n`);
    return false;
  }

  stderr.write("正在创建 OCR 虚拟环境…\n");
  await createVenv(pythonPath);

  const venvPython = getVenvPython();
  stderr.write("正在安装 RapidOCR 依赖（首次可能需要数分钟）…\n");
  await installRequirements(venvPython);

  stderr.write("正在执行 OCR 自检…\n");
  const ok = await runOcrSelfTest(venvPython);
  if (!ok) {
    stderr.write("OCR 自检失败，图片识别翻译扩展未启用。\n");
    await rm(venvDir, { recursive: true, force: true });
    return false;
  }
  return true;
}

async function removeOcr() {
  await rm(venvDir, { recursive: true, force: true });
}

async function main() {
  const mode = process.argv[2];
  if (!new Set(["cli", "script", "reset"]).has(mode)) {
    stderr.write("usage: configure-skill.mjs <cli|script|reset>\n");
    process.exitCode = 2;
    return;
  }

  if (mode === "reset") {
    await rm(preference, { force: true });
    await replaceSkill("SKILL.original.md");
    await removeOcr();
    stdout.write(`${JSON.stringify({ ok: true, configured: false })}\n`);
    return;
  }

  // 询问是否启用 OCR
  stderr.write("\n是否启用图片识别翻译扩展？\n");
  stderr.write("- 使用 PP-OCRv6 Quality 本地识别\n");
  stderr.write("- 图片不会上传\n");
  stderr.write("- 确认后才发送识别文字\n");
  stderr.write(`- 需要 Python ${PYTHON_MIN_VERSION}+ 环境和${OCR_DOWNLOAD_SIZE_ESTIMATE}下载\n`);
  stderr.write("\n是否下载并开启？ [y/n] ");

  let normalizedAnswer = "";
  while (normalizedAnswer !== "y" && normalizedAnswer !== "n") {
    normalizedAnswer = (await readStdinLine()).trim().toLowerCase();
    if (normalizedAnswer !== "y" && normalizedAnswer !== "n") stderr.write("是否下载并开启？ [y/n] ");
  }
  const enableOcr = normalizedAnswer === "y";

  let ocrEnabled = false;
  if (enableOcr) {
    try {
      ocrEnabled = await installOcr();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      stderr.write(`OCR 安装失败：${detail}\n图片识别翻译扩展未启用。\n`);
      await removeOcr();
      ocrEnabled = false;
    }
  } else {
    stderr.write("已跳过图片识别翻译扩展。未来可重新运行配置以启用。\n");
  }

  const runtime = mode === "cli" ? null : "node";
  const preferenceData = {
    version: 1,
    mode,
    runtime,
    ocr_enabled: ocrEnabled,
    ocr_engine: ocrEnabled ? OCR_ENGINE : null,
    ocr_model: ocrEnabled ? "ppocr-v6-small" : null,
    ocr_model_display: ocrEnabled ? "PP-OCRv6 Quality" : null,
    ocr_feature_version: ocrEnabled ? "1" : null,
  };
  await writeJsonAtomic(preference, preferenceData);
  await replaceSkill(mode === "cli" ? "SKILL.cli.md" : "SKILL.node.md");
  stdout.write(`${JSON.stringify({ ok: true, mode, runtime, ocr_enabled: ocrEnabled })}\n`);
}

main().catch((error) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
