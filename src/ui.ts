import { stdin, stdout } from "node:process";

import { VcliError } from "./errors.js";

export interface InteractiveMenuItem<T extends string = string> {
  value: T;
  label: string;
  description: string;
}

export type InteractiveAction =
  | "init"
  | "run"
  | "info"
  | "update"
  | "help"
  | "exit";

const UNINITIALIZED_MENU_ITEMS: Array<InteractiveMenuItem<InteractiveAction>> = [
  { value: "init", label: "初始化", description: "安装视觉模型环境（Python + 模型权重）" },
  { value: "info", label: "查看环境", description: "显示 vcli 与系统环境信息" },
  { value: "update", label: "检查版本更新", description: "比较 npm Registry 最新版本" },
  { value: "help", label: "查看帮助", description: "显示所有命令与参数" },
  { value: "exit", label: "退出", description: "结束 vcli" },
];

const INITIALIZED_MENU_ITEMS: Array<InteractiveMenuItem<InteractiveAction>> = [
  { value: "run", label: "识别图片", description: "对图片执行视觉识别（PP-OCRv6 / + YOLO Web 模式）" },
  { value: "init", label: "重新初始化", description: "重装视觉模型环境" },
  { value: "info", label: "查看环境", description: "显示 vcli 与系统环境信息" },
  { value: "update", label: "检查版本更新", description: "比较 npm Registry 最新版本" },
  { value: "help", label: "查看帮助", description: "显示所有命令与参数" },
  { value: "exit", label: "退出", description: "结束 vcli" },
];

export function getInteractiveMenuItems(
  initialized: boolean,
): Array<InteractiveMenuItem<InteractiveAction>> {
  return initialized ? INITIALIZED_MENU_ITEMS : UNINITIALIZED_MENU_ITEMS;
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
  "██╗   ██╗ ██████╗██╗     ██╗",
  "██║   ██║██╔════╝██║     ██║",
  "██║   ██║██║     ██║     ██║",
  "╚██╗ ██╔╝██║     ██║     ██║",
  " ╚████╔╝ ╚██████╗███████╗██║",
  "  ╚═══╝   ╚═════╝╚══════╝╚═╝",
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
  const status = options.initialized ? "模型就绪" : "未初始化 · 请先运行 init";
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
    `${paint(`vcli v${options.version}`, "white", color)}  ${paint(status, options.initialized ? "lime" : "dim", color)}`,
    "",
    paint("┌──────────────────────────────┐", "border", color),
    `${paint("│", "border", color)}  欢迎使用 vcli              ${paint("│", "border", color)}`,
    paint("└──────────────────────────────┘", "border", color),
    paint("VisionCLI · 截图转文本", "dim", color),
    "",
    ...menu,
    "",
    paint("↑/↓ 选择 · Enter 确认 · Esc 退出", "dim", color),
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
        reject(new VcliError("CANCELLED", "操作已取消", 130));
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
