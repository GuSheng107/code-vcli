import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  OCR_ENGINE,
  OCR_FEATURE_DIR_NAME,
  OCR_FEATURE_VERSION,
  OCR_MODEL_DISPLAY,
  OCR_MODEL_ID,
  OCR_RUNTIME_VERSION,
  OCR_STATE_FILE_NAME,
} from "./constants.js";
import type { OcrFeatureState, OcrFeatureStatus } from "./types.js";

function isOcrFeatureState(value: unknown): value is OcrFeatureState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.status === "string" &&
    typeof record.feature_version === "string" &&
    typeof record.engine === "string" &&
    typeof record.model === "string" &&
    typeof record.model_display === "string" &&
    typeof record.runtime_version === "string" &&
    typeof record.platform === "string" &&
    typeof record.arch === "string" &&
    typeof record.installed_at === "string" &&
    typeof record.verified === "boolean";
}

export class OcrFeatureStateStore {
  readonly featureDirectory: string;
  readonly statePath: string;

  constructor(configRoot: string) {
    this.featureDirectory = path.join(configRoot, OCR_FEATURE_DIR_NAME);
    this.statePath = path.join(this.featureDirectory, OCR_STATE_FILE_NAME);
  }

  async read(): Promise<OcrFeatureState | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath, "utf8"));
      return isOcrFeatureState(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async isReady(): Promise<boolean> {
    const state = await this.read();
    return state?.status === "ready" && state.verified;
  }

  async getStatus(): Promise<OcrFeatureStatus> {
    const state = await this.read();
    return state?.status ?? "disabled";
  }

  async writeReady(): Promise<void> {
    const state: OcrFeatureState = {
      status: "ready",
      feature_version: OCR_FEATURE_VERSION,
      engine: OCR_ENGINE,
      model: OCR_MODEL_ID,
      model_display: OCR_MODEL_DISPLAY,
      runtime_version: OCR_RUNTIME_VERSION,
      platform: process.platform,
      arch: process.arch,
      installed_at: new Date().toISOString(),
      verified: true,
    };
    await this.writeAtomic(state);
  }

  async writeStatus(status: OcrFeatureStatus): Promise<void> {
    const existing = await this.read();
    const state: OcrFeatureState = existing ?? {
      status,
      feature_version: OCR_FEATURE_VERSION,
      engine: OCR_ENGINE,
      model: OCR_MODEL_ID,
      model_display: OCR_MODEL_DISPLAY,
      runtime_version: OCR_RUNTIME_VERSION,
      platform: process.platform,
      arch: process.arch,
      installed_at: new Date().toISOString(),
      verified: false,
    };
    await this.writeAtomic({ ...state, status });
  }

  async clear(): Promise<void> {
    await rm(this.featureDirectory, { recursive: true, force: true });
  }

  private async writeAtomic(state: OcrFeatureState): Promise<void> {
    await mkdir(this.featureDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.statePath);
  }
}
