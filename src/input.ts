import { stdin, stderr } from "node:process";
import { createInterface } from "node:readline/promises";

import { TransxError } from "./errors.js";

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

export async function promptText(prompt: string): Promise<string> {
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    const value = await promptRawInput(prompt, false);
    if (value === null) throw new TransxError("CANCELLED", "操作已取消", 130);
    return value;
  }

  const readline = createInterface({ input: stdin, output: stderr });
  try {
    return (await readline.question(prompt)).trim();
  } finally {
    readline.close();
  }
}

export function parseYesNo(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "y") return true;
  if (normalized === "n") return false;
  return null;
}

export async function promptYesNo(prompt: string): Promise<boolean> {
  if (!stdin.isTTY) {
    const answer = parseYesNo(await promptText(prompt));
    if (answer === null) throw new TransxError("INVALID_ARGUMENT", "请输入 y 或 n", 2);
    return answer;
  }
  while (true) {
    const answer = parseYesNo(await promptText(prompt));
    if (answer !== null) return answer;
  }
}

export async function promptTranslationContinue(): Promise<boolean> {
  return (await promptEnterOrEscape("\nEnter 继续翻译 · Esc 返回主菜单")) === "enter";
}

export async function promptEnterOrEscape(
  prompt: string,
): Promise<"enter" | "escape"> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return "escape";
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<"enter" | "escape">((resolve, reject) => {
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (input: string): void => {
      if (input.includes("\u0003")) {
        cleanup();
        reject(new TransxError("CANCELLED", "操作已取消", 130));
      } else if (input.includes("\u001b")) {
        cleanup();
        resolve("escape");
      } else if (input.includes("\r") || input.includes("\n")) {
        cleanup();
        resolve("enter");
      }
    };
    stdin.on("data", onData);
  });
}

export async function promptSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new TransxError("INVALID_ARGUMENT", "非交互环境请使用 --stdin 提供 API Key", 2);
  }

  const value = await promptRawInput(prompt, true);
  if (value === null) throw new TransxError("CANCELLED", "操作已取消", 130);
  return value;
}

async function promptRawInput(prompt: string, secret: boolean): Promise<string | null> {
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return await new Promise<string | null>((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (input: string): void => {
      for (const character of Array.from(input)) {
        if (character === "\u0003") {
          cleanup();
          reject(new TransxError("CANCELLED", "操作已取消", 130));
          return;
        }
        if (character === "\u001b") {
          cleanup();
          resolve(null);
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b") {
          const characters = Array.from(value);
          if (characters.length > 0) {
            characters.pop();
            value = characters.join("");
            stderr.write("\b \b");
          }
          continue;
        }
        if (character < " ") continue;
        value += character;
        stderr.write(secret ? "*" : character);
      }
    };
    stdin.on("data", onData);
  });
}
