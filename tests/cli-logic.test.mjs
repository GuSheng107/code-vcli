import test from "node:test";
import assert from "node:assert/strict";

import {
  parseInitArguments,
  parseRunArguments,
  supportsVisionMode,
} from "../dist/cli.js";
import { selectVlmModelOption } from "../dist/ocr/feature-installer.js";

const nvidiaPlatform = (vramGb) => ({
  os: "windows",
  arch: "x64",
  gpuVendor: "nvidia",
  gpuName: "Test GPU",
  gpuVramGb: vramGb,
});

test("both 能力支持 OCR、VLM 和 Mix", () => {
  assert.equal(supportsVisionMode("both", "ocr"), true);
  assert.equal(supportsVisionMode("both", "vlm"), true);
  assert.equal(supportsVisionMode("both", "mix"), true);
  assert.equal(supportsVisionMode("vlm", "ocr"), false);
  assert.equal(supportsVisionMode("ocr", "vlm"), false);
});

test("run 参数拒绝冲突模式和多图片", () => {
  assert.throws(() => parseRunArguments(["a.png", "--vlm", "--mix"]), /不能同时使用/);
  assert.throws(() => parseRunArguments(["a.png", "b.png"]), /只能指定一个图片路径/);
});

test("GPU Mix 初始化参数可完整解析", () => {
  assert.deepEqual(
    parseInitArguments([
      "--yes",
      "--workspace", "E:\\bf",
      "--compute", "gpu",
      "--capabilities", "both",
      "--ocr-backend", "gpu",
      "--vlm-option", "B2",
    ]),
    {
      yes: true,
      resetWorkspace: false,
      workspace: "E:\\bf",
      computeMode: "gpu",
      capabilities: "both",
      ocrBackend: "gpu",
      vlmModelOption: "B2",
    },
  );
});

test("init 参数拒绝无效组合", () => {
  assert.throws(
    () => parseInitArguments(["--compute", "cpu", "--capabilities", "both"]),
    /CPU 模式仅支持 OCR/,
  );
  assert.throws(
    () => parseInitArguments(["--capabilities", "vlm", "--ocr-backend", "gpu"]),
    /仅 VLM 能力不需要/,
  );
});

test("拒绝推荐模型后可手选超出建议的 B1 并确认", async () => {
  const answers = ["n", "B1", "y"];
  const prompts = [];
  const selected = await selectVlmModelOption(
    nvidiaPlatform(12),
    async (message) => {
      prompts.push(message);
      return answers.shift() ?? "";
    },
    false,
  );
  assert.equal(selected.id, "B1");
  assert.equal(prompts.some((message) => message.includes("全部") || message.includes("请选择")), true);
  assert.equal(prompts.some((message) => message.includes("警告")), true);
});

test("低于最低建议显存时仍允许用户选择 A2 并确认", async () => {
  const answers = ["A2", "y"];
  const selected = await selectVlmModelOption(
    nvidiaPlatform(6),
    async () => answers.shift() ?? "",
    false,
  );
  assert.equal(selected.id, "A2");
});


test("15.99GB 显存自动推荐 B2", async () => {
  const selected = await selectVlmModelOption(
    nvidiaPlatform(15.99),
    async () => { throw new Error("--yes 不应提示输入"); },
    true,
  );
  assert.equal(selected.id, "B2");
});

test("仅接受 A1 A2 B1 B2 C1 C2", () => {
  assert.throws(() => parseInitArguments(["--vlm-option", "D1"]), /仅支持 A1/);
  assert.equal(parseInitArguments(["--vlm-option", "c2"]).vlmModelOption, "C2");
});

test("Apple/AMD 平台不会自动选择 AWQ", async () => {
  const apple = await selectVlmModelOption(
    { os: "macos", arch: "arm64", gpuVendor: "apple", gpuVramGb: 16 },
    async () => { throw new Error("--yes 不应提示输入"); },
    true,
  );
  assert.equal(apple.id, "A1");

  const amd = await selectVlmModelOption(
    { os: "linux", arch: "x64", gpuVendor: "amd", gpuVramGb: 16 },
    async () => { throw new Error("--yes 不应提示输入"); },
    true,
  );
  assert.equal(amd.id, "B1");
});

test("Mix OCR token 预算参数有严格边界", () => {
  assert.equal(
    parseRunArguments(["image.png", "--mix", "--mix-ocr-context-tokens", "16384"]).mixOcrContextTokens,
    16384,
  );
  assert.throws(
    () => parseRunArguments(["image.png", "--vlm", "--mix-ocr-context-tokens", "1000"]),
    /仅用于 --mix/,
  );
  assert.throws(
    () => parseRunArguments(["image.png", "--mix", "--mix-ocr-context-tokens", "32769"]),
    /0~32768/,
  );
});
