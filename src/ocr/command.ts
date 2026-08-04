import { stderr, stdout } from "node:process";
import path from "node:path";

import { OCR_ENGINE, OCR_LANGUAGES, OCR_MODEL_DISPLAY, OCR_MODEL_ID } from "./constants.js";
import { TransxError } from "../errors.js";
import { OcrFeatureStateStore } from "./feature-state.js";
import { installOcrFeature, removeOcrFeature } from "./feature-installer.js";
import { recognizeVisualInput } from "./recognize.js";
import { promptText, promptYesNo } from "../input.js";
import { writeOcrIntermediate } from "./intermediate.js";
import type { OcrStatusOutput } from "./types.js";

const OCR_HELP = `TransX OCR — 图片文字识别

Usage:
  transx ocr enable [--yes]       交互确认并安装 OCR 扩展
  transx ocr status [--json]      查看扩展状态
  transx ocr recognize <path>     识别文字并生成中间文件
  transx ocr recognize <path> --json
  transx ocr remove [--yes]       删除 OCR 扩展
  transx ocr help                 显示此帮助

模型：${OCR_MODEL_DISPLAY}
语言：${OCR_LANGUAGES}
方式：本地离线 OCR，原文件不会上传
`;

export async function runOcrCommand(
  configRoot: string,
  args: string[],
): Promise<void> {
  const subcommand = args[0];
  const stateStore = new OcrFeatureStateStore(configRoot);

  switch (subcommand) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      stdout.write(OCR_HELP);
      return;

    case "enable": {
      const yes = args.includes("--yes");
      const result = await installOcrFeature(stateStore, {
        yes,
        prompt: promptText,
      });
      stdout.write(`${result.message}\n`);
      return;
    }

    case "status": {
      const json = args.includes("--json");
      const state = await stateStore.read();
      const output: OcrStatusOutput = {
        installed: state?.status === "ready" && state.verified,
        status: state?.status ?? "disabled",
        model: state?.model ?? OCR_MODEL_ID,
        modelDisplay: state?.model_display ?? OCR_MODEL_DISPLAY,
        engine: state?.engine ?? OCR_ENGINE,
        directory: stateStore.featureDirectory,
        platform: state?.platform ?? process.platform,
        arch: state?.arch ?? process.arch,
        installedAt: state?.installed_at ?? null,
        verified: state?.verified ?? false,
      };
      if (json) {
        stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      } else {
        stdout.write(formatStatusText(output));
      }
      return;
    }

    case "recognize": {
      const json = args.includes("--json");
      const imagePath = args.find((arg) => !arg.startsWith("-") && arg !== "recognize");
      if (!imagePath) {
        throw new TransxError("INVALID_ARGUMENT", "请指定图片或文件路径：transx ocr recognize <path>", 2);
      }
      const ready = await stateStore.isReady();
      if (!ready) {
        if (json) {
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
      const result = await recognizeVisualInput(stateStore, path.resolve(imagePath));
      const intermediate = await writeOcrIntermediate(imagePath, result);
      if (json) {
        stdout.write(`${JSON.stringify({
          ok: true,
          data: {
            recognition_file: intermediate.path,
            preview: intermediate.preview,
            preview_truncated: intermediate.previewTruncated,
            source_count: result.sourceCount,
            item_count: result.items.length,
            ocr: {
              engine: result.engine,
              model: result.model,
              local: true,
              source_type: result.sourceType,
            },
          },
        }, null, 2)}\n`);
      } else {
        stdout.write(
          `识别结果${intermediate.previewTruncated ? "（预览）" : ""}：\n${intermediate.preview}\n\n` +
          `识别结果文件：${intermediate.path}\n`,
        );
        if (result.items.some((item) => item.confidence !== undefined)) {
          const avgConfidence = result.items
            .filter((item) => item.confidence !== undefined)
            .reduce((sum, item) => sum + (item.confidence ?? 0), 0) /
            result.items.filter((item) => item.confidence !== undefined).length;
          stderr.write(`平均置信度：${(avgConfidence * 100).toFixed(1)}%\n`);
        }
      }
      return;
    }

    case "remove": {
      const yes = args.includes("--yes");
      if (!yes) {
        if (!await promptYesNo("确定删除图片识别翻译扩展？ [y/n] ")) {
          stdout.write("已取消\n");
          return;
        }
      }
      await removeOcrFeature(stateStore);
      stdout.write("图片识别翻译扩展已删除\n");
      return;
    }

    default:
      throw new TransxError("INVALID_ARGUMENT", `未知 ocr 操作：${subcommand}。运行 transx ocr help 查看用法`, 2);
  }
}

function formatStatusText(output: OcrStatusOutput): string {
  const lines = [
    `状态：${output.installed ? "已安装" : output.status}`,
    `模型：${output.modelDisplay}`,
    `引擎：${output.engine}`,
    `安装位置：${output.directory}`,
    `平台：${output.platform} ${output.arch}`,
  ];
  if (output.installedAt) {
    lines.push(`安装时间：${output.installedAt}`);
  }
  lines.push(`验证：${output.verified ? "通过" : "未验证"}`);
  return `${lines.join("\n")}\n`;
}
