import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_LOCK_TIMEOUT_MS,
  HISTORY_MAX_AGE_DAYS,
  HISTORY_MAX_BYTES,
  HISTORY_STALE_LOCK_MS,
  HISTORY_WARNING_INTERVAL_MS,
} from "./constants.js";
import { TransxError } from "./errors.js";

const HISTORY_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAILY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;

interface HistoryRecordBase {
  id: string;
  createdAt: string;
  sourceLang: string;
  targetLang: string;
}

export interface TextHistoryRecord extends HistoryRecordBase {
  format: "plain";
  input: string;
  output: string;
}

export interface FileHistoryRecord extends HistoryRecordBase {
  format: "file";
  sourceFilePath: string;
  sourceFileName: string;
  outputFilePath: string | null;
  outputFileName: string | null;
}

export type HistoryRecord = TextHistoryRecord | FileHistoryRecord;
type HistoryAppendInput =
  | (Omit<TextHistoryRecord, "id" | "createdAt"> & { createdAt?: string })
  | (Omit<FileHistoryRecord, "id" | "createdAt"> & { createdAt?: string });

interface DailyHistoryFile {
  version: number;
  date: string;
  records: HistoryRecord[];
}

interface HistoryIndex {
  version: number;
  updatedAt: string;
  totalRecords: number;
  totalBytes: number;
  oldestAt: string | null;
  newestAt: string | null;
  lastWarningAt: string | null;
}

export interface HistoryQuery {
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
  keyword?: string;
}

export interface HistoryQueryResult {
  total: number;
  offset: number;
  limit: number;
  records: HistoryRecord[];
}

export interface HistoryStatus {
  directory: string;
  totalRecords: number;
  totalBytes: number;
  maxBytes: number;
  maxAgeDays: number;
  oldestAt: string | null;
  newestAt: string | null;
  ageWarning: boolean;
  sizeWarning: boolean;
}

export type HistoryClearCriteria =
  | { kind: "all" }
  | { kind: "oldest"; count: number }
  | { kind: "keep"; count: number }
  | { kind: "before"; timestamp: string }
  | { kind: "range"; from: string; to: string };

interface HistoryStoreOptions {
  maxAgeDays?: number;
  maxBytes?: number;
  now?: () => Date;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function toChinaTimestamp(date: Date): string {
  return new Date(date.getTime() + CHINA_OFFSET_MS).toISOString().slice(0, -1).replace("T", " ");
}

function parseChinaTimestamp(value: string): Date {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,3})?$/.test(value)
    ? `${value.replace(" ", "T")}+08:00`
    : value;
  return new Date(normalized);
}

function validateRecord(value: unknown): value is HistoryRecord {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value) || typeof value.id !== "string") return false;
  if (!("createdAt" in value) || typeof value.createdAt !== "string") return false;
  if (!("sourceLang" in value) || typeof value.sourceLang !== "string") return false;
  if (!("targetLang" in value) || typeof value.targetLang !== "string") return false;
  if (!("format" in value)) return false;
  if (value.format === "plain") {
    return "input" in value && typeof value.input === "string" &&
      "output" in value && typeof value.output === "string";
  }
  if (value.format === "file") {
    return "sourceFilePath" in value && typeof value.sourceFilePath === "string" &&
      "sourceFileName" in value && typeof value.sourceFileName === "string" &&
      "outputFilePath" in value && (typeof value.outputFilePath === "string" || value.outputFilePath === null) &&
      "outputFileName" in value && (typeof value.outputFileName === "string" || value.outputFileName === null);
  }
  return false;
}

function matchesKeyword(record: HistoryRecord, keyword: string): boolean {
  if (record.format === "plain") {
    return record.input.toLocaleLowerCase().includes(keyword) ||
      record.output.toLocaleLowerCase().includes(keyword);
  }
  return record.sourceFileName.toLocaleLowerCase().includes(keyword) ||
    Boolean(record.outputFileName?.toLocaleLowerCase().includes(keyword));
}

