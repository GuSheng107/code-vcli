import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { unzipSync, type Unzipped } from "fflate";

import { FILE_MAX_BYTES, OFFICE_ARCHIVE_MAX_BYTES } from "../constants.js";
import { TransxError } from "../errors.js";
import {
  IMAGE_MAX_BYTES,
  OCR_MAX_SOURCES,
  OCR_SUPPORTED_DOCUMENT_EXTENSIONS,
} from "./constants.js";
import { isSupportedImage } from "./image-validator.js";
import { processRenderedPdfPages } from "./pdf-renderer.js";
import type { OcrSourceType } from "./types.js";

export interface VisualInputSource {
  imagePath: string;
  sourceIndex: number;
  label: string;
  kind: "image" | "page" | "embedded-image";
  page?: number;
  slides?: number[];
  embeddedPath?: string;
}

export interface VisualInputResults<T> {
  sourceType: OcrSourceType;
  results: T[];
}

async function validateInputFile(filePath: string): Promise<void> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("路径不是文件");
    if (fileStat.size > FILE_MAX_BYTES) {
      throw new TransxError("IMAGE_TOO_LARGE", "OCR 输入超过 20MB", 2);
    }
  } catch (error) {
    if (error instanceof TransxError) throw error;
    throw new TransxError("IMAGE_READ_ERROR", `无法读取 OCR 输入：${filePath}`, 2, { cause: error });
  }
}

function sourceTypeForExtension(extension: string): OcrSourceType | null {
  if (extension === ".pdf") return "pdf";
  if (extension === ".docx") return "docx";
  if (extension === ".pptx") return "pptx";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  return null;
}

async function processTemporaryImages<T>(
  entries: Array<{ data: Uint8Array; extension: string; label: string; embeddedPath: string; slides?: number[] }>,
  processor: (source: VisualInputSource) => Promise<T>,
): Promise<T[]> {
  if (entries.length > OCR_MAX_SOURCES) {
    throw new TransxError("IMAGE_TOO_LARGE", `文件内图片超过 ${OCR_MAX_SOURCES} 张`, 2);
  }
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "transx-ocr-input-"));
  try {
    const results: T[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      if (entry.data.byteLength > IMAGE_MAX_BYTES) {
        throw new TransxError("IMAGE_TOO_LARGE", `${entry.label} 超过 20MB`, 2);
      }
      const imagePath = path.join(temporaryDirectory, `image-${index + 1}${entry.extension}`);
      await writeFile(imagePath, entry.data);
      results.push(await processor({
        imagePath,
        sourceIndex: index + 1,
        label: entry.label,
        kind: "embedded-image",
        embeddedPath: entry.embeddedPath,
        ...(entry.slides ? { slides: entry.slides } : {}),
      }));
      await rm(imagePath, { force: true });
    }
    return results;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function readOfficeArchive(source: Uint8Array, extension: ".docx" | ".pptx"): Unzipped {
  let unpackedBytes = 0;
  try {
    return unzipSync(source, {
      filter(entry) {
        unpackedBytes += entry.originalSize;
        if (unpackedBytes > OFFICE_ARCHIVE_MAX_BYTES) {
          throw new TransxError("IMAGE_TOO_LARGE", "Office 文档解压后超过 200MB", 2);
        }
        return extension === ".docx"
          ? entry.name.startsWith("word/media/")
          : entry.name.startsWith("ppt/media/") || /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(entry.name);
      },
    });
  } catch (error) {
    if (error instanceof TransxError) throw error;
    throw new TransxError("FILE_READ_ERROR", "Office 文件不是有效的 Open XML 文档", 7, { cause: error });
  }
}

function pptSlidesByImage(files: Unzipped): Map<string, number[]> {
  const result = new Map<string, number[]>();
  const decoder = new TextDecoder();
  for (const [name, data] of Object.entries(files)) {
    const slide = name.match(/^ppt\/slides\/_rels\/slide(\d+)\.xml\.rels$/)?.[1];
    if (!slide) continue;
    const xml = decoder.decode(data);
    for (const match of xml.matchAll(/<Relationship\b[^>]*\bTarget=["']([^"']+)["'][^>]*>/g)) {
      const target = match[1];
      if (!target || /^(?:https?:|\/\/)/i.test(target)) continue;
      const mediaPath = path.posix.normalize(path.posix.join("ppt/slides", target));
      const slides = result.get(mediaPath) ?? [];
      slides.push(Number(slide));
      result.set(mediaPath, slides);
    }
  }
  return result;
}

async function processOfficeImages<T>(
  filePath: string,
  extension: ".docx" | ".pptx",
  processor: (source: VisualInputSource) => Promise<T>,
): Promise<T[]> {
  const buffer = await readFile(filePath);
  const files = readOfficeArchive(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    extension,
  );
  const slidesByImage = extension === ".pptx" ? pptSlidesByImage(files) : new Map<string, number[]>();
  const prefix = extension === ".docx" ? "word/media/" : "ppt/media/";
  const images = Object.entries(files)
    .filter(([name]) => name.startsWith(prefix) && isSupportedImage(name))
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  const entries = images.map(([name, data], index) => {
    const slides = slidesByImage.get(name)?.sort((a, b) => a - b);
    const label = extension === ".docx"
      ? `文档图片 ${index + 1}`
      : slides?.length
        ? `幻灯片 ${slides.join("、")} · 图片 ${index + 1}`
        : `演示文稿图片 ${index + 1}`;
    return {
      data,
      extension: path.extname(name).toLowerCase(),
      label,
      embeddedPath: name,
      ...(slides?.length ? { slides } : {}),
    };
  });
  if (entries.length === 0) throw new TransxError("OCR_TEXT_EMPTY", "文件中没有可识别的图片", 6);
  return processTemporaryImages(entries, processor);
}

function markdownImageTargets(source: string): string[] {
  const targets: string[] = [];
  for (const match of source.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)) {
    const target = match[1] ?? match[2];
    if (target) targets.push(target);
  }
  for (const match of source.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    if (match[1]) targets.push(match[1]);
  }
  return [...new Set(targets)];
}

