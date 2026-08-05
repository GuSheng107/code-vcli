#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { zipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "skills", "code-vcli", "SKILL.md");
const outputPath = path.join(root, "docs", "code-vcli-skills.zip");

const entries = {
  "code-vcli/SKILL.md": await readFile(sourcePath),
};
await writeFile(outputPath, zipSync(entries, { level: 9 }));
process.stdout.write(`Skill 下载包已生成：${outputPath}\n`);
