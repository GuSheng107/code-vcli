#!/usr/bin/env node
/**
 * TransX OCR Node 桥接脚本
 *
 * 通过子进程调用 Python RapidOCR（ocr-python/ocr.py）执行本地 OCR。
 * 需要 Python 3.10+ 环境和已安装的 RapidOCR 虚拟环境（.venv-ocr）。
 *
 * Usage:
 *   node ocr.mjs recognize <image-path> [--json]
 *   node ocr.mjs self-test
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { processVisualInputSources } from "./visual-input.mjs";
import { writeIntermediate } from "./intermediate.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.dirname(scriptDir);
const pythonScript = path.join(skillRoot, "ocr-python", "ocr.py");
const venvDir = path.join(skillRoot, ".venv-ocr");

function getVenvPython() {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runPython(args, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const pythonPath = getVenvPython();
    const child = spawn(pythonPath, [pythonScript, ...args], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("OCR 识别超时"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 Python 运行时：${error.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const err = Buffer.concat(stderrChunks).toString("utf8").trim();
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

async function ensureRuntime() {
  const pythonPath = getVenvPython();
  const exists = await fileExists(pythonPath);
  if (!exists) {
    stdout.write(`${JSON.stringify({
      ok: false,
      error: {
        code: "OCR_NOT_INSTALLED",
        message: "图片识别翻译扩展尚未安装",
        install_hint: "运行 node <skill-dir>/scripts/configure-skill.mjs script 重新配置，或手动创建 .venv-ocr",
      },
    })}\n`);
    return false;
  }
  return true;
}

async function recognizeOne(imagePath) {
  const result = await runPython(["--image", imagePath]);
  if (result.code !== 0 && !result.stdout) {
    const error = new Error(result.stderr || `OCR 进程退出码 ${result.code}`);
    error.code = "OCR_RECOGNITION_FAILED";
    throw error;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (!parsed.ok) {
      const error = new Error(parsed.error?.message || "OCR 识别失败");
      error.code = parsed.error?.code || "OCR_RECOGNITION_FAILED";
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    const parseError = new Error(`OCR 输出解析失败：${result.stdout.slice(0, 200)}`);
    parseError.code = "OCR_RECOGNITION_FAILED";
    throw parseError;
  }
}

async function recognize(inputPath, asJson) {
  if (!(await ensureRuntime())) return;

  const resolved = path.resolve(inputPath);
  try {
    const processed = await processVisualInputSources(resolved, async (source) => {
      try {
        const result = await recognizeOne(source.imagePath);
        return {
          ...source,
          text: result.text,
          items: result.items.map((item) => ({ ...item, sourceIndex: source.sourceIndex, source: source.label, ...(source.page ? { page: source.page } : {}), ...(source.slides ? { slides: source.slides } : {}) })),
        };
      } catch (error) {
        if (error?.code === "OCR_TEXT_EMPTY") return { ...source, text: "", items: [] };
        throw error;
      }
    });
    const items = processed.results.flatMap((source) => source.items);
    if (!items.length) {
      const error = new Error("未识别到文字");
      error.code = "OCR_TEXT_EMPTY";
      throw error;
    }
    const output = {
      text: processed.results.map((source) => source.text).filter(Boolean).join("\n\n"),
      items,
      sources: processed.results.map(({ imagePath, ...source }) => source),
      sourceType: processed.sourceType,
      sourceCount: processed.results.length,
    };
    const intermediate = await writeIntermediate(resolved, output);

    if (asJson) {
      stdout.write(`${JSON.stringify({
        ok: true,
        data: {
          recognition_file: intermediate.path,
          preview: intermediate.preview,
          preview_truncated: intermediate.previewTruncated,
          source_count: output.sourceCount,
          item_count: output.items.length,
          ocr: {
            engine: "rapidocr-openvino",
            model: "PP-OCRv6 Quality",
            local: true,
            source_type: output.sourceType,
            source_count: output.sourceCount,
          },
        },
      })}\n`);
    } else {
      stdout.write(
        `识别结果${intermediate.previewTruncated ? "（预览）" : ""}：\n${intermediate.preview}\n\n` +
        `识别结果文件：${intermediate.path}\n`,
      );
    }
  } catch (error) {
    const code = error?.code || "OCR_RECOGNITION_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    if (asJson) stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
    else stderr.write(`错误：${message}\n`);
  }
}

async function selfTest() {
  if (!(await ensureRuntime())) return;
  const result = await runPython(["--self-test"], 600_000);
  try {
    const parsed = JSON.parse(result.stdout);
    stdout.write(`${JSON.stringify(parsed)}\n`);
  } catch {
    stdout.write(`${JSON.stringify({ ok: false, error: { message: result.stderr || "自检失败" } })}\n`);
  }
}

function printHelp() {
  stdout.write(`TransX OCR Node 桥接脚本

Usage:
  node ocr.mjs recognize <path> [--json]          识别图片或文件内图片文字
  node ocr.mjs self-test                          执行 OCR 自检
  node ocr.mjs help                               显示此帮助

模型：PP-OCRv6 Quality（本地离线，支持中英日等 50 种语言）
依赖：需要 Python 3.10+ 环境和已安装的 .venv-ocr 虚拟环境
`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }
  if (command === "recognize") {
    const asJson = args.includes("--json");
    const imagePath = args.find((arg) => !arg.startsWith("-"));
    if (!imagePath) {
      stderr.write("错误：请指定图片或文件路径\n");
      process.exitCode = 2;
      return;
    }
    await recognize(imagePath, asJson);
    return;
  }
  if (command === "self-test") {
    await selfTest();
    return;
  }
  stderr.write(`未知命令：${command}\n`);
  process.exitCode = 2;
}

main().catch((error) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
