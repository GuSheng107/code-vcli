import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { unzipSync } from "fflate";
import { processRenderedPdfPages } from "./pdf-renderer.mjs";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif"]);
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SOURCES = 100;
const OFFICE_MAX_BYTES = 200 * 1024 * 1024;

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

function supportedImage(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function validateInput(filePath) {
  let fileStat;
  try { fileStat = await stat(filePath); }
  catch (error) { fail("IMAGE_READ_ERROR", `无法读取 OCR 输入：${filePath}`, error); }
  if (!fileStat.isFile()) fail("IMAGE_READ_ERROR", `路径不是文件：${filePath}`);
  if (fileStat.size > MAX_BYTES) fail("IMAGE_TOO_LARGE", "OCR 输入超过 20MB");
}

async function processEntries(entries, processor) {
  if (!entries.length) fail("OCR_TEXT_EMPTY", "文件中没有可识别的图片");
  if (entries.length > MAX_SOURCES) fail("IMAGE_TOO_LARGE", `文件内图片超过 ${MAX_SOURCES} 张`);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "transx-ocr-input-"));
  try {
    const results = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.data.length > MAX_BYTES) fail("IMAGE_TOO_LARGE", `${entry.label} 超过 20MB`);
      const imagePath = path.join(temporaryDirectory, `image-${index + 1}${entry.extension}`);
      await writeFile(imagePath, entry.data);
      results.push(await processor({
        imagePath,
        sourceIndex: index + 1,
        label: entry.label,
        kind: "embedded-image",
        embeddedPath: entry.embeddedPath,
        ...(entry.page ? { page: entry.page } : {}),
        ...(entry.slides ? { slides: entry.slides } : {}),
      }));
      await rm(imagePath, { force: true });
    }
    return results;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function officeFiles(source, extension) {
  let unpacked = 0;
  try {
    return unzipSync(source, {
      filter(entry) {
        unpacked += entry.originalSize;
        if (unpacked > OFFICE_MAX_BYTES) fail("IMAGE_TOO_LARGE", "Office 文档解压后超过 200MB");
        return extension === ".docx"
          ? entry.name.startsWith("word/media/")
          : entry.name.startsWith("ppt/media/") || /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(entry.name);
      },
    });
  } catch (error) {
    if (error?.code) throw error;
    fail("FILE_READ_ERROR", "Office 文件不是有效的 Open XML 文档", error);
  }
}

function slideImages(files) {
  const map = new Map();
  for (const [name, data] of Object.entries(files)) {
    const slide = name.match(/^ppt\/slides\/_rels\/slide(\d+)\.xml\.rels$/)?.[1];
    if (!slide) continue;
    const xml = new TextDecoder().decode(data);
    for (const match of xml.matchAll(/<Relationship\b[^>]*\bTarget=["']([^"']+)["'][^>]*>/g)) {
      const target = match[1];
      if (!target || /^(?:https?:|\/\/)/i.test(target)) continue;
      const media = path.posix.normalize(path.posix.join("ppt/slides", target));
      const slides = map.get(media) || [];
      slides.push(Number(slide));
      map.set(media, slides);
    }
  }
  return map;
}

async function processOffice(filePath, extension, processor) {
  const source = await readFile(filePath);
  const files = officeFiles(new Uint8Array(source.buffer, source.byteOffset, source.byteLength), extension);
  const slideMap = extension === ".pptx" ? slideImages(files) : new Map();
  const prefix = extension === ".docx" ? "word/media/" : "ppt/media/";
  const images = Object.entries(files).filter(([name]) => name.startsWith(prefix) && supportedImage(name)).sort(([a], [b]) => a.localeCompare(b));
  const entries = images.map(([name, data], index) => {
    const slides = slideMap.get(name)?.sort((a, b) => a - b);
    const label = extension === ".docx"
      ? `文档图片 ${index + 1}`
      : slides?.length ? `幻灯片 ${slides.join("、")} · 图片 ${index + 1}` : `演示文稿图片 ${index + 1}`;
    return { data, extension: path.extname(name).toLowerCase(), label, embeddedPath: name, ...(slides?.length ? { slides } : {}) };
  });
  return processEntries(entries, processor);
}

function markdownTargets(source) {
  const targets = [];
  for (const match of source.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)) targets.push(match[1] || match[2]);
  for (const match of source.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) targets.push(match[1]);
  return [...new Set(targets.filter(Boolean))];
}

async function processMarkdown(filePath, processor) {
  const source = await readFile(filePath, "utf8");
  const entries = [];
  for (const raw of markdownTargets(source)) {
    if (/^(?:https?:|\/\/)/i.test(raw)) continue;
    const dataUri = raw.match(/^data:image\/(png|jpe?g|webp|bmp|tiff);base64,(.+)$/is);
    if (dataUri) {
      const extension = dataUri[1].toLowerCase() === "jpeg" ? ".jpg" : `.${dataUri[1].toLowerCase()}`;
      entries.push({ data: Buffer.from(dataUri[2], "base64"), extension, label: `Markdown 图片 ${entries.length + 1}`, embeddedPath: "data:image" });
      continue;
    }
    let target = raw.replace(/\\([\\()[\] ])/g, "$1").split(/[?#]/, 1)[0] || "";
    try { target = decodeURIComponent(target); } catch { /* use original */ }
    const imagePath = path.resolve(path.dirname(filePath), target);
    if (!supportedImage(imagePath)) continue;
    let data;
    try { data = await readFile(imagePath); } catch (error) { fail("IMAGE_READ_ERROR", `无法读取 Markdown 图片：${target}`, error); }
    entries.push({ data, extension: path.extname(imagePath).toLowerCase(), label: `Markdown 图片 ${entries.length + 1} · ${path.basename(imagePath)}`, embeddedPath: target });
  }
  return processEntries(entries, processor);
}

export async function processVisualInputSources(inputPath, processor) {
  inputPath = path.resolve(inputPath);
  await validateInput(inputPath);
  const extension = path.extname(inputPath).toLowerCase();
  if (supportedImage(inputPath)) return { sourceType: "image", results: [await processor({ imagePath: inputPath, sourceIndex: 1, label: "图片", kind: "image" })] };
  if (extension === ".pdf") {
    const results = await processRenderedPdfPages(inputPath, ({ imagePath, page }) => processor({ imagePath, sourceIndex: page, label: `第 ${page} 页`, kind: "page", page }));
    return { sourceType: "pdf", results };
  }
  if (extension === ".docx" || extension === ".pptx") return { sourceType: extension.slice(1), results: await processOffice(inputPath, extension, processor) };
  if (extension === ".md" || extension === ".markdown") return { sourceType: "markdown", results: await processMarkdown(inputPath, processor) };
  fail("IMAGE_FORMAT_UNSUPPORTED", `不支持的 OCR 输入格式：${extension || "无扩展名"}`);
}
