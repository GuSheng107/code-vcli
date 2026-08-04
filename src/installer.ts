import { execFile, spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { PACKAGE_NAME } from "./constants.js";
import { TransxError } from "./errors.js";
import { getBinDirectory } from "./paths.js";
import { getPackageInfo } from "./package-info.js";

const execFileAsync = promisify(execFile);

export async function runNpm(
  args: string[],
  options: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const npmExecPath = process.env.npm_execpath;
  // 在 npm 生命周期内可直接通过 Node 执行 npm CLI 脚本，无需 shell。
  if (process.platform === "win32" && npmExecPath && /\.(?:c?js|mjs)$/i.test(npmExecPath)) {
    return execFileAsync(process.execPath, [npmExecPath, ...args], {
      windowsHide: true,
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    });
  }

  // 非 npm 生命周期内，Windows 通过 cmd.exe /c 调用 npm，避免 shell:true 触发 DEP0190。
  const isWindows = process.platform === "win32";
  const command = isWindows ? process.env.ComSpec ?? "cmd.exe" : "npm";
  const finalArgs = isWindows ? ["/c", "npm", ...args] : args;
  const spawnOptions = {
    windowsHide: true,
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
  };
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, finalArgs, spawnOptions);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        const error = new Error(`npm ${args[0]} 退出码 ${code}${stderr ? `：${stderr.trim()}` : ""}`);
        Object.assign(error, { stdout, stderr, code });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function quoteCmd(value: string): string {
  return value.replaceAll("%", "%%").replaceAll('"', '""');
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function ensureWindowsUserPath(binDirectory: string): Promise<void> {
  const powershell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const script = [
    "$bin = $env:TRANSX_BIN_DIR",
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$parts = @($current -split ';' | Where-Object { $_ })",
    // Windows 文件系统不区分大小写，比较时统一小写，避免等价路径重复加入。
    "$lower = $parts | ForEach-Object { $_.ToLowerInvariant() }",
    "if ($lower -notcontains $bin.ToLowerInvariant()) {",
    "  [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User')",
    "}",
  ].join("\n");
  await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, TRANSX_BIN_DIR: binDirectory },
  });
}

export function getPosixProfilePath(
  platform: NodeJS.Platform = process.platform,
  shell = process.env.SHELL ?? "",
  homeDirectory = os.homedir(),
): string {
  const shellName = path.posix.basename(shell);
  if (shellName === "zsh") return path.posix.join(homeDirectory, ".zshrc");
  if (shellName === "bash") {
    return path.posix.join(homeDirectory, platform === "darwin" ? ".bash_profile" : ".bashrc");
  }
  return path.posix.join(homeDirectory, ".profile");
}

async function ensurePosixPath(binDirectory: string): Promise<void> {
  const profile = getPosixProfilePath();
  const marker = "# transx-cli user bin";
  let existing = "";
  try {
    existing = await readFile(profile, "utf8");
  } catch {
    // A missing profile will be created below.
  }
  if (!existing.includes(marker)) {
    const block = `\n${marker}\nexport PATH=${quoteShell(binDirectory)}:"$PATH"\n`;
    await writeFile(profile, `${existing}${block}`, "utf8");
  }
}

export async function installCurrentPackage(force = false): Promise<string> {
  const packageInfo = await getPackageInfo();
  const binDirectory = getBinDirectory();
  const versionDirectory = path.join(binDirectory, packageInfo.version);
  const targetDist = path.join(versionDirectory, "dist");
  const targetOcrResources = path.join(versionDirectory, "resources", "ocr");
  if (force) {
    await rm(versionDirectory, { recursive: true, force: true });
  }
  await mkdir(versionDirectory, { recursive: true, mode: 0o700 });

  try {
    await cp(path.join(packageInfo.root, "dist"), targetDist, {
      recursive: true,
      force,
      errorOnExist: !force,
    });
    await cp(path.join(packageInfo.root, "package.json"), path.join(versionDirectory, "package.json"), {
      force,
      errorOnExist: !force,
    });
    await mkdir(targetOcrResources, { recursive: true, mode: 0o700 });
    for (const fileName of ["ocr.py", "requirements-ocr.txt"]) {
      await cp(
        path.join(packageInfo.root, "resources", "ocr", fileName),
        path.join(targetOcrResources, fileName),
        { force, errorOnExist: !force },
      );
    }
  } catch (error) {
    throw new TransxError(
      "INSTALL_ERROR",
      force ? "无法覆盖现有 TransX 安装" : "该版本已安装；如需覆盖请添加 --force",
      5,
      { cause: error },
    );
  }

  // npx 的临时 node_modules 不会随 dist 一起复制，目标目录必须拥有自己的生产依赖。
  try {
    await runNpm([
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-save",
      "--no-package-lock",
      "--fund=false",
      "--audit=false",
      "--prefix",
      versionDirectory,
    ]);
  } catch (error) {
    await rm(versionDirectory, { recursive: true, force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new TransxError("INSTALL_ERROR", `依赖安装失败：${detail}`, 5, { cause: error });
  }

  const cliPath = path.join(targetDist, "cli.js");
  if (process.platform === "win32") {
    const launcher = `@echo off\r\nnode "${quoteCmd(cliPath)}" %*\r\n`;
    await writeFile(path.join(binDirectory, "transx.cmd"), launcher, "utf8");
    await ensureWindowsUserPath(binDirectory);
  } else {
    const launcherPath = path.join(binDirectory, "transx");
    await writeFile(launcherPath, `#!/bin/sh\nexec node ${quoteShell(cliPath)} "$@"\n`, {
      encoding: "utf8",
      mode: 0o755,
    });
    await ensurePosixPath(binDirectory);
  }

  return binDirectory;
}

export async function getLatestVersion(): Promise<string> {
  try {
    const { stdout } = await runNpm(["view", PACKAGE_NAME, "version", "--json"]);
    return String(JSON.parse(stdout)).trim();
  } catch (error) {
    throw new TransxError("UPDATE_ERROR", "无法从 npm Registry 获取最新版本", 5, { cause: error });
  }
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): { core: number[]; prerelease: string[] } => {
    const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) throw new TransxError("UPDATE_ERROR", `无法比较版本号：${value}`, 5);
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split(".") ?? [],
    };
  };

  const leftVersion = parse(left);
  const rightVersion = parse(right);
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const difference = (leftVersion.core[index] ?? 0) - (rightVersion.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    return leftVersion.prerelease.length === rightVersion.prerelease.length
      ? 0
      : leftVersion.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Math.sign(Number(leftPart) - Number(rightPart));
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart) < 0 ? -1 : 1;
  }
  return 0;
}

export async function updateFromRegistry(): Promise<void> {
  try {
    await runNpm([
      "exec",
      "--yes",
      `--package=${PACKAGE_NAME}@latest`,
      "--",
      "transx",
      "install",
      "--force",
    ]);
  } catch (error) {
    throw new TransxError("UPDATE_ERROR", "更新失败，请检查 npm 和网络状态", 5, { cause: error });
  }
}
