import type { VisionOcrEngineType, ComputeCapability, OcrBackend, VisionMode } from "./constants.js";

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
}

export interface VlmElement {
  role?: string;
  text?: string;
  position?: string;
}

export interface VisionRecognitionResult {
  text: string;
  items: VisionItem[];
  layout?: VisionLayout;
  mode?: VisionMode;
  intent?: string;
  summary?: string;
  elements?: VlmElement[];
  raw?: string;
  engine?: string;
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
  raw?: string;
  error?: {
    code: string;
    message: string;
  };
}

export type VisionOcrEngine = VisionOcrEngineType;