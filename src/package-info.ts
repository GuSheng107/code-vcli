import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface PackageInfo {
  name: string;
  version: string;
  root: string;
}

export async function getPackageInfo(): Promise<PackageInfo> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(moduleDirectory, "..");
  const packageJson: unknown = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (typeof packageJson !== "object" || packageJson === null ||
      !("name" in packageJson) || typeof packageJson.name !== "string" ||
      !("version" in packageJson) || typeof packageJson.version !== "string") {
    throw new Error("package.json 缺少 name 或 version");
  }
  return { name: packageJson.name, version: packageJson.version, root };
}
