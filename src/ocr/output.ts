import type { OcrResult } from "./types.js";

export function formatOcrResult(result: OcrResult): string {
  return result.sources
    .filter((source) => source.text)
    .map((source) => `[${source.label}]\n${source.text}`)
    .join("\n\n");
}
