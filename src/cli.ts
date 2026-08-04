#!/usr/bin/env node

import { stdin, stderr, stdout } from "node:process";
import path from "node:path";

import { ConfigStore } from "./config.js";
import { FILE_REQUEST_DELAY_MS, FILE_TRANSLATION_CONCURRENCY } from "./constants.js";
import { mapWithConcurrency } from "./concurrent.js";
import { TransxError, toTransxError } from "./errors.js";
import {
  prepareFileTranslation,
  translatedText,
  writeTranslatedFile,
} from "./file-document.js";
import { runHistoryCommand } from "./history-command.js";
import { HistoryStore } from "./history.js";
import { promptEnterOrEscape, promptSecret, promptText, promptTranslationContinue, promptYesNo, readStdin } from "./input.js";
import { compareVersions, getLatestVersion, installCurrentPackage, updateFromRegistry } from "./installer.js";
import { getLanguagesJson, getLanguagesText } from "./languages.js";
import { getPackageInfo } from "./package-info.js";
import { translate } from "./translator.js";
import {
  buildInteractiveFrame,
  clearScreen,
  getInteractiveMenuItems,
  selectInteractiveMenu,
  type InteractiveAction,
} from "./ui.js";
import { runOcrCommand } from "./ocr/command.js";
import { OcrFeatureStateStore } from "./ocr/feature-state.js";
import { recognizeVisualInput } from "./ocr/recognize.js";
import { writeOcrIntermediate } from "./ocr/intermediate.js";

const DISCLAIMER = "TransX CLI — DLX 翻译工具";

const HELP = `${DISCLAIMER}

Usage:
  transx [command]

Commands:
  transx                       打开交互界面
  init                         初始化 DLX API Key
  translate <text>             翻译文本；未传 text 时读取 stdin
  translate --file <path>      从文件提取文本后翻译（txt/md/csv/log/docx/xlsx/pptx/pdf）
  translate --image <path>     OCR 识别后生成中间文件，确认后翻译
  languages [--json]           查看支持的源语言和目标语言
  history [options]            查看翻译历史
  history search <keyword>     搜索原文和译文
  history status               查看历史文件状态
  history clear <options>      按条数或时间清理历史
  history help                 显示历史命令帮助
  config                       查看完整配置和 API Key
  config set-key [--stdin]     隐藏输入或从 stdin 设置 API Key
  config reset <key|all>       重置 Key 或全部配置
  ocr enable [--yes]           安装图片识别翻译扩展（需要 Python 环境）
  ocr status [--json]          查看 OCR 扩展状态
  ocr recognize <path>         仅识别图片文字
  ocr remove [--yes]           删除 OCR 扩展
  install [--force]            安装到用户目录并加入 PATH
  version [--check]            显示版本，可检查 npm 最新版本
  update                       从 npm Registry 更新到最新版
  help                         显示帮助

Translate Options:
  -t, --to <lang>              目标语言（必填）
  -s, --source <lang>          源语言（默认 auto）
  -f, --file <path>            从文件提取文本翻译（与位置文本互斥）
      --image <path>           OCR 识别后生成中间文件，确认后翻译
  -o, --output <path>          译文文件路径
      --json                   输出适合 AI 读取的 JSON
      --timeout <seconds>      本次请求超时
  -h, --help                   显示帮助

File Limits:
  文件最大 20MB；可翻译文本最大 100000 字符；最多 500 次请求

OCR:
  需要 Python 3.10+ 环境；运行 transx ocr enable 开启
  支持图片、PDF、DOCX、PPTX、Markdown；输入最大 20MB
  识别结果保存为 <源文件名>_OCR.md，确认后进入文件翻译
  模型：PP-OCRv6 Quality（本地离线，支持中英日等 50 种语言）

Examples:
  transx init
  transx translate "Hello world" --to ZH --json
  echo "Hello world" | transx translate --to ZH --json
  transx translate --file ./readme.md --to ZH --json
  transx translate --file ./report.docx --to ZH
  transx translate --file ./report.docx --to ZH --output ./report.zh.docx
  transx translate --image ./screenshot.png --to EN --json
  transx translate --image ./scan.pdf --to EN --json
  transx ocr enable
  transx ocr recognize ./image.png --json
  transx languages --json
  transx history --limit 20
  transx history --from "2026-08-01" --to "2026-08-03"
  transx history search "环境审查" --json
  transx history clear --older-than 30d --yes
`;

