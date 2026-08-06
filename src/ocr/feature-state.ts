import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  VISION_FEATURE_VERSION,
  VISION_STATE_FILE_NAME,
} from "./constants.js";
import type { VisionFeatureState, VisionFeatureStatus } from "./types.js";
import type { ComputeCapability, OcrBackend, VlmModelOptionId } from "./constants.js";

function isVisionFeatureState(value: unknown): value is VisionFeatureState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const validStatuses: VisionFeatureStatus[] = [
    "none", "downloading", "installing", "verifying", "ready", "broken",
  ];
  const validCapabilities: ComputeCapability[] = ["ocr", "vlm", "both"];
  return typeof record.status === "string" &&
    validStatuses.includes(record.status as VisionFeatureStatus) &&
    typeof record.feature_version === "string" &&
    typeof record.python_version === "string" &&
    typeof record.platform === "string" &&
    typeof record.arch === "string" &&
    typeof record.installed_at === "string" &&
    typeof record.verified === "boolean" &&
    (record.computeMode === "cpu" || record.computeMode === "gpu") &&
    typeof record.capabilities === "string" &&
    validCapabilities.includes(record.capabilities as ComputeCapability) &&
    (record.ocrBackend === undefined || record.ocrBackend === "cpu" || record.ocrBackend === "gpu") &&
    (record.vlmModelOption === undefined || ["A1", "A2", "B1", "B2", "C1", "C2"].includes(String(record.vlmModelOption))) &&
    (record.vlmQuantization === undefined || record.vlmQuantization === "bf16" || record.vlmQuantization === "awq");
}

export class VisionStateStore {
  readonly directory: string;
  readonly statePath: string;

  constructor(configRoot: string) {
    this.directory = configRoot;
    this.statePath = path.join(configRoot, VISION_STATE_FILE_NAME);
  }

  async read(): Promise<VisionFeatureState | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath, "utf8"));
      return isVisionFeatureState(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async isReady(): Promise<boolean> {
    const state = await this.read();
    return state?.status === "ready" && state.verified;
  }

  async getStatus(): Promise<VisionFeatureStatus> {
    const state = await this.read();
    return state?.status ?? "none";
  }

  async writeReady(
    pythonVersion: string,
    config: {
      computeMode: "cpu" | "gpu";
      capabilities: ComputeCapability;
      ocrBackend?: OcrBackend;
      vlmModelOption?: VlmModelOptionId;
      vlmQuantization?: string;
    },
  ): Promise<void> {
    const state: VisionFeatureState = {
      status: "ready",
      feature_version: VISION_FEATURE_VERSION,
      python_version: pythonVersion,
      platform: process.platform,
      arch: process.arch,
      installed_at: new Date().toISOString(),
      verified: true,
      computeMode: config.computeMode,
      capabilities: config.capabilities,
      ...(config.ocrBackend ? { ocrBackend: config.ocrBackend } : {}),
      ...(config.vlmModelOption ? { vlmModelOption: config.vlmModelOption } : {}),
      ...(config.vlmQuantization ? { vlmQuantization: config.vlmQuantization } : {}),
    };
    await this.writeAtomic(state);
  }

  async writeStatus(status: VisionFeatureStatus, pythonVersion = ""): Promise<void> {
    const existing = await this.read();
    const state: VisionFeatureState = existing ?? {
      status,
      feature_version: VISION_FEATURE_VERSION,
      python_version: pythonVersion,
      platform: process.platform,
      arch: process.arch,
      installed_at: new Date().toISOString(),
      verified: false,
      computeMode: "cpu",
      capabilities: "ocr",
    };
    await this.writeAtomic({ ...state, status, python_version: pythonVersion || state.python_version });
  }

  async clear(): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(this.statePath, { force: true });
  }

  private async writeAtomic(state: VisionFeatureState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.statePath);
  }
}
