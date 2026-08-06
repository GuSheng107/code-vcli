import type { VisionOcrEngineType, ComputeCapability, OcrBackend, VisionMode, VlmModelOptionId } from "./constants.js";

export interface VisionGeometry {
  aspect: number;
  region: string;
}

export interface VisionCluster {
  id: number;
  size: number;
  arrangement: string;
  region: string;
}

export interface VisionLayout {
  img_size: [number, number];
  item_count: number;
  text_density: string;
  patterns: Record<string, boolean>;
  cluster_summary: VisionCluster[];
}

export interface VisionItem {
  text: string;
  confidence?: number;
  bbox?: [number, number, number, number];
  source?: string;
  type?: string;
  geometry?: VisionGeometry;
  cluster?: VisionCluster;
  region?: string;
  cluster_id?: number;
}

export interface VlmElement {
  role?: string;
  text?: string;
  position?: [number, number] | string;
}

export interface VlmAnnotation {
  text?: string;
  position?: [number, number] | string;
}

export interface VlmLayoutInfo {
  page_type?: string;
  sections?: string[];
}

export interface OcrContextStats {
  originalItems: number;
  includedItems: number;
  omittedItems: number;
  originalChars: number;
  injectedTokens: number;
  tokenBudget: number;
  truncated: boolean;
  strategy: string;
}

export interface VisionRecognitionResult {
  text: string;
  items: VisionItem[];
  layout?: VisionLayout | VlmLayoutInfo;
  mode?: VisionMode;
  intent?: string;
  summary?: string;
  elements?: VlmElement[];
  annotations?: VlmAnnotation[];
  raw?: string;
  engine?: string;
  ocrText?: string;
  ocrContext?: OcrContextStats;
}

export type VisionFeatureStatus =
  | "none"
  | "downloading"
  | "installing"
  | "verifying"
  | "ready"
  | "broken";

export interface VisionFeatureState {
  status: VisionFeatureStatus;
  feature_version: string;
  python_version: string;
  platform: string;
  arch: string;
  installed_at: string;
  verified: boolean;
  computeMode: "cpu" | "gpu";
  capabilities: ComputeCapability;
  ocrBackend?: OcrBackend;
  vlmModelOption?: VlmModelOptionId;
  vlmQuantization?: string;
}

export interface VisionStatusOutput {
  installed: boolean;
  status: VisionFeatureStatus;
  pythonVersion: string | null;
  venvPath: string;
  modelsPath: string;
  directory: string;
  platform: string;
  arch: string;
  installedAt: string | null;
  verified: boolean;
}

export interface PythonOutput {
  ok: boolean;
  text?: string;
  items?: VisionItem[];
  layout?: VisionLayout;
  engine?: string;
  ocr?: string;
  model?: string;
  mode?: VisionMode;
  intent?: string;
  summary?: string;
  elements?: VlmElement[];
  annotations?: VlmAnnotation[];
  raw?: string;
  ocr_text?: string;
  ocr_context?: OcrContextStats;
  error?: {
    code: string;
    message: string;
  };
}

export type VisionOcrEngine = VisionOcrEngineType;
