import { prepareFileTranslation } from "./file-document.js";

export interface ExtractedFile {
  text: string;
  format: string;
}

export async function readFileForTranslation(filePath: string): Promise<ExtractedFile> {
  const prepared = await prepareFileTranslation(filePath);
  return {
    text: prepared.units.map((unit) => unit.text).join("\n"),
    format: prepared.sourceExtension.slice(1),
  };
}