function isDailyHistoryFile(value: unknown, date: string): value is DailyHistoryFile {
  return typeof value === "object" && value !== null &&
    "version" in value && value.version === HISTORY_VERSION &&
    "date" in value && value.date === date &&
    "records" in value && Array.isArray(value.records) && value.records.every(validateRecord);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isHistoryIndex(value: unknown): value is HistoryIndex {
  return typeof value === "object" && value !== null &&
    "version" in value && value.version === HISTORY_VERSION &&
    "updatedAt" in value && typeof value.updatedAt === "string" &&
    "totalRecords" in value && typeof value.totalRecords === "number" &&
    "totalBytes" in value && typeof value.totalBytes === "number" &&
    "oldestAt" in value && isNullableString(value.oldestAt) &&
    "newestAt" in value && isNullableString(value.newestAt) &&
    "lastWarningAt" in value && isNullableString(value.lastWarningAt);
}

export class HistoryStore {
  readonly directory: string;
  readonly indexPath: string;
  readonly lockPath: string;
  private readonly maxAgeDays: number;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(configDirectory: string, options: HistoryStoreOptions = {}) {
    this.directory = path.join(configDirectory, "history");
    this.indexPath = path.join(this.directory, "index.json");
    this.lockPath = path.join(this.directory, ".lock");
    this.maxAgeDays = options.maxAgeDays ?? HISTORY_MAX_AGE_DAYS;
    this.maxBytes = options.maxBytes ?? HISTORY_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  async append(input: HistoryAppendInput): Promise<string | null> {
    return await this.withLock(async () => {
      const createdAt = input.createdAt ?? toChinaTimestamp(this.now());
      const timestamp = parseChinaTimestamp(createdAt);
      if (Number.isNaN(timestamp.getTime())) {
        throw new TransxError("HISTORY_ERROR", "历史记录时间无效", 7);
      }
      const base = {
        id: randomUUID(),
        createdAt: toChinaTimestamp(timestamp),
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
      };
      const record: HistoryRecord = input.format === "plain"
        ? { ...base, format: "plain", input: input.input, output: input.output }
        : {
            ...base,
            format: "file",
            sourceFilePath: input.sourceFilePath,
            sourceFileName: input.sourceFileName,
            outputFilePath: input.outputFilePath,
            outputFileName: input.outputFileName,
          };
      const date = record.createdAt.slice(0, 10);
      const filePath = path.join(this.directory, `${date}.json`);
      const existing = await this.readDailyFile(filePath, date);
      const currentIndex = (await this.readIndex()) ?? (await this.rebuildIndexUnlocked());
      const oldBytes = existing.bytes;
      existing.data.records.push(record);
      const serialized = serializeJson(existing.data);
      await this.writeJsonAtomic(filePath, serialized);

      const index: HistoryIndex = {
        ...currentIndex,
        updatedAt: toChinaTimestamp(this.now()),
        totalRecords: currentIndex.totalRecords + 1,
        totalBytes: currentIndex.totalBytes - oldBytes + Buffer.byteLength(serialized),
        oldestAt:
          !currentIndex.oldestAt || record.createdAt < currentIndex.oldestAt
            ? record.createdAt
            : currentIndex.oldestAt,
        newestAt:
          !currentIndex.newestAt || record.createdAt > currentIndex.newestAt
            ? record.createdAt
            : currentIndex.newestAt,
      };
      const warning = this.buildWarning(index);
      const shouldWarn = Boolean(warning && this.warningIsDue(index));
      if (shouldWarn) {
        index.lastWarningAt = toChinaTimestamp(this.now());
      }
      await this.writeJsonAtomic(this.indexPath, serializeJson(index));
      return shouldWarn ? warning : null;
    });
  }

  async query(options: HistoryQuery = {}): Promise<HistoryQueryResult> {
    const limit = options.limit ?? HISTORY_DEFAULT_LIMIT;
    const offset = options.offset ?? 0;
    const keyword = options.keyword?.trim().toLocaleLowerCase();
    const records = (await this.readAllRecords())
      .filter((record) => !options.from || record.createdAt >= options.from)
      .filter((record) => !options.to || record.createdAt <= options.to)
      .filter(
        (record) =>
          !keyword ||
          matchesKeyword(record, keyword),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return {
      total: records.length,
      offset,
      limit,
      records: records.slice(offset, offset + limit),
    };
  }

  async status(): Promise<HistoryStatus> {
    const index = (await this.readIndex()) ?? (await this.withLock(() => this.rebuildIndexUnlocked()));
    const oldestTime = index.oldestAt ? parseChinaTimestamp(index.oldestAt).getTime() : null;
    return {
      directory: this.directory,
      totalRecords: index.totalRecords,
      totalBytes: index.totalBytes,
      maxBytes: this.maxBytes,
      maxAgeDays: this.maxAgeDays,
      oldestAt: index.oldestAt,
      newestAt: index.newestAt,
      ageWarning: oldestTime !== null && this.now().getTime() - oldestTime > this.maxAgeDays * DAY_MS,
      sizeWarning: index.totalBytes > this.maxBytes,
    };
  }

  async clear(criteria: HistoryClearCriteria): Promise<number> {
    return await this.withLock(async () => {
      const records = await this.readAllRecords();
      const deleteIds = new Set<string>();
      if (criteria.kind === "all") {
        records.forEach((record) => deleteIds.add(record.id));
      } else if (criteria.kind === "oldest") {
        [...records]
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .slice(0, criteria.count)
          .forEach((record) => deleteIds.add(record.id));
      } else if (criteria.kind === "keep") {
        [...records]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(criteria.count)
          .forEach((record) => deleteIds.add(record.id));
      } else if (criteria.kind === "before") {
        records.filter((record) => record.createdAt < criteria.timestamp).forEach((record) => deleteIds.add(record.id));
      } else {
        records
          .filter((record) => record.createdAt >= criteria.from && record.createdAt <= criteria.to)
          .forEach((record) => deleteIds.add(record.id));
      }

      if (deleteIds.size === 0) return 0;
      for (const fileName of await this.listDailyFileNames()) {
        const filePath = path.join(this.directory, fileName);
        const daily = await this.readDailyFile(filePath, fileName.slice(0, 10));
        const kept = daily.data.records.filter((record) => !deleteIds.has(record.id));
        if (kept.length === 0) {
          await rm(filePath, { force: true });
        } else if (kept.length !== daily.data.records.length) {
          await this.writeJsonAtomic(filePath, serializeJson({ ...daily.data, records: kept }));
        }
      }
      const previousIndex = await this.readIndex();
      const rebuilt = await this.rebuildIndexUnlocked(previousIndex?.lastWarningAt ?? null);
      await this.writeJsonAtomic(this.indexPath, serializeJson(rebuilt));
      return deleteIds.size;
    });
  }

  private async readAllRecords(): Promise<HistoryRecord[]> {
    const records: HistoryRecord[] = [];
    for (const fileName of await this.listDailyFileNames()) {
      const daily = await this.readDailyFile(path.join(this.directory, fileName), fileName.slice(0, 10));
      records.push(...daily.data.records);
    }
    return records;
  }

  private async listDailyFileNames(): Promise<string[]> {
    try {
      return (await readdir(this.directory)).filter((name) => DAILY_FILE_PATTERN.test(name)).sort();
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw new TransxError("HISTORY_ERROR", "无法读取翻译历史目录", 7, { cause: error });
    }
  }

  private async readDailyFile(
    filePath: string,
    date: string,
  ): Promise<{ data: DailyHistoryFile; bytes: number }> {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isDailyHistoryFile(parsed, date)) {
        throw new Error("invalid history file schema");
      }
      return { data: parsed, bytes: Buffer.byteLength(raw) };
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { data: { version: HISTORY_VERSION, date, records: [] }, bytes: 0 };
      }
      throw new TransxError("HISTORY_ERROR", `翻译历史文件无效：${path.basename(filePath)}`, 7, {
        cause: error,
      });
    }
  }

  private async readIndex(): Promise<HistoryIndex | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.indexPath, "utf8"));
      return isHistoryIndex(parsed) ? parsed : null;
    } catch (error) {
      if (isNodeError(error, "ENOENT") || error instanceof SyntaxError) return null;
      throw new TransxError("HISTORY_ERROR", "无法读取翻译历史索引", 7, { cause: error });
    }
  }

  private async rebuildIndexUnlocked(lastWarningAt: string | null = null): Promise<HistoryIndex> {
    let totalBytes = 0;
    const records: HistoryRecord[] = [];
    for (const fileName of await this.listDailyFileNames()) {
      const daily = await this.readDailyFile(path.join(this.directory, fileName), fileName.slice(0, 10));
      totalBytes += daily.bytes;
      records.push(...daily.data.records);
    }
    const timestamps = records.map((record) => record.createdAt).sort();
    return {
      version: HISTORY_VERSION,
      updatedAt: toChinaTimestamp(this.now()),
      totalRecords: records.length,
      totalBytes,
      oldestAt: timestamps[0] ?? null,
      newestAt: timestamps.at(-1) ?? null,
      lastWarningAt,
    };
  }

  private buildWarning(index: HistoryIndex): string | null {
    const messages: string[] = [];
    if (index.oldestAt && this.now().getTime() - parseChinaTimestamp(index.oldestAt).getTime() > this.maxAgeDays * DAY_MS) {
      messages.push(`最早记录已超过 ${this.maxAgeDays} 天`);
    }
    if (index.totalBytes > this.maxBytes) {
      messages.push(`历史文件已超过 ${Math.round(this.maxBytes / 1024 / 1024)} MB`);
    }
    return messages.length > 0 ? `${messages.join("，")}；运行 transx history status 查看` : null;
  }

  private warningIsDue(index: HistoryIndex): boolean {
    return !index.lastWarningAt || this.now().getTime() - parseChinaTimestamp(index.lastWarningAt).getTime() >= HISTORY_WARNING_INTERVAL_MS;
  }

  private async writeJsonAtomic(filePath: string, serialized: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw new TransxError("HISTORY_ERROR", "无法写入翻译历史", 7, { cause: error });
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + HISTORY_LOCK_TIMEOUT_MS;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    while (!handle && Date.now() < deadline) {
      try {
        handle = await open(this.lockPath, "wx", 0o600);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw new TransxError("HISTORY_ERROR", "无法锁定翻译历史", 7, { cause: error });
        }
        // 检测到过期锁时，先尝试用 rename 原子地“占位”接管，
        // rename 成功者获得清理权，失败者说明锁已被其他进程接管，直接退回等待。
        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > HISTORY_STALE_LOCK_MS) {
            const staging = `${this.lockPath}.${randomUUID()}.stale`;
            await rename(this.lockPath, staging);
            await rm(staging, { force: true });
          }
        } catch (statError) {
          if (!isNodeError(statError, "ENOENT")) throw statError;
        }
        await delay(50);
      }
    }
    if (!handle) throw new TransxError("HISTORY_ERROR", "翻译历史正在被其他进程使用，请稍后重试", 7);
    try {
      return await operation();
    } finally {
      await handle.close();
      await rm(this.lockPath, { force: true });
    }
  }
}