interface TranslateArguments {
  text?: string;
  file?: string;
  image?: string;
  output?: string;
  target?: string;
  source?: string;
  json: boolean;
  timeoutMs?: number;
}

function requireOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new TransxError("INVALID_ARGUMENT", `${option} 缺少参数值`, 2);
  }
  return value;
}

function parseTranslateArguments(args: string[]): TranslateArguments {
  const parsed: TranslateArguments = { json: false };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "-t" || arg === "--to") {
      parsed.target = requireOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "-s" || arg === "--source") {
      parsed.source = requireOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "-f" || arg === "--file") {
      parsed.file = requireOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "--image") {
      parsed.image = requireOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "-o" || arg === "--output") {
      parsed.output = requireOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "--timeout") {
      const seconds = Number(requireOptionValue(args, index, arg));
      index += 1;
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new TransxError("INVALID_ARGUMENT", "--timeout 必须是正数秒", 2);
      }
      parsed.timeoutMs = Math.round(seconds * 1000);
    } else if (arg?.startsWith("-")) {
      throw new TransxError("INVALID_ARGUMENT", `未知参数：${arg}`, 2);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  if (positional.length > 0) {
    parsed.text = positional.join(" ");
  }
  if (parsed.file && parsed.text) {
    throw new TransxError("INVALID_ARGUMENT", "--file 与位置文本不能同时使用", 2);
  }
  if (parsed.image && (parsed.file || parsed.text)) {
    throw new TransxError("INVALID_ARGUMENT", "--image 与 --file、位置文本不能同时使用", 2);
  }
  if (parsed.output && !parsed.file) {
    throw new TransxError("INVALID_ARGUMENT", "--output 只能与 --file 一起使用", 2);
  }
  return parsed;
}

async function runInit(store: ConfigStore, args: string[]): Promise<void> {
  const apiKey = args.includes("--key-stdin")
    ? await readStdin()
    : await promptSecret("DLX API Key（获取：https://connect.linux.do/）：");
  await store.setApiKey(apiKey);
  stdout.write(`配置已保存到 ${store.directory}\n`);
}

async function runConfig(store: ConfigStore, args: string[]): Promise<void> {
  const action = args[0];
  if (!action) {
    stdout.write(`${JSON.stringify(await store.statusWithApiKey(), null, 2)}\n`);
    return;
  }
  if (action === "set-key") {
    const apiKey = args.includes("--stdin")
      ? await readStdin()
      : await promptSecret("DLX API Key（获取：https://connect.linux.do/）：");
    await store.setApiKey(apiKey);
    stdout.write("API Key 已保存\n");
    return;
  }
  if (action === "reset") {
    const target = args[1];
    if (target === "key") await store.resetKey();
    else if (target === "all") await store.resetAll();
    else throw new TransxError("INVALID_ARGUMENT", "reset 仅支持 key 或 all", 2);
    stdout.write(`${target} 配置已重置\n`);
    return;
  }
  throw new TransxError("INVALID_ARGUMENT", `未知 config 操作：${action}`, 2);
}

interface FileTranslationResult {
  data: string;
  sourceLang: string;
  targetLang: string;
  provider: string;
  outputFile: string | null;
  outputFormat: string;
  fallback: boolean;
}

