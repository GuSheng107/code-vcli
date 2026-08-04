import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const initDirectory = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : "";
const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;

// 安装仓库自身的开发依赖时不写入用户目录；只有作为 npm 依赖安装时才自动部署 CLI。
if (normalize(initDirectory) !== normalize(packageRoot)) {
  const result = spawnSync(
    process.execPath,
    [path.join(packageRoot, "dist", "cli.js"), "install", "--force"],
    { cwd: packageRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
