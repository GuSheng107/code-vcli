import { TransxError } from "../errors.js";
import { OCR_ENGINE, OCR_MODEL_DISPLAY } from "./constants.js";
import { checkImagePixels, validateImage } from "./image-validator.js";
import { runOcrRecognition } from "./python-bridge.js";
import { processVisualInputSources } from "./visual-input.js";
import type { OcrFeatureStateStore } from "./feature-state.js";
import type { OcrOptions, OcrResult, OcrSourceResult } from "./types.js";

export async function recognizeImage(
  stateStore: OcrFeatureStateStore,
  imagePath: string,
  options?: OcrOptions,
): Promise<OcrResult> {
  return recognizeVisualInput(stateStore, imagePath, options);
}

export async function recognizeVisualInput(
  stateStore: OcrFeatureStateStore,
  inputPath: string,
  options?: OcrOptions,
): Promise<OcrResult> {
  const processed = await processVisualInputSources(inputPath, async (source) => {
    try {
      await validateImage(source.imagePath);
      await checkImagePixels(source.imagePath);
      const result = await runOcrRecognition(stateStore, source.imagePath, options);
      const items = result.items.map((item) => ({
        ...item,
        sourceIndex: source.sourceIndex,
        source: source.label,
        ...(source.page ? { page: source.page } : {}),
        ...(source.slides ? { slides: source.slides } : {}),
      }));
      return {
        sourceIndex: source.sourceIndex,
        label: source.label,
        kind: source.kind,
        ...(source.page ? { page: source.page } : {}),
        ...(source.slides ? { slides: source.slides } : {}),
        ...(source.embeddedPath ? { embeddedPath: source.embeddedPath } : {}),
        text: result.text,
        items,
      } satisfies OcrSourceResult;
    } catch (error) {
      if (error instanceof TransxError && error.code === "OCR_TEXT_EMPTY") {
        return {
          sourceIndex: source.sourceIndex,
          label: source.label,
          kind: source.kind,
          ...(source.page ? { page: source.page } : {}),
          ...(source.slides ? { slides: source.slides } : {}),
          ...(source.embeddedPath ? { embeddedPath: source.embeddedPath } : {}),
          text: "",
          items: [],
        } satisfies OcrSourceResult;
      }
      throw error;
    }
  });
  const items = processed.results.flatMap((source) => source.items);
  if (items.length === 0) {
    throw new TransxError("OCR_TEXT_EMPTY", "未识别到文字", 6);
  }

  return {
    text: processed.results.map((source) => source.text).filter(Boolean).join("\n\n"),
    items,
    sources: processed.results,
    sourceCount: processed.results.length,
    sourceType: processed.sourceType,
    engine: OCR_ENGINE,
    model: OCR_MODEL_DISPLAY,
  };
}
