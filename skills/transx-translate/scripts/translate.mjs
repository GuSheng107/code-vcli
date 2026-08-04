#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { stdin, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { appendHistory } from "./history.mjs";
import {
  prepareFileTranslation,
  translatedText,
  writeTranslatedFile,
} from "./file-document.mjs";

const TRANSLATION_TEXT_MAX_CHARS = 1_500;
const USER_AGENT = "Mozilla/5.0 (compatible; TransX; +https://github.com/GuSheng107/transx-cli)";
const FILE_REQUEST_DELAY_MS = 200;
const FILE_TRANSLATION_CONCURRENCY = 5;

const configPath = path.join(os.homedir(), ".transx", "credentials.json");
const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const endpointTemplate = "https://api.deeplx.org/{key}/translate";
const retries = 2;

class TranslationError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function promptSecret(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new TranslationError("INVALID_ARGUMENT", "非交互环境请使用 --key-stdin", 2);
  }
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return await new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new TranslationError("CANCELLED", "操作已取消", 130));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stderr.write("\b \b");
          }
          continue;
        }
        value += character;
        stderr.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

async function writeCredentials(apiKey) {
  const normalized = apiKey.trim();
  if (!normalized) throw new TranslationError("CONFIG_INVALID", "API Key 不能为空", 3);
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, apiKey: normalized }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, configPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function resolveApiKey() {
  const environmentKey = process.env.DLX_API_KEY?.trim();
  if (environmentKey) return environmentKey;
  let stored;
  try {
    stored = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new TranslationError("CONFIG_NOT_INITIALIZED", "缺少 DLX API Key，请先运行 translate.mjs init。获取：https://connect.linux.do/", 3);
    }
    throw new TranslationError("CONFIG_INVALID", `无法读取本地配置：${error.message}`, 3);
  }
  if (typeof stored?.apiKey !== "string" || !stored.apiKey.trim()) {
    throw new TranslationError("CONFIG_INVALID", "本地配置缺少有效 API Key", 3);
  }
  return stored.apiKey.trim();
}

function parseTranslateArguments(args) {
  const parsed = { source: "auto", timeout: 20, json: false, text: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") parsed.json = true;
    else if (["--to", "-t", "--source", "-s", "--timeout", "--file", "-f", "--output", "-o"].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new TranslationError("INVALID_ARGUMENT", `${arg} 缺少参数值`, 2);
      }
      index += 1;
      if (arg === "--to" || arg === "-t") parsed.target = value;
      else if (arg === "--source" || arg === "-s") parsed.source = value;
      else if (arg === "--timeout") parsed.timeout = Number(value);
      else if (arg === "--file" || arg === "-f") parsed.file = value;
      else parsed.output = value;
    } else if (arg.startsWith("-")) {
      throw new TranslationError("INVALID_ARGUMENT", `未知参数：${arg}`, 2);
    } else parsed.text.push(arg);
  }
  if (parsed.file && parsed.text.length) {
    throw new TranslationError("INVALID_ARGUMENT", "--file 与位置文本不能同时使用", 2);
  }
  if (parsed.output && !parsed.file) {
    throw new TranslationError("INVALID_ARGUMENT", "--output 只能与 --file 一起使用", 2);
  }
  if (!parsed.target) throw new TranslationError("INVALID_ARGUMENT", "必须通过 --to 指定目标语言", 2);
  if (!Number.isFinite(parsed.timeout) || parsed.timeout <= 0) {
    throw new TranslationError("INVALID_ARGUMENT", "--timeout 必须是正数秒", 2);
  }
  return parsed;
}

async function translate(parsed, suppliedText) {
  const text = suppliedText ?? (parsed.text.length
    ? parsed.text.join(" ")
    : stdin.isTTY
      ? ""
      : await readStdin());
  parsed.resolvedText = text;
  if (!text.trim()) throw new TranslationError("INVALID_ARGUMENT", "待翻译文本不能为空", 2);
  if ([...text].length > TRANSLATION_TEXT_MAX_CHARS) {
    throw new TranslationError(
      "INVALID_ARGUMENT",
      `文本超过 DLX 单次上限 ${TRANSLATION_TEXT_MAX_CHARS} 字符，请分段或分批翻译`,
      2,
    );
  }
  const payload = {
    text,
    source_lang: parsed.source,
    target_lang: parsed.target.toUpperCase(),
  };
  const endpoint = endpointTemplate.replace("{key}", encodeURIComponent(await resolveApiKey()));

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), parsed.timeout * 1000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": USER_AGENT },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (attempt < retries && response.status >= 500) {
          await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
          continue;
        }
        throw new TranslationError("API_HTTP_ERROR", `DLX 请求失败，HTTP ${response.status}`, 5);
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new TranslationError("API_RESPONSE_INVALID", "DLX 返回的不是有效 JSON", 6);
      }
      if (body?.code !== undefined && body.code !== 200) {
        throw new TranslationError("API_HTTP_ERROR", body.message || "DLX 返回业务错误", 5);
      }
      if (typeof body?.data !== "string") {
        throw new TranslationError("API_RESPONSE_INVALID", "DLX 响应缺少字符串字段 data", 6);
      }
      return {
        ok: true,
        data: body.data,
        source_lang: parsed.source,
        target_lang: parsed.target.toUpperCase(),
        provider: "dlx",
      };
    } catch (error) {
      if (error instanceof TranslationError) throw error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
        continue;
      }
      throw new TranslationError("NETWORK_ERROR", "无法连接 DLX 服务", 4);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new TranslationError("NETWORK_ERROR", "无法连接 DLX 服务", 4);
}

