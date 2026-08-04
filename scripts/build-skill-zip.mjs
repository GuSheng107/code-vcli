#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { zipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(root, "skills", "transx-translate");
const outputPath = path.join(root, "docs", "transx-skills.zip");
const includedRoots = [
  "SKILL.md",
  "package.json",
  "package-lock.json",
  "requirements.txt",
  "assets",
  "scripts",
  "ocr-node",
  "ocr-python",
];
const excludedNames = new Set(["node_modules", ".venv-ocr", "__pycache__"]);

async function addEntry(entries, relativePath) {
  const absolutePath = path.join(skillRoot, relativePath);
  const children = await readdir(absolutePath, { withFileTypes: true }).catch(() => null);
  if (children === null) {
    const archivePath = path.posix.join("transx-translate", ...relativePath.split(path.sep));
    entries[archivePath] = await readFile(absolutePath);
    return;
  }

  for (const child of children.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (excludedNames.has(child.name) || child.name.endsWith(".pyc")) continue;
    await addEntry(entries, path.join(relativePath, child.name));
  }
}

const entries = {};
for (const includedRoot of includedRoots) await addEntry(entries, includedRoot);
await writeFile(outputPath, zipSync(entries, { level: 9 }));
process.stdout.write(`Skill 下载包已生成：${outputPath}\n`);
