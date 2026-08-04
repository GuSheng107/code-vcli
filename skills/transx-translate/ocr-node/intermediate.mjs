import { constants as fsConstants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";

const PREVIEW_MAX_CHARS = 2_000;

function itemMetadata(item) {
  const metadata = {
    ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
    ...(item.box !== undefined ? { box: item.box } : {}),
  };
  return Object.keys(metadata).length > 0 ? `<!-- ${JSON.stringify(metadata)} -->\n` : "";
}

export function formatIntermediate(output) {
  const sections = output.sources
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

export function buildPreview(output) {
  const formatted = output.sources
    .filter((source) => source.text)
    .map((source) => `[${source.label}]\n${source.text}`)
    .join("\n\n");
  const characters = Array.from(formatted);
  if (characters.length <= PREVIEW_MAX_CHARS) return { text: formatted, truncated: false };
  return { text: `${characters.slice(0, PREVIEW_MAX_CHARS).join("")}\n…`, truncated: true };
}

export async function writeIntermediate(inputPath, output) {
  const parsed = path.parse(path.resolve(inputPath));
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
  if (!outputPath) throw new Error("无法为 OCR 识别结果分配中间文件");
  await writeFile(outputPath, formatIntermediate(output), { encoding: "utf8", flag: "wx" });
  const preview = buildPreview(output);
  return { path: outputPath, preview: preview.text, previewTruncated: preview.truncated };
}
