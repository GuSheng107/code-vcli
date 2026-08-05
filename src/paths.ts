import os from "node:os";
import path from "node:path";

export interface PathEnvironment {
  APPDATA?: string;
  LOCALAPPDATA?: string;
  HOME?: string;
  USERPROFILE?: string;
}

function pathForPlatform(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function getUserHome(env: PathEnvironment = process.env): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function getConfigRoot(
  env: PathEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathForPlatform(platform).join(getUserHome(env), ".code-vcli");
}

export function getInstallRoot(
  platform: NodeJS.Platform = process.platform,
  env: PathEnvironment = process.env,
): string {
  const platformPath = pathForPlatform(platform);
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA || platformPath.join(getUserHome(env), "AppData", "Local");
    return platformPath.join(localAppData, ".code-vcli");
  }
  return getConfigRoot(env, platform);
}

export function getBinDirectory(
  platform: NodeJS.Platform = process.platform,
  env: PathEnvironment = process.env,
): string {
  return pathForPlatform(platform).join(getInstallRoot(platform, env), "bin");
}