function printHelp() {
  stdout.write(
    "translate.mjs init [--key-stdin]\n" +
    "translate.mjs translate [text | -f, --file <path>] -t, --to LANG [-o, --output <path>] [-s, --source LANG] [--timeout seconds] [--json]\n",
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "init") {
    const apiKey = args.includes("--key-stdin")
      ? await readStdin()
      : await promptSecret("DLX API Key（获取：https://connect.linux.do/）：");
    await writeCredentials(apiKey);
    stdout.write(`${JSON.stringify({ ok: true, config: configPath })}\n`);
    return;
  }
  if (command !== "translate") throw new TranslationError("INVALID_ARGUMENT", `未知命令：${command}`, 2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const parsed = parseTranslateArguments(args);
  if (parsed.file) {
    const prepared = await prepareFileTranslation(parsed.file, skillDirectory);
    stderr.write(`文件翻译速度较慢，共 ${prepared.units.length} 个请求\n`);
    const translations = new Array(prepared.units.length);
    let completed = 0;
    let nextIndex = 0;
    let lastResult;
    const worker = async () => {
      while (nextIndex < prepared.units.length) {
        const index = nextIndex;
        nextIndex += 1;
        const result = await translate(parsed, prepared.units[index].text);
        translations[index] = result.data;
        lastResult = result;
        completed += 1;
        stderr.write(`翻译进度 ${completed}/${prepared.units.length}\n`);
        if (nextIndex < prepared.units.length) {
          await new Promise((resolve) => setTimeout(resolve, FILE_REQUEST_DELAY_MS));
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(FILE_TRANSLATION_CONCURRENCY, prepared.units.length) },
      worker,
    ));
    const data = translatedText(prepared, translations);
    const targetLang = parsed.target.toUpperCase();
    const written = await writeTranslatedFile(prepared, translations, targetLang, parsed.output);
    try {
      await appendHistory({
        sourceLang: parsed.source,
        targetLang,
        format: "file",
        sourceFilePath: prepared.sourcePath,
        sourceFileName: path.basename(prepared.sourcePath),
        outputFilePath: written.outputPath,
        outputFileName: written.outputPath ? path.basename(written.outputPath) : null,
      });
    } catch (error) {
      stderr.write(`历史记录写入失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
    const response = {
      ok: true,
      data,
      source_lang: lastResult?.source_lang ?? parsed.source,
      target_lang: targetLang,
      provider: "dlx",
      output_file: written.outputPath,
      output_format: prepared.outputExtension.slice(1),
      fallback: written.fallback,
    };
    if (parsed.json) stdout.write(`${JSON.stringify(response)}\n`);
    else if (written.outputPath) stdout.write(`译文已保存：${written.outputPath}\n`);
    else {
      stderr.write("无法写入译文文件，已返回文本\n");
      stdout.write(`${data}\n`);
    }
    return;
  }
  const result = await translate(parsed);
  try {
    await appendHistory({
      sourceLang: parsed.source,
      targetLang: parsed.target.toUpperCase(),
      format: "plain",
      input: parsed.resolvedText,
      output: result.data,
    });
  } catch (error) {
    stderr.write(`历史记录写入失败：${error instanceof Error ? error.message : String(error)}\n`);
  }
  stdout.write(`${parsed.json ? JSON.stringify(result) : result.data}\n`);
}

main().catch((error) => {
  const handled = error instanceof TranslationError
    ? error
    : new TranslationError(error?.code ?? "UNKNOWN_ERROR", error instanceof Error ? error.message : String(error), error?.exitCode ?? 1);
  stderr.write(`${JSON.stringify({ ok: false, error: { code: handled.code, message: handled.message } })}\n`);
  process.exitCode = handled.exitCode;
});
