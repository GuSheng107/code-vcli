import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  VISION_SCRIPT_FILE_NAME,
  VISION_VENV_DIR_NAME,
  VLM_REQUEST_TIMEOUT,
} from "./constants.js";
import type { VisionOcrEngineType, VisionMode, ComputeCapability, OcrBackend } from "./constants.js";
import { VcliError } from "../errors.js";
import type { VisionStateStore } from "./feature-state.js";
import type { VisionRecognitionResult, PythonOutput } from "./types.js";

interface PythonBridgeOptions {
  timeoutMs?: number;
  minConfidence?: number;
  mode?: VisionMode;
  prompt?: string;
  ocrBackend?: OcrBackend;
  mixOcrContextTokens?: number;
}

export function getVenvPython(featureDirectory: string): string {
  const venvDir = path.join(featureDirectory, VISION_VENV_DIR_NAME);
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

export function getVisionScriptPath(featureDirectory: string): string {
  return path.join(featureDirectory, VISION_SCRIPT_FILE_NAME);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function runModelInit(
  pythonPath: string,
  scriptPath: string,
  configRoot: string,
  compute: ComputeCapability = "both",
  vlmModelOption?: string,
  ocrBackend: OcrBackend = "cpu",
  requireGpu = false,
): Promise<void> {
  const initArgs = ["--init", "--compute", compute, "--ocr-backend", ocrBackend];
  if (requireGpu) initArgs.push("--require-gpu");
  if (vlmModelOption) initArgs.push("--vlm-option", vlmModelOption);
  const output = await executePython(
    pythonPath,
    scriptPath,
    initArgs,
    { timeoutMs: 60 * 60_000, env: { VCLI_CONFIG_ROOT: configRoot } },
  );
  if (!output.ok) {
    const code = output.error?.code ?? "MODEL_DOWNLOAD_FAILED";
    const message = output.error?.message ?? "模型下载失败";
    throw new VcliError(
      code === "MODEL_INITIALIZATION_FAILED" ? "MODEL_INITIALIZATION_FAILED" : "MODEL_DOWNLOAD_FAILED",
      message,
      6,
    );
  }
}

export async function runModelSelfTest(
  pythonPath: string,
  scriptPath: string,
  configRoot: string,
  compute: ComputeCapability = "both",
  ocrBackend: OcrBackend = "cpu",
  requireGpu = false,
): Promise<boolean> {
  try {
    const output = await executePython(
      pythonPath,
      scriptPath,
      [
        "--self-test", "--compute", compute,
        "--ocr-backend", ocrBackend,
        ...(requireGpu ? ["--require-gpu"] : []),
      ],
      { timeoutMs: 10 * 60_000, env: { VCLI_CONFIG_ROOT: configRoot } },
    );
    return output.ok;
  } catch {
    return false;
  }
}

export async function runVisionInference(
  stateStore: VisionStateStore,
  imagePath: string,
  ocrEngine: VisionOcrEngineType,
  webMode: boolean,
  options: PythonBridgeOptions = {},
): Promise<VisionRecognitionResult> {
  const ready = await stateStore.isReady();
  if (!ready) {
    throw new VcliError(
      "MODEL_NOT_INSTALLED",
      "视觉模型尚未安装，运行 code-vcli init 初始化",
      6,
    );
  }

  const pythonPath = getVenvPython(stateStore.directory);
  const scriptPath = getVisionScriptPath(stateStore.directory);

  if (!(await fileExists(pythonPath))) {
    throw new VcliError(
      "MODEL_RUNTIME_MISSING",
      "Python 运行时丢失，请重新运行 code-vcli init",
      6,
    );
  }
  if (!(await fileExists(scriptPath))) {
    throw new VcliError(
      "MODEL_RUNTIME_MISSING",
      "推理脚本丢失，请重新运行 code-vcli init",
      6,
    );
  }

  const state = await stateStore.read();
  const ocrBackend = options.ocrBackend ?? state?.ocrBackend ?? "cpu";
  const args = ["--image", imagePath, "--ocr", ocrEngine, "--ocr-backend", ocrBackend];
  if (state?.computeMode === "gpu") args.push("--require-gpu");
  if (options.mode) args.push("--mode", options.mode);
  if (options.prompt) args.push("--prompt", options.prompt);
  if (options.mixOcrContextTokens !== undefined) {
    args.push("--mix-ocr-context-tokens", String(options.mixOcrContextTokens));
  }
  if (webMode) {
    args.push("--web");
    if (options.minConfidence !== undefined) {
      args.push("--min-confidence", String(options.minConfidence));
    }
  }

  const isVlm = options.mode === "vlm" || options.mode === "mix";
  const timeoutMs = options.timeoutMs ?? (isVlm ? VLM_REQUEST_TIMEOUT : undefined);
  const output = await executePython(
    pythonPath,
    scriptPath,
    args,
    {
      ...options,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      env: { VCLI_CONFIG_ROOT: stateStore.directory },
    },
  );

  if (output.ok === false) {
    const code = output.error?.code ?? "MODEL_RECOGNITION_FAILED";
    const message = output.error?.message ?? "视觉识别失败";
    throw new VcliError(mapPythonError(code), message, 6);
  }

  const items = output.items ?? [];
  if (items.length === 0 && !isVlm) {
    throw new VcliError("MODEL_TEXT_EMPTY", "未识别到文字", 6);
  }

  return {
    text: output.text ?? items.map((item) => item.text).join("\n"),
    items,
    ...(output.layout ? { layout: output.layout } : {}),
    ...(output.mode ? { mode: output.mode } : {}),
    ...(output.intent ? { intent: output.intent } : {}),
    ...(output.summary ? { summary: output.summary } : {}),
    ...(output.elements ? { elements: output.elements } : {}),
    ...(output.annotations ? { annotations: output.annotations } : {}),
    ...(output.raw ? { raw: output.raw } : {}),
    ...(output.engine ? { engine: output.engine } : {}),
    ...(output.ocr_text !== undefined ? { ocrText: output.ocr_text } : {}),
    ...(output.ocr_context ? { ocrContext: output.ocr_context } : {}),
  } as VisionRecognitionResult;
}

interface ExecutePythonOptions extends PythonBridgeOptions {
  env?: Record<string, string>;
}

async function executePython(
  pythonPath: string,
  scriptPath: string,
  args: string[],
  options: ExecutePythonOptions,
): Promise<PythonOutput> {
  return await new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [scriptPath, ...args], {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        ...options.env,
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          reject(new VcliError("MODEL_RECOGNITION_FAILED", "视觉识别超时", 6));
        }, options.timeoutMs)
      : null;

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      // 将 Python 进程的进度日志透传到当前进程 stderr，便于用户观察。
      const text = chunk.toString("utf8");
      if (text) process.stderr.write(text);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(
        new VcliError(
          "MODEL_RUNTIME_MISSING",
          `无法启动 Python 运行时：${error.message}`,
          6,
          { cause: error },
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);

      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (code !== 0 && !stdoutText) {
        reject(
          new VcliError(
            "MODEL_RECOGNITION_FAILED",
            stderrText || `Python 进程退出码 ${code}`,
            6,
          ),
        );
        return;
      }

      try {
        const parsed = JSON.parse(stdoutText) as PythonOutput;
        resolve(parsed);
      } catch {
        reject(
          new VcliError(
            "MODEL_RECOGNITION_FAILED",
            `Python 输出解析失败：${stdoutText.slice(0, 200)}`,
            6,
          ),
        );
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
    case "MODEL_RUNTIME_MISSING":
      return "MODEL_RUNTIME_MISSING";
    case "MODEL_INITIALIZATION_FAILED":
      return "MODEL_INITIALIZATION_FAILED";
    case "MODEL_TEXT_EMPTY":
      return "MODEL_TEXT_EMPTY";
    case "MODEL_RECOGNITION_FAILED":
      return "MODEL_RECOGNITION_FAILED";
    default:
      return "MODEL_RECOGNITION_FAILED";
  }
}
