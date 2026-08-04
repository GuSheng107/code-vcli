import { stdin, stdout } from "node:process";

import { HISTORY_DEFAULT_LIMIT } from "./constants.js";
import { TransxError } from "./errors.js";
import {
  HistoryStore,
  type HistoryClearCriteria,
  type HistoryQuery,
  type HistoryQueryResult,
  type HistoryRecord,
  toChinaTimestamp,
} from "./history.js";
import { promptYesNo } from "./input.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const HISTORY_HELP = `TransX 翻译历史

Usage:
  transx history [list] [--limit <n>] [--offset <n>] [--from <time>] [--to <time>] [--since <Nd>] [--json]
  transx history search <keyword> [--limit <n>] [--offset <n>] [--from <time>] [--to <time>] [--since <Nd>] [--json]
  transx history status [--json]
  transx history clear <--all|--oldest <n>|--keep <n>|--before <time>|--older-than <Nd>|--from <time> --to <time>> [--yes] [--json]

时间统一按中国时间解释，记录值不附带时区标记，例如 2026-08-03 18:30:00.123。
相对时间使用 7d 这类天数格式。
search 搜索文本原文/译文或文件记录的源文件名/译文文件名。
`;

interface ParsedQuery {
  query: HistoryQuery;
  json: boolean;
  keyword?: string;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TransxError("INVALID_ARGUMENT", `${option} 缺少参数值`, 2);
  }
  return value;
}

function parseInteger(value: string, option: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new TransxError("INVALID_ARGUMENT", `${option} 必须是${allowZero ? "非负" : "正"}整数`, 2);
  }
  return parsed;
}

function parseDuration(value: string, option: string): number {
  const match = /^(\d+)d$/i.exec(value);
  if (!match?.[1]) throw new TransxError("INVALID_ARGUMENT", `${option} 使用天数格式，例如 7d`, 2);
  return parseInteger(match[1], option) * DAY_MS;
}

function parseChinaTimestamp(value: string, endOfDay = false): string {
  let normalized = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized = `${normalized}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+08:00`;
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(normalized)) {
    normalized = `${normalized.replace(" ", "T")}+08:00`;
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new TransxError("INVALID_ARGUMENT", `时间格式无效：${value}`, 2);
  }
  return toChinaTimestamp(date);
}

function parseQueryArgs(args: string[], allowKeyword: boolean): ParsedQuery {
  const query: HistoryQuery = {};
  const keywordParts: string[] = [];
  let json = false;
  let since: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--limit") {
      query.limit = parseInteger(requireValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--offset") {
      query.offset = parseInteger(requireValue(args, index, arg), arg, true);
      index += 1;
    } else if (arg === "--from") {
      query.from = parseChinaTimestamp(requireValue(args, index, arg));
      index += 1;
    } else if (arg === "--to") {
      query.to = parseChinaTimestamp(requireValue(args, index, arg), true);
      index += 1;
    } else if (arg === "--since") {
      since = requireValue(args, index, arg);
      index += 1;
    } else if (arg?.startsWith("-")) {
      throw new TransxError("INVALID_ARGUMENT", `未知历史参数：${arg}`, 2);
    } else if (arg !== undefined && allowKeyword) {
      keywordParts.push(arg);
    } else if (arg !== undefined) {
      throw new TransxError("INVALID_ARGUMENT", `未知历史参数：${arg}`, 2);
    }
  }
  if (since && query.from) {
    throw new TransxError("INVALID_ARGUMENT", "--since 与 --from 不能同时使用", 2);
  }
  if (since) query.from = toChinaTimestamp(new Date(Date.now() - parseDuration(since, "--since")));
  if (query.from && query.to && query.from > query.to) {
    throw new TransxError("INVALID_ARGUMENT", "--from 不能晚于 --to", 2);
  }
  const keyword = keywordParts.join(" ").trim();
  if (allowKeyword && !keyword) throw new TransxError("INVALID_ARGUMENT", "history search 缺少关键词", 2);
  return { query: keyword ? { ...query, keyword } : query, json, ...(keyword ? { keyword } : {}) };
}

function formatRecord(record: HistoryRecord, index: number): string {
  if (record.format === "file") {
    return [
      `${index}. [${record.createdAt}] ${record.sourceLang} → ${record.targetLang}`,
      `   源文件：${record.sourceFilePath}`,
      `   译文文件：${record.outputFilePath ?? "未生成"}`,
      `   ID：${record.id}`,
    ].join("\n");
  }
  return [
    `${index}. [${record.createdAt}] ${record.sourceLang} → ${record.targetLang}`,
    `   原文：${record.input}`,
    `   译文：${record.output}`,
    `   ID：${record.id}`,
  ].join("\n");
}

function printQueryResult(result: HistoryQueryResult, json: boolean, keyword?: string): void {
  if (json) {
    stdout.write(`${JSON.stringify({ ok: true, data: { ...result, ...(keyword ? { keyword } : {}) } })}\n`);
    return;
  }
  if (result.total === 0) {
    stdout.write(keyword ? `没有找到包含“${keyword}”的翻译记录。\n` : "暂无翻译历史。\n");
    return;
  }
  const heading = keyword
    ? `搜索“${keyword}”：匹配 ${result.total} 条，本次显示 ${result.records.length} 条`
    : `翻译历史：共 ${result.total} 条，本次显示 ${result.records.length} 条`;
  stdout.write(`${heading}\n\n${result.records.map((record, index) => formatRecord(record, result.offset + index + 1)).join("\n\n")}\n`);
}

function parseClearArgs(args: string[]): { criteria: HistoryClearCriteria; yes: boolean; json: boolean } {
  let criteria: HistoryClearCriteria | undefined;
  let yes = false;
  let json = false;
  let rangeFrom: string | undefined;
  let rangeTo: string | undefined;
  const setCriteria = (next: HistoryClearCriteria): void => {
    if (criteria) throw new TransxError("INVALID_ARGUMENT", "每次只能使用一种历史清理方式", 2);
    criteria = next;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes") yes = true;
    else if (arg === "--json") json = true;
    else if (arg === "--all") setCriteria({ kind: "all" });
    else if (arg === "--oldest") {
      setCriteria({ kind: "oldest", count: parseInteger(requireValue(args, index, arg), arg) });
      index += 1;
    } else if (arg === "--keep") {
      setCriteria({ kind: "keep", count: parseInteger(requireValue(args, index, arg), arg, true) });
      index += 1;
    } else if (arg === "--before") {
      setCriteria({ kind: "before", timestamp: parseChinaTimestamp(requireValue(args, index, arg)) });
      index += 1;
    } else if (arg === "--older-than") {
      const duration = parseDuration(requireValue(args, index, arg), arg);
      setCriteria({ kind: "before", timestamp: toChinaTimestamp(new Date(Date.now() - duration)) });
      index += 1;
    } else if (arg === "--from") {
      rangeFrom = parseChinaTimestamp(requireValue(args, index, arg));
      index += 1;
    } else if (arg === "--to") {
      rangeTo = parseChinaTimestamp(requireValue(args, index, arg), true);
      index += 1;
    } else {
      throw new TransxError("INVALID_ARGUMENT", `未知清理参数：${arg}`, 2);
    }
  }
  if (rangeFrom || rangeTo) {
    if (criteria) throw new TransxError("INVALID_ARGUMENT", "时间范围不能与其他清理方式同时使用", 2);
    if (!rangeFrom || !rangeTo) throw new TransxError("INVALID_ARGUMENT", "按范围清理必须同时提供 --from 和 --to", 2);
    if (rangeFrom > rangeTo) throw new TransxError("INVALID_ARGUMENT", "--from 不能晚于 --to", 2);
    criteria = { kind: "range", from: rangeFrom, to: rangeTo };
  }
  if (!criteria) throw new TransxError("INVALID_ARGUMENT", "请指定历史清理方式", 2);
  return { criteria, yes, json };
}

async function confirmClear(yes: boolean): Promise<void> {
  if (yes) return;
  if (!stdin.isTTY) {
    throw new TransxError("INVALID_ARGUMENT", "非交互环境清理历史必须添加 --yes", 2);
  }
  if (!await promptYesNo("确认删除匹配的翻译历史？ [y/n] ")) {
    throw new TransxError("CANCELLED", "已取消清理翻译历史", 130);
  }
}

export async function runHistoryCommand(configDirectory: string, args: string[]): Promise<void> {
  const store = new HistoryStore(configDirectory);
  const action = args[0];
  if (action === "help" || action === "--help" || action === "-h") {
    stdout.write(HISTORY_HELP);
    return;
  }
  // 首位是选项（如 --json / --limit）时视为默认 list，而非未知子命令。
  // 这与 README 中 "transx history --limit 20" 的文档用法保持一致。
  if (!action || action === "list" || action.startsWith("-")) {
    const listArgs = action === "list" ? args.slice(1) : args;
    const parsed = parseQueryArgs(listArgs, false);
    printQueryResult(await store.query(parsed.query), parsed.json);
    return;
  }
  if (action === "search") {
    const parsed = parseQueryArgs(args.slice(1), true);
    printQueryResult(await store.query(parsed.query), parsed.json, parsed.keyword);
    return;
  }
  if (action === "status") {
    const remaining = args.slice(1);
    const json = remaining.includes("--json");
    if (remaining.some((arg) => arg !== "--json")) {
      throw new TransxError("INVALID_ARGUMENT", "history status 仅支持 --json", 2);
    }
    const status = await store.status();
    if (json) {
      stdout.write(`${JSON.stringify({ ok: true, data: status })}\n`);
    } else {
      stdout.write(
        [
          `历史目录：${status.directory}`,
          `记录数量：${status.totalRecords}`,
          `文件大小：${(status.totalBytes / 1024 / 1024).toFixed(2)} MB / ${Math.round(status.maxBytes / 1024 / 1024)} MB`,
          `最早记录：${status.oldestAt ?? "无"}`,
          `最新记录：${status.newestAt ?? "无"}`,
          `清理提醒：${status.ageWarning || status.sizeWarning ? "是" : "否"}`,
        ].join("\n") + "\n",
      );
    }
    return;
  }
  if (action === "clear") {
    const parsed = parseClearArgs(args.slice(1));
    await confirmClear(parsed.yes);
    const deleted = await store.clear(parsed.criteria);
    if (parsed.json) stdout.write(`${JSON.stringify({ ok: true, data: { deleted } })}\n`);
    else stdout.write(`已删除 ${deleted} 条翻译历史。\n`);
    return;
  }
  throw new TransxError("INVALID_ARGUMENT", `未知 history 操作：${action}`, 2);
}
