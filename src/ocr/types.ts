export interface OcrItem {
  text: string;
  confidence?: number;
  box?: Array<[number, number]>;
  page?: number;
  slides?: number[];
  sourceIndex?: number;
  source?: string;
}

export type OcrSourceType = "image" | "pdf" | "docx" | "pptx" | "markdown";

export interface OcrSourceResult {
  sourceIndex: number;
  label: string;
  kind: "image" | "page" | "embedded-image";
  page?: number;
  slides?: number[];
  embeddedPath?: string;
  text: string;
  items: OcrItem[];
}

export interface OcrRecognitionResult {
  text: string;
  items: OcrItem[];
  engine: "rapidocr-openvino";
  model: "PP-OCRv6 Quality";
}

export interface OcrResult {
  text: string;
  items: OcrItem[];
  sources: OcrSourceResult[];
  sourceCount: number;
  sourceType: OcrSourceType;
  engine: "rapidocr-openvino";
  model: "PP-OCRv6 Quality";
}

export interface OcrOptions {
  timeoutMs?: number;
}

export type OcrFeatureStatus =
  | "disabled"
  | "downloading"
  | "installing"
  | "verifying"
  | "ready"
  | "broken";

export interface OcrFeatureState {
  status: OcrFeatureStatus;
  feature_version: string;
  engine: string;
  model: string;
  model_display: string;
  runtime_version: string;
  platform: string;
  arch: string;
  installed_at: string;
  verified: boolean;
}

export interface OcrStatusOutput {
  installed: boolean;
  status: OcrFeatureStatus;
  model: string;
  modelDisplay: string;
  engine: string;
  directory: string;
  platform: string;
  arch: string;
  installedAt: string | null;
  verified: boolean;
}
