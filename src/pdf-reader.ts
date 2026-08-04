// PDF 文本提取：按需加载 unpdf，避免普通文本翻译承担 PDF 初始化开销。
import { readFile } from "node:fs/promises";

import { TransxError } from "./errors.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readPdfPages(filePath: string): Promise<string[]> {
  let unpdf: typeof import("unpdf");
  try {
    unpdf = await import("unpdf");
  } catch (error) {
    throw new TransxError(
      "FILE_DEPENDENCY_MISSING",
      "PDF 组件加载失败，请重新安装 TransX",
      7,
      { cause: error },
    );
  }

  try {
    const buffer = await readFile(filePath);
    const pdf = await unpdf.getDocumentProxy(
      new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    );
    const result = await unpdf.extractText(pdf, { mergePages: false });
    return result.text.map((page) => page.trim());
  } catch (error) {
    throw new TransxError("FILE_READ_ERROR", `PDF 解析失败：${errorMessage(error)}`, 7, {
      cause: error,
    });
  }
}
