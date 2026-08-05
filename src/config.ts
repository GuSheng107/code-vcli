import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { CONFIG_VERSION } from "./constants.js";
import { VcliError } from "./errors.js";
import { getConfigRoot } from "./paths.js";

/**
 * 轻量配置文件，固定存放在 ~/.code-vcli/config.json。
 * 仅用于记录用户选择的 workspace 路径，本身不占用空间。
 */
interface LightConfig {
  workspace: string;
}

interface StoredState {
  version: number;
  initialized: boolean;
  initialized_at: string | null;
}

export interface ConfigStatus {
  configDirectory: string;
  workspace: string;
  initialized: boolean;
  initializedAt: string | null;
}

function isStoredState(value: unknown): value is StoredState {
  return typeof value === "object" && value !== null &&
    "version" in value && typeof value.version === "number" &&
    "initialized" in value && typeof value.initialized === "boolean";
}

function isLightConfig(value: unknown): value is LightConfig {
  return typeof value === "object" && value !== null &&
    "workspace" in value && typeof value.workspace === "string";
}

async function readJsonFile<T>(filePath: string, guard: (v: unknown) => v is T): Promise<T | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return guard(parsed) ? parsed : null;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    return null;
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

function defaultWorkspace(): string {
  return getConfigRoot();
}

/**
 * 解析并校验用户输入的工作区路径，返回标准化后的绝对路径。
 * 不要求目录必须存在，但父目录必须可访问。
 */
export async function resolveWorkspacePath(input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new VcliError("INVALID_ARGUMENT", "工作区路径不能为空", 2);
  }
  const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
  // 检查父目录是否存在，避免输入明显错误的路径
  try {
    const parentStat = await stat(path.dirname(resolved));
    if (!parentStat.isDirectory()) {
      throw new VcliError("INVALID_ARGUMENT", `父目录不是目录：${path.dirname(resolved)}`, 2);
    }
  } catch (error) {
    throw new VcliError(
      "INVALID_ARGUMENT",
      `无法访问父目录：${path.dirname(resolved)}`,
      2,
      { cause: error },
    );
  }
  return resolved;
}

export class ConfigStore {
  /** 固定的轻量配置目录（~/.code-vcli） */
  readonly directory: string;
  readonly configPath: string;

  constructor(directory = getConfigRoot()) {
    this.directory = directory;
    this.configPath = path.join(directory, "config.json");
  }

  /** 用户选择的工作区根目录（code-vcli init 时设置，默认 ~/.code-vcli） */
  async getWorkspace(): Promise<string> {
    const config = await readJsonFile(this.configPath, isLightConfig);
    return config?.workspace ?? defaultWorkspace();
  }

  async setWorkspace(workspace: string): Promise<void> {
    const config: LightConfig = { workspace };
    await writeJsonAtomic(this.configPath, config);
  }

  async getStatePath(): Promise<string> {
    const workspace = await this.getWorkspace();
    return path.join(workspace, "state.json");
  }

  async setInitialized(): Promise<void> {
    const state: StoredState = {
      version: CONFIG_VERSION,
      initialized: true,
      initialized_at: new Date().toISOString(),
    };
    await writeJsonAtomic(await this.getStatePath(), state);
  }

  async reset(): Promise<void> {
    const state: StoredState = {
      version: CONFIG_VERSION,
      initialized: false,
      initialized_at: null,
    };
    await writeJsonAtomic(await this.getStatePath(), state);
  }

  async status(): Promise<ConfigStatus> {
    const workspace = await this.getWorkspace();
    const statePath = await this.getStatePath();
    const state = await readJsonFile(statePath, isStoredState);
    return {
      configDirectory: this.directory,
      workspace,
      initialized: state?.initialized ?? false,
      initializedAt: state?.initialized_at ?? null,
    };
  }
}
