import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";


const historyDirectory = path.join(os.homedir(), ".transx", "history");
const lockPath = path.join(historyDirectory, ".lock");

function chinaTimestamp() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, -1).replace("T", " ");
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function acquireLock() {
  await mkdir(historyDirectory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const current = await stat(lockPath);
        if (Date.now() - current.mtimeMs > 30000) {
          const stale = `${lockPath}.${randomUUID()}.stale`;
          await rename(lockPath, stale);
          await rm(stale, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("翻译历史正在被其他进程使用，请稍后重试");
}

async function listDailyFiles() {
  try {
    return (await readdir(historyDirectory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function rebuildIndex(updatedAt, lastWarningAt) {
  const records = [];
  let totalBytes = 0;
  for (const fileName of await listDailyFiles()) {
    const raw = await readFile(path.join(historyDirectory, fileName), "utf8");
    totalBytes += Buffer.byteLength(raw);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.records)) records.push(...parsed.records);
  }
  const timestamps = records
    .map((record) => record?.createdAt)
    .filter((value) => typeof value === "string")
    .sort();
  return {
    version: 1,
    updatedAt,
    totalRecords: records.length,
    totalBytes,
    oldestAt: timestamps[0] ?? null,
    newestAt: timestamps.at(-1) ?? null,
    lastWarningAt,
  };
}

export async function appendHistory(recordInput) {
  const lock = await acquireLock();
  try {
    const createdAt = chinaTimestamp();
    const date = createdAt.slice(0, 10);
    const dailyPath = path.join(historyDirectory, `${date}.json`);
    let daily;
    try {
      daily = JSON.parse(await readFile(dailyPath, "utf8"));
      if (!Array.isArray(daily?.records)) throw new Error(`翻译历史文件无效：${date}.json`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      daily = { version: 1, date, records: [] };
    }
    daily.records.push({
      id: randomUUID(),
      createdAt,
      sourceLang: recordInput.sourceLang,
      targetLang: recordInput.targetLang,
      ...(recordInput.format === "file"
        ? {
            format: "file",
            sourceFilePath: recordInput.sourceFilePath,
            sourceFileName: recordInput.sourceFileName,
            outputFilePath: recordInput.outputFilePath,
            outputFileName: recordInput.outputFileName,
          }
        : { format: "plain", input: recordInput.input, output: recordInput.output }),
    });
    await writeJsonAtomic(dailyPath, daily);
    const indexPath = path.join(historyDirectory, "index.json");
    let lastWarningAt = null;
    try {
      lastWarningAt = JSON.parse(await readFile(indexPath, "utf8"))?.lastWarningAt ?? null;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await writeJsonAtomic(indexPath, await rebuildIndex(createdAt, lastWarningAt));
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