async function translateFile(
  store: ConfigStore,
  options: {
    filePath: string;
    target: string;
    source?: string;
    timeoutMs?: number;
    output?: string;
  },
): Promise<FileTranslationResult> {
  const config = await store.resolve();
  const prepared = await prepareFileTranslation(options.filePath);
  stderr.write(`文件翻译速度较慢，共 ${prepared.units.length} 个请求\n`);
  let sourceLang = options.source || "auto";
  let targetLang = options.target;
  let provider = "dlx";
  const results = await mapWithConcurrency(
    prepared.units,
    FILE_TRANSLATION_CONCURRENCY,
    FILE_REQUEST_DELAY_MS,
    async (unit) => {
      return await translate(config, {
        text: unit.text,
        targetLang: options.target,
        ...(options.source ? { sourceLang: options.source } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
    },
    (result, _index, completed) => {
      sourceLang = result.sourceLang;
      targetLang = result.targetLang;
      provider = result.provider;
      stderr.write(`翻译进度 ${completed}/${prepared.units.length}\n`);
    },
  );
  const translations = results.map((result) => result.data);
  const data = translatedText(prepared, translations);
  const written = await writeTranslatedFile(prepared, translations, targetLang, options.output);
  try {
    const warning = await new HistoryStore(store.directory).append({
      sourceLang,
      targetLang,
      format: "file",
      sourceFilePath: prepared.sourcePath,
      sourceFileName: path.basename(prepared.sourcePath),
      outputFilePath: written.outputPath,
      outputFileName: written.outputPath ? path.basename(written.outputPath) : null,
    });
    if (warning) stderr.write(`历史提醒：${warning}\n`);
  } catch (error) {
    stderr.write(`历史记录写入失败：${toTransxError(error).message}\n`);
  }
  return {
    data,
    sourceLang,
    targetLang,
    provider,
    outputFile: written.outputPath,
    outputFormat: prepared.outputExtension.slice(1),
    fallback: written.fallback,
  };
}

function writeFileTranslationResult(result: FileTranslationResult, json: boolean): void {
  if (json) {
    stdout.write(`${JSON.stringify({
      ok: true,
      data: result.data,
      source_lang: result.sourceLang,
      target_lang: result.targetLang,
      provider: result.provider,
      output_file: result.outputFile,
      output_format: result.outputFormat,
      fallback: result.fallback,
    })}\n`);
  } else if (result.outputFile) {
    stdout.write(`译文已保存：${result.outputFile}\n`);
  } else {
    stderr.write("无法写入译文文件，已返回文本\n");
    stdout.write(`${result.data}\n`);
  }
}

async function runTranslate(store: ConfigStore, args: string[]): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    stdout.write(HELP);
    return;
  }
  const parsed = parseTranslateArguments(args);
  if (!parsed.target) {
    throw new TransxError("INVALID_ARGUMENT", "必须通过 --to 指定目标语言", 2);
  }
  const requestedTarget = parsed.target;
  if (parsed.file) {
    const result = await translateFile(store, {
      filePath: parsed.file,
      target: requestedTarget,
      ...(parsed.source ? { source: parsed.source } : {}),
      ...(parsed.timeoutMs ? { timeoutMs: parsed.timeoutMs } : {}),
      ...(parsed.output ? { output: parsed.output } : {}),
    });
    writeFileTranslationResult(result, parsed.json);
    return;
  }
  if (parsed.image) {
    const ocrStateStore = new OcrFeatureStateStore(store.directory);
    const ocrReady = await ocrStateStore.isReady();
    if (!ocrReady) {
      if (parsed.json) {
        stdout.write(`${JSON.stringify({
          ok: false,
          error: {
            code: "OCR_NOT_INSTALLED",
            message: "图片识别翻译扩展尚未安装",
            install_command: "transx ocr enable",
          },
        })}\n`);
        process.exitCode = 6;
        return;
      }
      throw new TransxError("OCR_NOT_INSTALLED", "图片识别翻译扩展尚未安装，运行 transx ocr enable 开启", 6);
    }

    stderr.write("正在识别…\n");
    const ocrResult = await recognizeVisualInput(ocrStateStore, path.resolve(parsed.image), {
      ...(parsed.timeoutMs ? { timeoutMs: parsed.timeoutMs } : {}),
    });

    const intermediate = await writeOcrIntermediate(parsed.image, ocrResult);
    const recognition = {
      recognition_file: intermediate.path,
      preview: intermediate.preview,
      preview_truncated: intermediate.previewTruncated,
      source_count: ocrResult.sourceCount,
      item_count: ocrResult.items.length,
      ocr: {
        engine: ocrResult.engine,
        model: ocrResult.model,
        local: true,
        source_type: ocrResult.sourceType,
      },
    };
    if (parsed.json && !stdin.isTTY) {
      stdout.write(`${JSON.stringify({
        ok: true,
        data: {
          status: "awaiting_confirmation",
          translation_sent: false,
          ...recognition,
        },
      })}\n`);
      return;
    }
    const recognitionOutput = parsed.json ? stderr : stdout;
    recognitionOutput.write(
      `识别结果${intermediate.previewTruncated ? "（预览）" : ""}：\n${intermediate.preview}\n\n` +
      `识别结果文件：${intermediate.path}\n`,
    );
    if (!await promptYesNo("是否翻译该识别结果？ [y/n] ")) {
      if (parsed.json) {
        stdout.write(`${JSON.stringify({ ok: true, data: { status: "cancelled", translation_sent: false, ...recognition } })}\n`);
      } else {
        stdout.write("已取消\n");
      }
      return;
    }

    stderr.write("已确认，进入文件翻译流程…\n");
    const translated = await translateFile(store, {
      filePath: intermediate.path,
      target: requestedTarget,
      ...(parsed.source ? { source: parsed.source } : {}),
      ...(parsed.timeoutMs ? { timeoutMs: parsed.timeoutMs } : {}),
    });
    if (parsed.json) {
      stdout.write(`${JSON.stringify({
        ok: true,
        data: {
          status: "translated",
          translation_sent: true,
          ...recognition,
          translated_text: translated.data,
          source_lang: translated.sourceLang,
          target_lang: translated.targetLang,
          provider: translated.provider,
          output_file: translated.outputFile,
          output_format: translated.outputFormat,
          fallback: translated.fallback,
        },
      })}\n`);
    } else {
      writeFileTranslationResult(translated, false);
    }
    return;
  }
  const config = await store.resolve();
  const text = parsed.text || (process.stdin.isTTY ? "" : await readStdin());
  const result = await translate(config, {
    text,
    targetLang: requestedTarget,
    ...(parsed.source ? { sourceLang: parsed.source } : {}),
    ...(parsed.timeoutMs ? { timeoutMs: parsed.timeoutMs } : {}),
  });
  try {
    const warning = await new HistoryStore(store.directory).append({
      sourceLang: result.sourceLang,
      targetLang: result.targetLang,
      format: "plain",
      input: text,
      output: result.data,
    });
    if (warning) stderr.write(`历史提醒：${warning}\n`);
  } catch (error) {
    const historyError = toTransxError(error);
    stderr.write(`历史记录写入失败：${historyError.message}\n`);
  }
  if (parsed.json) {
    stdout.write(
      `${JSON.stringify({
        ok: true,
        data: result.data,
        source_lang: result.sourceLang,
        target_lang: result.targetLang,
        provider: result.provider,
      })}\n`,
    );
  } else {
    stdout.write(`${result.data}\n`);
  }
}

async function pauseInteractive(): Promise<void> {
  await promptEnterOrEscape("\nEnter 或 Esc 返回主菜单");
}

function renderInteractivePage(
  version: string,
  initialized: boolean,
  items: ReturnType<typeof getInteractiveMenuItems>,
  content: string,
): void {
  clearScreen();
  stdout.write(
    `${buildInteractiveFrame({
      version,
      initialized,
      items,
      selectedIndex: -1,
      color: !process.env.NO_COLOR,
    }).split("\n").slice(0, 12).join("\n")}\n\n${content}\n`,
  );
}

async function runInteractive(store: ConfigStore): Promise<void> {
  const packageInfo = await getPackageInfo();
  const ocrStateStore = new OcrFeatureStateStore(store.directory);
  while (true) {
    const status = await store.status();
    const ocrReady = await ocrStateStore.isReady();
    const items = getInteractiveMenuItems(status.initialized, ocrReady);
    const action = await selectInteractiveMenu({
      version: packageInfo.version,
      initialized: status.initialized,
      items,
    });
    if (!action || action === "exit") {
      clearScreen();
      stdout.write("TransX 已退出。\n");
      return;
    }

    clearScreen();
    if (action === "translate" || action === "translate_file" || action === "translate_image") {
      let continueTranslating = true;
      while (continueTranslating) {
        const pageTitle =
          action === "translate" ? "翻译文本" :
          action === "translate_file" ? "翻译文件" :
          "图片识别翻译";
        renderInteractivePage(
          packageInfo.version,
          status.initialized,
          items,
          pageTitle,
        );
        let cancelled = false;
        try {
          if (action === "translate") {
            const text = await promptText("待翻译文本：");
            const target = (await promptText("目标语言 示例：[EN/ZH]：")) || "ZH";
            await runTranslate(store, [text, "--to", target]);
          } else if (action === "translate_file") {
            const filePath = await promptText("文件路径：");
            const target = (await promptText("目标语言 示例：[EN/ZH]：")) || "ZH";
            await runTranslate(store, ["--file", filePath, "--to", target]);
          } else {
            const imagePath = await promptText("图片或文件路径：");
            const target = (await promptText("目标语言 示例：[EN/ZH]：")) || "ZH";
            await runTranslate(store, ["--image", imagePath, "--to", target]);
          }
        } catch (error) {
          const transxError = toTransxError(error);
          if (transxError.code === "CANCELLED") {
            cancelled = true;
          } else {
            stderr.write(`\n错误 [${transxError.code}]：${transxError.message}\n`);
          }
        }
        if (cancelled) break;
        continueTranslating = await promptTranslationContinue();
      }
      continue;
    }
    try {
      if (action === "ocr_enable") {
        renderInteractivePage(packageInfo.version, status.initialized, items, "安装图片识别翻译扩展");
        await runOcrCommand(store.directory, ["enable"]);
      } else if (action === "init") {
        renderInteractivePage(
          packageInfo.version,
          status.initialized,
          items,
          "重新初始化",
        );
        await runInit(store, []);
      } else if (action === "config") {
        renderInteractivePage(packageInfo.version, status.initialized, items, "当前配置");
        await runConfig(store, []);
      } else if (action === "update") {
        renderInteractivePage(packageInfo.version, status.initialized, items, "检查版本更新");
        const latest = await getLatestVersion();
        const comparison = compareVersions(latest, packageInfo.version);
        if (comparison > 0) {
          stdout.write(`当前版本：v${packageInfo.version}\nnpm 最新版本：v${latest}\n`);
          const decision = await promptEnterOrEscape("\nEnter 更新 · Esc 返回主菜单");
          if (decision === "escape") continue;
          await updateFromRegistry();
          stdout.write(`\n已更新到 v${latest}\n`);
        } else if (comparison === 0) {
          stdout.write(`已是最新版本（本地与 npm 均为 v${packageInfo.version}）\n`);
        } else {
          stdout.write(`本地版本 v${packageInfo.version} 高于 npm 当前版本 v${latest}，无需更新。\n`);
        }
      } else if (action === "help") {
        clearScreen();
        stdout.write(HELP);
      }
    } catch (error) {
      const transxError = toTransxError(error);
      if (transxError.code === "CANCELLED") continue;
      stderr.write(`\n错误 [${transxError.code}]：${transxError.message}\n`);
    }
    await pauseInteractive();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      await runInteractive(new ConfigStore());
    } else {
      stdout.write(HELP);
    }
    return;
  }
  const commandArgs = args.slice(1);
  const store = new ConfigStore();

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      stdout.write(HELP);
      return;
    case "init":
      await runInit(store, commandArgs);
      return;
    case "config":
      await runConfig(store, commandArgs);
      return;
    case "translate":
      await runTranslate(store, commandArgs);
      return;
    case "languages":
      if (commandArgs.some((arg) => arg !== "--json")) {
        throw new TransxError("INVALID_ARGUMENT", "languages 仅支持 --json", 2);
      }
      stdout.write(`${commandArgs.includes("--json") ? getLanguagesJson() : getLanguagesText()}\n`);
      return;
    case "history":
      await runHistoryCommand(store.directory, commandArgs);
      return;
    case "ocr":
      await runOcrCommand(store.directory, commandArgs);
      return;
    case "install": {
      const directory = await installCurrentPackage(commandArgs.includes("--force"));
      stdout.write(`TransX 已安装到 ${directory}\n请重新打开终端使 PATH 生效。\n`);
      return;
    }
    case "version": {
      const current = (await getPackageInfo()).version;
      stdout.write(`transx ${current}\n`);
      if (commandArgs.includes("--check")) {
        const latest = await getLatestVersion();
        const comparison = compareVersions(latest, current);
        stdout.write(
          comparison > 0
            ? `发现新版本 ${latest}，运行 transx update 更新\n`
            : comparison === 0
              ? "已是最新版本\n"
              : `本地版本 ${current} 高于 npm 当前版本 ${latest}，无需更新\n`,
        );
      }
      return;
    }
    case "update":
      await updateFromRegistry();
      stdout.write("TransX 已更新到最新版本\n");
      return;
    default:
      throw new TransxError("INVALID_ARGUMENT", `未知命令：${command}。运行 transx help 查看用法`, 2);
  }
}

main().catch((error: unknown) => {
  const transxError = toTransxError(error);
  const jsonOutput = process.argv.includes("--json");
  if (jsonOutput) {
    stderr.write(`${JSON.stringify({ ok: false, error: { code: transxError.code, message: transxError.message } })}\n`);
  } else {
    stderr.write(`错误 [${transxError.code}]：${transxError.message}\n`);
  }
  process.exitCode = transxError.exitCode;
});
