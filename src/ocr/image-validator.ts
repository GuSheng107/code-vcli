import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS, OCR_SUPPORTED_EXTENSIONS } from "./constants.js";
import { TransxError } from "../errors.js";

export interface ImageValidation {
  valid: boolean;
  extension: string;
  sizeBytes: number;
}

export function isSupportedImage(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return (OCR_SUPPORTED_EXTENSIONS as readonly string[]).includes(ext);
}

export async function validateImage(filePath: string): Promise<ImageValidation> {
  const ext = path.extname(filePath).toLowerCase();
  if (!(OCR_SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new TransxError("IMAGE_FORMAT_UNSUPPORTED", `不支持的图片格式：${ext || "无扩展名"}`, 2);
  }

  let sizeBytes: number;
  try {
    const stats = await stat(filePath);
    sizeBytes = stats.size;
  } catch {
    throw new TransxError("IMAGE_READ_ERROR", `无法读取图片文件：${filePath}`, 2);
  }

  if (sizeBytes > IMAGE_MAX_BYTES) {
    const maxMB = Math.round(IMAGE_MAX_BYTES / 1024 / 1024);
    throw new TransxError("IMAGE_TOO_LARGE", `图片大小超过限制（最大 ${maxMB}MB）`, 2);
  }

  return { valid: true, extension: ext, sizeBytes };
}

export async function checkImagePixels(filePath: string): Promise<void> {
  try {
    const buffer = await readFile(filePath);
    const dimensions = parseImageDimensions(buffer, filePath);
    if (dimensions) {
      const pixels = dimensions.width * dimensions.height;
      if (pixels > IMAGE_MAX_PIXELS) {
        const maxMP = Math.round(IMAGE_MAX_PIXELS / 1_000_000);
        throw new TransxError("IMAGE_TOO_LARGE", `图片像素超过限制（最大 ${maxMP} 百万像素）`, 2);
      }
    }
  } catch (error) {
    if (error instanceof TransxError) throw error;
    // 如果无法解析图片头，跳过像素检查，交给 OCR 引擎处理
  }
}

interface ImageDimensions {
  width: number;
  height: number;
}

function parseImageDimensions(buffer: Buffer, filePath: string): ImageDimensions | null {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".png") return parsePngDimensions(buffer);
    if (ext === ".jpg" || ext === ".jpeg") return parseJpegDimensions(buffer);
    if (ext === ".webp") return parseWebpDimensions(buffer);
    if (ext === ".bmp") return parseBmpDimensions(buffer);
    if (ext === ".tiff" || ext === ".tif") return parseTiffDimensions(buffer);
  } catch {
    return null;
  }
  return null;
}

function parsePngDimensions(buffer: Buffer): ImageDimensions {
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("invalid PNG header");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function parseJpegDimensions(buffer: Buffer): ImageDimensions {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    const length = buffer.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  throw new Error("invalid JPEG header");
}

function parseWebpDimensions(buffer: Buffer): ImageDimensions {
  if (buffer.length < 30) throw new Error("invalid WebP header");
  const chunkType = buffer.toString("ascii", 12, 16);
  if (chunkType === "VP8 ") {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunkType === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunkType === "VP8X") {
    return {
      width: (buffer.readUInt32LE(24) & 0xffffff) + 1,
      height: (buffer.readUInt32LE(27) & 0xffffff) + 1,
    };
  }
  throw new Error("unsupported WebP variant");
}

function parseBmpDimensions(buffer: Buffer): ImageDimensions {
  if (buffer.length < 26) throw new Error("invalid BMP header");
  return {
    width: Math.abs(buffer.readInt32LE(18)),
    height: Math.abs(buffer.readInt32LE(22)),
  };
}

function parseTiffDimensions(buffer: Buffer): ImageDimensions {
  if (buffer.length < 8) throw new Error("invalid TIFF header");
  const littleEndian = buffer.toString("ascii", 0, 2) === "II";
  const readU16 = (offset: number): number =>
    littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const readU32 = (offset: number): number =>
    littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);

  const ifdOffset = readU32(4);
  if (ifdOffset + 2 > buffer.length) throw new Error("invalid IFD offset");

  const entryCount = readU16(ifdOffset);
  let width = 0;
  let height = 0;
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    if (entryOffset + 12 > buffer.length) break;
    const tag = readU16(entryOffset);
    const value = readU32(entryOffset + 8);
    if (tag === 256) width = value;
    else if (tag === 257) height = value;
  }
  if (width === 0 || height === 0) throw new Error("TIFF dimensions not found");
  return { width, height };
}
