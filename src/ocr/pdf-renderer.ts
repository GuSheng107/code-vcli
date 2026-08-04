import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TransxError } from "../errors.js";
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  OCR_PDF_EXTENSION,
  OCR_PDF_MAX_PAGES,
  OCR_PDF_RENDER_SCALE,
} from "./constants.js";

export interface RenderedPdfPage {
  imagePath: string;
  page: number;
  pageCount: number;
  width: number;
  height: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function processRenderedPdfPages<T>(
  filePath: string,
  processor: (page: RenderedPdfPage) => Promise<T>,
): Promise<T[]> {
  if (path.extname(filePath).toLowerCase() !== OCR_PDF_EXTENSION) {
    throw new TransxError("IMAGE_FORMAT_UNSUPPORTED", "PDF 页面渲染仅支持 .pdf 文件", 2);
  }

  let fileSize: number;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("路径不是文件");
    fileSize = fileStat.size;
  } catch (error) {
    throw new TransxError("IMAGE_READ_ERROR", `无法读取 PDF 文件：${filePath}`, 2, { cause: error });
  }
  if (fileSize > IMAGE_MAX_BYTES) {
    throw new TransxError("IMAGE_TOO_LARGE", "PDF 文件大小超过限制（最大 20MB）", 2);
  }

  let unpdf: typeof import("unpdf");
  const canvasImport = async () => {
    const canvas = await import("@napi-rs/canvas");
    return { ...canvas, default: canvas };
  };
  try {
    unpdf = await import("unpdf");
    await canvasImport();
  } catch (error) {
    throw new TransxError(
      "FILE_DEPENDENCY_MISSING",
      "PDF 图片组件加载失败，请重新安装 TransX",
      7,
      { cause: error },
    );
  }

  const source = await readFile(filePath);
  let pdf: Awaited<ReturnType<typeof unpdf.getDocumentProxy>>;
  try {
    pdf = await unpdf.getDocumentProxy(
      new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
    );
  } catch (error) {
    throw new TransxError("FILE_READ_ERROR", `PDF 解析失败：${errorMessage(error)}`, 7, {
      cause: error,
    });
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "transx-pdf-ocr-"));
  try {
    if (pdf.numPages > OCR_PDF_MAX_PAGES) {
      throw new TransxError(
        "IMAGE_TOO_LARGE",
        `PDF 页数超过限制（最多 ${OCR_PDF_MAX_PAGES} 页）`,
        2,
      );
    }

    const results: T[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: OCR_PDF_RENDER_SCALE });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      if (width * height > IMAGE_MAX_PIXELS) {
        throw new TransxError(
          "IMAGE_TOO_LARGE",
          `PDF 第 ${pageNumber} 页渲染后超过 4000 万像素`,
          2,
        );
      }

      const imagePath = path.join(temporaryDirectory, `page-${pageNumber}.png`);
      try {
        const png = await unpdf.renderPageAsImage(pdf, pageNumber, {
          canvasImport,
          scale: OCR_PDF_RENDER_SCALE,
        });
        await writeFile(imagePath, new Uint8Array(png));
      } catch (error) {
        if (error instanceof TransxError) throw error;
        throw new TransxError(
          "FILE_READ_ERROR",
          `PDF 第 ${pageNumber} 页渲染失败：${errorMessage(error)}`,
          7,
          { cause: error },
        );
      }

      results.push(await processor({
        imagePath,
        page: pageNumber,
        pageCount: pdf.numPages,
        width,
        height,
      }));
      await rm(imagePath, { force: true });
    }
    return results;
  } finally {
    await pdf.destroy().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
