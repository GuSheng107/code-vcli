import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PDF_MAX_BYTES = 20 * 1024 * 1024;
const PDF_MAX_PAGES = 100;
const PDF_RENDER_SCALE = 2;
const PDF_PAGE_MAX_PIXELS = 40_000_000;

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

export async function processRenderedPdfPages(filePath, processor) {
  let fileSize;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("路径不是文件");
    fileSize = fileStat.size;
  } catch (error) {
    fail("IMAGE_READ_ERROR", `无法读取 PDF 文件：${filePath}`, error);
  }
  if (fileSize > PDF_MAX_BYTES) fail("IMAGE_TOO_LARGE", "PDF 文件大小超过限制（最大 20MB）");

  let unpdf;
  const canvasImport = async () => {
    const canvas = await import("@napi-rs/canvas");
    return { ...canvas, default: canvas };
  };
  try {
    unpdf = await import("unpdf");
    await canvasImport();
  } catch (error) {
    fail("FILE_DEPENDENCY_MISSING", "PDF 图片组件加载失败，请重新安装 Skill 依赖", error);
  }

  const source = await readFile(filePath);
  let pdf;
  try {
    pdf = await unpdf.getDocumentProxy(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  } catch (error) {
    fail("FILE_READ_ERROR", `PDF 解析失败：${error.message}`, error);
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "transx-pdf-ocr-"));
  try {
    if (pdf.numPages > PDF_MAX_PAGES) {
      fail("IMAGE_TOO_LARGE", `PDF 页数超过限制（最多 ${PDF_MAX_PAGES} 页）`);
    }
    const results = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      if (width * height > PDF_PAGE_MAX_PIXELS) {
        fail("IMAGE_TOO_LARGE", `PDF 第 ${pageNumber} 页渲染后超过 4000 万像素`);
      }

      const imagePath = path.join(temporaryDirectory, `page-${pageNumber}.png`);
      try {
        const png = await unpdf.renderPageAsImage(pdf, pageNumber, {
          canvasImport,
          scale: PDF_RENDER_SCALE,
        });
        await writeFile(imagePath, new Uint8Array(png));
      } catch (error) {
        fail("FILE_READ_ERROR", `PDF 第 ${pageNumber} 页渲染失败：${error.message}`, error);
      }

      results.push(await processor({ imagePath, page: pageNumber, pageCount: pdf.numPages }));
      await rm(imagePath, { force: true });
    }
    return results;
  } finally {
    await pdf.destroy().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
