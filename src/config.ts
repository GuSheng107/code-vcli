import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CONFIG_VERSION,
  DEFAULT_TARGET_LANGUAGE,
  DEFAULT_TIMEOUT_MS,
  DLX_URL_TEMPLATE,
  ENV_API_KEY,
} from "./constants.js";
import { TransxError } from "./errors.js";
import { getConfigRoot } from "./paths.js";

interface StoredCredentials {
  version: number;
  apiKey: string;
}

export interface ResolvedConfig {
  urlTemplate: string;
  apiKey: string;
  defaultTarget: string;
  timeoutMs: number;
}

export interface ConfigStatus {
  configDirectory: string;
  urlTemplate: string;
  maskedApiKey: string | null;
  initialized: boolean;
  keySource: "environment" | "local" | null;
}

export interface ConfigStatusWithApiKey extends ConfigStatus {
  apiKey: string | null;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isStoredCredentials(value: unknown): value is StoredCredentials {
  return typeof value === "object" && value !== null &&
    "version" in value && typeof value.version === "number" &&
    "apiKey" in value && typeof value.apiKey === "string";
}

async function readCredentials(filePath: string): Promise<StoredCredentials | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!isStoredCredentials(parsed)) throw new Error("invalid credentials schema");
    return parsed;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new TransxError("CONFIG_INVALID", `无法读取本地配置：${filePath}`, 3, { cause: error });
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return "*".repeat(apiKey.length);
  }
  return `${apiKey.slice(0, 4)}${"*".repeat(Math.min(8, apiKey.length - 8))}${apiKey.slice(-4)}`;
}

export class ConfigStore {
  readonly directory: string;
  readonly credentialsPath: string;

  constructor(directory = getConfigRoot()) {
    this.directory = directory;
    this.credentialsPath = path.join(directory, "credentials.json");
  }

  async setApiKey(apiKey: string): Promise<void> {
    const normalized = apiKey.trim();
    if (!normalized) {
      throw new TransxError("CONFIG_INVALID", "API Key 不能为空", 3);
    }
    await writeJsonAtomic(this.credentialsPath, {
      version: CONFIG_VERSION,
      apiKey: normalized,
    } satisfies StoredCredentials);
  }

  async resetKey(): Promise<void> {
    await rm(this.credentialsPath, { force: true });
  }

  async resetAll(): Promise<void> {
    await this.resetKey();
  }

  async resolve(env: NodeJS.ProcessEnv = process.env): Promise<ResolvedConfig> {
    const storedCredentials = await readCredentials(this.credentialsPath);
    const apiKey = env[ENV_API_KEY]?.trim() || storedCredentials?.apiKey;

    if (!apiKey) {
      throw new TransxError(
        "CONFIG_NOT_INITIALIZED",
        "缺少 DLX API Key，请先运行 transx init。获取：https://connect.linux.do/",
        3,
      );
    }

    return {
      urlTemplate: DLX_URL_TEMPLATE,
      apiKey,
      defaultTarget: DEFAULT_TARGET_LANGUAGE,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  async status(env: NodeJS.ProcessEnv = process.env): Promise<ConfigStatus> {
    const storedCredentials = await readCredentials(this.credentialsPath);
    const envKey = env[ENV_API_KEY]?.trim();
    const apiKey = envKey || storedCredentials?.apiKey || null;
    return {
      configDirectory: this.directory,
      urlTemplate: DLX_URL_TEMPLATE,
      maskedApiKey: apiKey ? maskApiKey(apiKey) : null,
      initialized: Boolean(apiKey),
      keySource: envKey ? "environment" : storedCredentials?.apiKey ? "local" : null,
    };
  }

  async statusWithApiKey(env: NodeJS.ProcessEnv = process.env): Promise<ConfigStatusWithApiKey> {
    const storedCredentials = await readCredentials(this.credentialsPath);
    const envKey = env[ENV_API_KEY]?.trim();
    const apiKey = envKey || storedCredentials?.apiKey || null;
    return {
      configDirectory: this.directory,
      urlTemplate: DLX_URL_TEMPLATE,
      maskedApiKey: apiKey ? maskApiKey(apiKey) : null,
      apiKey,
      initialized: Boolean(apiKey),
      keySource: envKey ? "environment" : storedCredentials?.apiKey ? "local" : null,
    };
  }

}
