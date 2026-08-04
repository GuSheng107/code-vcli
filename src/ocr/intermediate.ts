import { constants as fsConstants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";

import { TransxError } from "../errors.js";
import { OCR_INLINE_PREVIEW_MAX_CHARS } from "./constants.js";
import { formatOcrResult } from "./output.js";
import type { OcrItem, OcrResult } from "./types.js";

export interface OcrIntermediateFile {
  path: string;
  preview: string;
  previewTruncated: boolean;
}

function itemMetadata(item: OcrItem): string {
  const metadata = {
    ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
    ...(item.box !== undefined ? { box: item.box } : {}),
  };
  return Object.keys(metadata).length > 0 ? `<!-- ${JSON.stringify(metadata)} -->\n` : "";
}

export function formatOcrIntermediate(result: OcrResult): string {
  const sections = result.sources
    .filter((source) => source.items.length > 0)
    .map((source) => {
      const sourceMetadata = {
        sourceIndex: source.sourceIndex,
        kind: source.kind,
        ...(source.page !== undefined ? { page: source.page } : {}),
        ...(source.slides !== undefined ? { slides: source.slides } : {}),
        ...(source.embeddedPath !== undefined ? { embeddedPath: source.embeddedPath } : {}),
      };
      const items = source.items
        .map((item) => `${itemMetadata(item)}${item.text}`)
        .join("\n\n");
      return `## ${source.label}\n\n<!-- ${JSON.stringify(sourceMetadata)} -->\n\n${items}`;
    });
  return `${sections.join("\n\n")}\n`;
}

export function buildOcrPreview(result: OcrResult): { text: string; truncated: boolean } {
  const formatted = formatOcrResult(result);
  const characters = Array.from(formatted);
  if (characters.length <= OCR_INLINE_PREVIEW_MAX_CHARS) {
    return { text: formatted, truncated: false };
  }
  return {
    text: `${characters.slice(0, OCR_INLINE_PREVIEW_MAX_CHARS).join("")}\n…`,
    truncated: true,
  };
}

export async function writeOcrIntermediate(
  inputPath: string,
  result: OcrResult,
): Promise<OcrIntermediateFile> {
  const resolvedInput = path.resolve(inputPath);
  const parsed = path.parse(resolvedInput);
  let outputPath = "";
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const index = suffix === 0 ? "" : `.${suffix}`;
    const candidate = path.join(parsed.dir, `${parsed.name}_OCR${index}.md`);
    try {
      await access(candidate, fsConstants.F_OK);
    } catch {
      outputPath = candidate;
      break;
    }
  }
  if (!outputPath) {
    throw new TransxError("FILE_WRITE_ERROR", "无法为 OCR 识别结果分配中间文件", 7);
  }

  try {
    await writeFile(outputPath, formatOcrIntermediate(result), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    throw new TransxError("FILE_WRITE_ERROR", `无法写入 OCR 识别结果：${outputPath}`, 7, { cause: error });
  }

  const preview = buildOcrPreview(result);
  return { path: outputPath, preview: preview.text, previewTruncated: preview.truncated };
}
