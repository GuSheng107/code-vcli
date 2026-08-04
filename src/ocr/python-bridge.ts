import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  OCR_SCRIPT_FILE_NAME,
  OCR_VENV_DIR_NAME,
  OCR_ENGINE,
} from "./constants.js";
import { TransxError } from "../errors.js";
import type { OcrFeatureStateStore } from "./feature-state.js";
import type { OcrItem, OcrRecognitionResult } from "./types.js";

interface PythonBridgeOptions {
  timeoutMs?: number;
}

interface OcrPythonOutput {
  ok: boolean;
  text?: string;
  items?: OcrItem[];
  engine?: string;
  model?: string;
  error?: {
    code: string;
    message: string;
  };
}

export function getVenvPython(featureDirectory: string): string {
  const venvDir = path.join(featureDirectory, OCR_VENV_DIR_NAME);
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

export async function getOcrScriptPath(featureDirectory: string): Promise<string> {
  return path.join(featureDirectory, OCR_SCRIPT_FILE_NAME);
}

export async function runOcrRecognition(
  stateStore: OcrFeatureStateStore,
  imagePath: string,
  options: PythonBridgeOptions = {},
): Promise<OcrRecognitionResult> {
  const ready = await stateStore.isReady();
  if (!ready) {
    throw new TransxError("OCR_NOT_INSTALLED", "图片识别翻译扩展尚未安装，运行 transx ocr enable 开启", 6);
  }

  const pythonPath = getVenvPython(stateStore.featureDirectory);
  const scriptPath = await getOcrScriptPath(stateStore.featureDirectory);

  let pythonExists = false;
  try {
    await readFile(pythonPath);
    pythonExists = true;
  } catch {
    pythonExists = false;
  }
  if (!pythonExists) {
    throw new TransxError("OCR_RUNTIME_MISSING", "OCR Python 运行时丢失，请重新运行 transx ocr enable", 6);
  }

  const output = await executePython(pythonPath, scriptPath, ["--image", imagePath], options);

  if (!output.ok) {
    const code = output.error?.code ?? "OCR_RECOGNITION_FAILED";
    const message = output.error?.message ?? "OCR 识别失败";
    const transxCode = mapPythonError(code);
    throw new TransxError(transxCode, message, 6);
  }

  const items = output.items ?? [];
  if (items.length === 0) {
    throw new TransxError("OCR_TEXT_EMPTY", "未识别到文字", 6);
  }

  return {
    text: output.text ?? items.map((item) => item.text).join("\n"),
    items,
    engine: OCR_ENGINE,
    model: "PP-OCRv6 Quality",
  };
}

export async function runOcrSelfTest(
  pythonPath: string,
  scriptPath: string,
): Promise<boolean> {
  try {
    const output = await executePython(pythonPath, scriptPath, ["--self-test"], { timeoutMs: 600_000 });
    return output.ok;
  } catch {
    return false;
  }
}

async function executePython(
  pythonPath: string,
  scriptPath: string,
  args: string[],
  options: PythonBridgeOptions,
): Promise<OcrPythonOutput> {
  return await new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [scriptPath, ...args], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          reject(new TransxError("OCR_RECOGNITION_FAILED", "OCR 识别超时", 6));
        }, options.timeoutMs)
      : null;

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new TransxError("OCR_RUNTIME_MISSING", `无法启动 Python 运行时：${error.message}`, 6, { cause: error }));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);

      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (code !== 0 && !stdoutText) {
        reject(new TransxError("OCR_RECOGNITION_FAILED", stderrText || `OCR 进程退出码 ${code}`, 6));
        return;
      }

      try {
        const parsed = JSON.parse(stdoutText) as OcrPythonOutput;
        resolve(parsed);
      } catch {
        reject(new TransxError("OCR_RECOGNITION_FAILED", `OCR 输出解析失败：${stdoutText.slice(0, 200)}`, 6));
      }
    });
  });
}

function mapPythonError(code: string): import("../errors.js").ErrorCode {
  switch (code) {
    case "IMAGE_READ_ERROR":
      return "IMAGE_READ_ERROR";
    case "IMAGE_FORMAT_UNSUPPORTED":
      return "IMAGE_FORMAT_UNSUPPORTED";
    case "IMAGE_TOO_LARGE":
      return "IMAGE_TOO_LARGE";
    case "OCR_RUNTIME_MISSING":
      return "OCR_RUNTIME_MISSING";
    case "OCR_INITIALIZATION_FAILED":
      return "OCR_INITIALIZATION_FAILED";
    case "OCR_TEXT_EMPTY":
      return "OCR_TEXT_EMPTY";
    case "OCR_RECOGNITION_FAILED":
      return "OCR_RECOGNITION_FAILED";
    default:
      return "OCR_RECOGNITION_FAILED";
  }
}
