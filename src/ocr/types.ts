import type { VisionEngineType } from "./constants.js";

export interface VisionItem {
  text: string;
  confidence?: number;
  box?: Array<[number, number]>;
  source?: string;
}

export interface VisionRecognitionResult {
  text: string;
  items: VisionItem[];
  engine: string;
  model: string;
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
  engine?: string;
  model?: string;
  error?: {
    code: string;
    message: string;
  };
}

export type VisionEngine = VisionEngineType;
