import { stdin, stdout } from "node:process";

import { TransxError } from "./errors.js";

export interface InteractiveMenuItem<T extends string = string> {
  value: T;
  label: string;
  description: string;
}

export type InteractiveAction =
  | "translate"
  | "translate_file"
  | "translate_image"
  | "ocr_enable"
  | "init"
  | "config"
  | "update"
  | "help"
  | "exit";

const UNINITIALIZED_MENU_ITEMS: Array<InteractiveMenuItem<InteractiveAction>> = [
  { value: "init", label: "初始化", description: "设置 DLX API Key" },
  { value: "update", label: "检查版本更新", description: "比较 npm Registry 最新版本" },
  { value: "help", label: "查看帮助", description: "显示所有命令与参数" },
  { value: "exit", label: "退出", description: "结束 TransX CLI" },
];

const INITIALIZED_MENU_ITEMS_WITH_OCR: Array<InteractiveMenuItem<InteractiveAction>> = [
  { value: "translate", label: "翻译文本", description: "输入文本并选择目标语言" },
  { value: "translate_file", label: "翻译文件", description: "输入文件路径并选择目标语言" },
  { value: "translate_image", label: "图片识别翻译", description: "识别图片或文件内图片，确认后翻译" },
  { value: "init", label: "重新初始化", description: "重新设置 DLX API Key" },
  { value: "config", label: "查看当前配置", description: "只读显示当前完整配置" },
  { value: "update", label: "检查版本更新", description: "比较 npm Registry 最新版本" },
  { value: "help", label: "查看帮助", description: "显示所有命令与参数" },
  { value: "exit", label: "退出", description: "结束 TransX CLI" },
];

const INITIALIZED_MENU_ITEMS_OCR_DISABLED: Array<InteractiveMenuItem<InteractiveAction>> = [
  { value: "translate", label: "翻译文本", description: "输入文本并选择目标语言" },
  { value: "translate_file", label: "翻译文件", description: "输入文件路径并选择目标语言" },
  { value: "ocr_enable", label: "开启图片识别翻译扩展", description: "安装 OCR 扩展（需要 Python）" },
  { value: "init", label: "重新初始化", description: "重新设置 DLX API Key" },
  { value: "config", label: "查看当前配置", description: "只读显示当前完整配置" },
  { value: "update", label: "检查版本更新", description: "比较 npm Registry 最新版本" },
  { value: "help", label: "查看帮助", description: "显示所有命令与参数" },
  { value: "exit", label: "退出", description: "结束 TransX CLI" },
];

export function getInteractiveMenuItems(
  initialized: boolean,
  ocrReady = false,
): Array<InteractiveMenuItem<InteractiveAction>> {
  if (!initialized) return UNINITIALIZED_MENU_ITEMS;
  if (ocrReady) return INITIALIZED_MENU_ITEMS_WITH_OCR;
  return INITIALIZED_MENU_ITEMS_OCR_DISABLED;
}

const ANSI = {
  clear: "\u001b[2J\u001b[H",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
  reset: "\u001b[0m",
  blue: "\u001b[38;2;65;112;255m",
  lime: "\u001b[38;2;184;255;57m",
  white: "\u001b[38;2;238;242;255m",
  dim: "\u001b[38;2;126;137;166m",
  border: "\u001b[38;2;83;100;151m",
};

const LOGO = [
  "████████╗██████╗  █████╗ ███╗   ██╗███████╗██╗  ██╗",
  "╚══██╔══╝██╔══██╗██╔══██╗████╗  ██║██╔════╝╚██╗██╔╝",
  "   ██║   ██████╔╝███████║██╔██╗ ██║███████╗ ╚███╔╝ ",
  "   ██║   ██╔══██╗██╔══██║██║╚██╗██║╚════██║ ██╔██╗ ",
  "   ██║   ██║  ██║██║  ██║██║ ╚████║███████║██╔╝ ██╗",
  "   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝",
];

function paint(value: string, color: keyof typeof ANSI, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${value}${ANSI.reset}` : value;
}

export function buildInteractiveFrame<T extends string>(options: {
  version: string;
  initialized: boolean;
  items: Array<InteractiveMenuItem<T>>;
  selectedIndex: number;
  color?: boolean;
}): string {
  const color = options.color ?? true;
  const status = options.initialized ? "已配置" : "未配置 · 请先初始化";
  const menu = options.items.map((item, index) => {
    const selected = index === options.selectedIndex;
    const cursor = selected ? paint("❯", "lime", color) : " ";
    const number = `${index + 1}.`;
    const paddedLabel = item.label.padEnd(18);
    const label = selected ? paint(paddedLabel, "white", color) : paddedLabel;
    const description = paint(item.description, "dim", color);
    return `${cursor} ${number} ${label} ${description}`;
  });

  return [
    paint(LOGO.join("\n"), "blue", color),
    `${paint(`TransX CLI v${options.version}`, "white", color)}  ${paint(status, options.initialized ? "lime" : "dim", color)}`,
    "",
    paint("┌──────────────────────────────┐", "border", color),
    `${paint("│", "border", color)}  欢迎使用 TransX CLI         ${paint("│", "border", color)}`,
    paint("└──────────────────────────────┘", "border", color),
    paint("DLX 翻译", "dim", color),
    "",
    ...menu,
    "",
    paint("可交互 CLI", "dim", color),
  ].join("\n");
}

export function clearScreen(): void {
  stdout.write(ANSI.clear);
}

export async function selectInteractiveMenu<T extends string>(options: {
  version: string;
  initialized: boolean;
  items: Array<InteractiveMenuItem<T>>;
}): Promise<T | null> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    return null;
  }

  const color = !process.env.NO_COLOR;
  let selectedIndex = 0;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const render = (): void => {
    stdout.write(
      `${ANSI.clear}${ANSI.hideCursor}${buildInteractiveFrame({ ...options, selectedIndex, color })}`,
    );
  };

  render();
  return await new Promise<T | null>((resolve, reject) => {
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write(`${ANSI.showCursor}\n`);
    };
    const finish = (value: T | null): void => {
      cleanup();
      resolve(value);
    };
    const onData = (input: string): void => {
      if (input.includes("\u0003")) {
        cleanup();
        reject(new TransxError("CANCELLED", "操作已取消", 130));
        return;
      }
      if (input === "\u001b[A") {
        selectedIndex = (selectedIndex - 1 + options.items.length) % options.items.length;
        render();
        return;
      }
      if (input === "\u001b[B") {
        selectedIndex = (selectedIndex + 1) % options.items.length;
        render();
        return;
      }
      // An unrecognized escape-prefixed sequence is still an explicit Esc action.
      if (input.includes("\u001b")) {
        finish(null);
        return;
      }
      if (input.includes("\r") || input.includes("\n")) {
        finish(options.items[selectedIndex]?.value ?? null);
        return;
      }
      const numericIndex = Number(input.trim()) - 1;
      if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < options.items.length) {
        finish(options.items[numericIndex]?.value ?? null);
      }
    };
    stdin.on("data", onData);
  });
}