async function processMarkdownImages<T>(
  filePath: string,
  processor: (source: VisualInputSource) => Promise<T>,
): Promise<T[]> {
  const source = await readFile(filePath, "utf8");
  const entries: Array<{ data: Uint8Array; extension: string; label: string; embeddedPath: string }> = [];
  for (const rawTarget of markdownImageTargets(source)) {
    if (/^(?:https?:|\/\/)/i.test(rawTarget)) continue;
    const dataMatch = rawTarget.match(/^data:image\/(png|jpe?g|webp|bmp|tiff);base64,(.+)$/is);
    if (dataMatch) {
      const extension = dataMatch[1]?.toLowerCase() === "jpeg" ? ".jpg" : `.${dataMatch[1]?.toLowerCase()}`;
      entries.push({
        data: Buffer.from(dataMatch[2] ?? "", "base64"),
        extension,
        label: `Markdown 图片 ${entries.length + 1}`,
        embeddedPath: "data:image",
      });
      continue;
    }
    let target = rawTarget.replace(/\\([\\()[\] ])/g, "$1").split(/[?#]/, 1)[0] ?? "";
    try { target = decodeURIComponent(target); } catch { /* 保留原路径 */ }
    const imagePath = path.resolve(path.dirname(filePath), target);
    if (!isSupportedImage(imagePath)) continue;
    const data = await readFile(imagePath).catch((error: unknown) => {
      throw new TransxError("IMAGE_READ_ERROR", `无法读取 Markdown 图片：${target}`, 2, { cause: error });
    });
    entries.push({
      data,
      extension: path.extname(imagePath).toLowerCase(),
      label: `Markdown 图片 ${entries.length + 1} · ${path.basename(imagePath)}`,
      embeddedPath: target,
    });
  }
  if (entries.length === 0) throw new TransxError("OCR_TEXT_EMPTY", "Markdown 中没有本地可识别图片", 6);
  return processTemporaryImages(entries, processor);
}

export async function processVisualInputSources<T>(
  inputPath: string,
  processor: (source: VisualInputSource) => Promise<T>,
): Promise<VisualInputResults<T>> {
  inputPath = path.resolve(inputPath);
  await validateInputFile(inputPath);
  const extension = path.extname(inputPath).toLowerCase();
  if (isSupportedImage(inputPath)) {
    return {
      sourceType: "image",
      results: [await processor({ imagePath: inputPath, sourceIndex: 1, label: "图片", kind: "image" })],
    };
  }
  const sourceType = sourceTypeForExtension(extension);
  if (!sourceType || !(OCR_SUPPORTED_DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new TransxError("IMAGE_FORMAT_UNSUPPORTED", `不支持的 OCR 输入格式：${extension || "无扩展名"}`, 2);
  }
  if (sourceType === "pdf") {
    const results = await processRenderedPdfPages(inputPath, ({ imagePath, page }) => processor({
      imagePath,
      sourceIndex: page,
      label: `第 ${page} 页`,
      kind: "page",
      page,
    }));
    return { sourceType, results };
  }
  if (sourceType === "docx" || sourceType === "pptx") {
    return { sourceType, results: await processOfficeImages(inputPath, `.${sourceType}`, processor) };
  }
  return { sourceType, results: await processMarkdownImages(inputPath, processor) };
}
