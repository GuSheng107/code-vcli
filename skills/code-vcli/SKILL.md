---
name: code-vcli
description: 使用 vcli 为没有多模态能力的 AI Agent 提供本地视觉能力。适用于网页/UI 截图、文档图片、OCR、结构化坐标提取、Qwen2.5-VL 视觉理解，以及受 token 预算保护的 OCR+VLM Mix。
---

# code-vcli

`code-vcli` 把本地图片转换为文字、坐标、布局和视觉理解结果。图片不会上传，无遥测。

## 前置检查

```bash
vcli info
```

若未初始化或返回 `MODEL_NOT_INSTALLED`：

```bash
vcli init
```

要求 Node.js 22+、Python 3.10+。VLM 需要 GPU；OCR 可使用 CPU 或 GPU。

## 初始化

交互初始化会选择计算模式、能力、OCR 后端和 VLM 模型：

```bash
vcli init
```

非交互示例：

```bash
# GPU + OCR/VLM + CPU OCR + B2
vcli init --yes --compute gpu --capabilities both --ocr-backend cpu --vlm-option B2

# GPU + OCR/VLM + GPU OCR + B2
vcli init --yes --compute gpu --capabilities both --ocr-backend gpu --vlm-option B2
```

允许的 VLM 选项只有：

| ID | 模型 | 建议显存 | 平台 |
| --- | --- | --- | --- |
| A1 | Qwen2.5-VL 3B BF16 | 8GB+ | NVIDIA / Apple MPS / AMD ROCm |
| A2 | Qwen2.5-VL 3B AWQ INT4 | 4GB+ | Windows/Linux NVIDIA |
| B1 | Qwen2.5-VL 7B BF16 | 16GB+ | NVIDIA / Apple MPS / AMD ROCm |
| B2 | Qwen2.5-VL 7B AWQ INT4 | 8GB+ | Windows/Linux NVIDIA |
| C1 | Qwen2.5-VL 32B BF16 | 72GB+ | NVIDIA / Apple MPS / AMD ROCm |
| C2 | Qwen2.5-VL 32B AWQ INT4 | 24GB+ | Windows/Linux NVIDIA |

显存不足时 CLI 会警告并要求确认；平台不兼容时会在下载前停止。拒绝推荐型号后会显示完整六项菜单，不会直接退出。

## 模式选择

| 场景 | 推荐模式 |
| --- | --- |
| 只需要准确文字 | OCR：`vcli run image.png --json` |
| 网页按钮、卡片、表格和坐标 | OCR Web：`vcli run page.png --web --json` |
| 需要直接理解图片含义 | VLM：`vcli run image.png --vlm --json` |
| 同时需要 OCR 定位和视觉理解 | Mix：`vcli run image.png --mix --json` |
| 超长网页/表格（可能数万到十万字符） | 两阶段工作流，见下文 |

## 常用命令

```bash
# 普通 OCR
vcli run ./document.png --json

# 网页 OCR + YOLO + 紧凑布局
vcli run ./page.png --web --json

# 纯 VLM
vcli run ./page.png --vlm --json

# CPU OCR -> 释放资源 -> GPU VLM
vcli run ./page.png --mix --ocr-backend cpu --json

# GPU OCR -> 清理显存 -> GPU VLM
vcli run ./page.png --mix --ocr-backend gpu --json

# 自定义问题
vcli run ./page.png --vlm -p "页面的主要操作和异常状态是什么？" --json

# 调整 Mix OCR token 预算
vcli run ./page.png --mix --mix-ocr-context-tokens 8192 --json

# 禁止向 VLM 注入 OCR，但仍生成 OCR artifact
vcli run ./page.png --mix --mix-ocr-context-tokens 0 --json
```

## 超长 OCR 的 Agent 工作流

不要把完整 OCR JSON 直接复制进提示词。Mix 默认最多注入 16,384 OCR tokens，上限 32,768，并执行：

- 相同文字/位置去重；
- 坐标压缩为百分比；
- 页面首尾保留；
- 九宫格空间抽样；
- 金额、日期、数字、短 UI 标签优先；
- 单项长文本截断；
- 达到预算后停止。

对于十万字符级页面，优先使用两阶段调用：

```bash
# 第一步：生成完整 OCR JSON
vcli run ./large-page.png --web --json

# Agent 只读取与任务相关的字段/区段，然后构造简短问题
vcli run ./large-page.png --vlm \
  -p "根据我关注的表格行，确认其对应按钮、状态颜色和页面意图" \
  --json
```

不要因为 OCR 文件很大就整文件载入 Agent 上下文。先读取 `text` 或检索关键字，需要坐标时再读取相关 `items`。

## Mix artifact

Mix 的主输出会提供：

```json
{
  "text": "VLM summary",
  "engine": "ppocrv6-cpu+qwen2.5-vl-b2",
  "mode": "mix",
  "items": [],
  "ocr": {
    "itemCount": 5000,
    "inlineItemCount": 80,
    "itemsTruncated": true,
    "artifacts": {
      "text": "..._ocr.txt",
      "items": "..._ocr_items.json"
    },
    "context": {
      "includedItems": 600,
      "omittedItems": 4400,
      "injectedTokens": 16370,
      "tokenBudget": 16384,
      "truncated": true,
      "strategy": "spatial-priority-token-budget-v1"
    }
  }
}
```

- `*_ocr.txt`：完整线性文字，适合先阅读/搜索。
- `*_ocr_items.json`：完整文字框、坐标、页面布局。
- `*_output.json`：VLM 结果、有限预览和 artifact 路径。

## OCR/Web JSON

普通 OCR 项只保留重要字段：

```json
{"text":"登录","bbox":[10,20,60,40]}
```

Web 项：

```json
{
  "text":"Export CSV",
  "bbox":[1185,41,1387,96],
  "type":"ui_text",
  "region":"top-right",
  "cluster_id":1
}
```

页面级重复信息集中在：

```json
{
  "layout": {
    "img_size":[1440,1000],
    "item_count":39,
    "patterns":{"has_sidebar":true,"has_grid":true},
    "cluster_summary":[
      {"id":1,"size":5,"arrangement":"vertical","region":"top-right"}
    ]
  }
}
```

`bbox` 已足够推导宽高比，因此不再为每项重复输出 `geometry.aspect`；组大小、排列和区域也不再重复嵌套在每个 item 中。

## 参数

```text
--vlm                           纯 VLM
--mix                           OCR + VLM 顺序执行
--web                           网页/UI YOLO 检测
--json                          保存紧凑 JSON，stdout 仅返回文件路径
-p, --prompt <text>             VLM/Mix 附加问题（拼接到默认提示词后）
--ocr-backend <cpu|gpu>         本次 OCR/Mix 覆盖后端
--mix-ocr-context-tokens <N>    0~32768，默认 16384
--timeout <seconds>             推理超时
--min-confidence <0~1>          空 UI 元素阈值
```

支持 png/jpg/jpeg/webp/bmp/tiff/tif，单文件上限 20MB。

## Agent 调用规则

1. 默认带 `--json`，读取 stdout 返回的文件路径。
2. 不要把 stderr 进度日志当作结果。
3. 只需要文字时不要调用 VLM。
4. 需要颜色、图形关系、页面意图时使用 VLM。
5. Mix 已自动限制 OCR token，但超长页面仍优先使用两阶段工作流。
6. `raw` 只在 VLM 无法解析结构化 JSON 时出现；正常输出不会重复保存原回答。
7. 若模式能力缺失，运行 `vcli init` 增补，不要删除整个工作区。

## 常见错误

| 错误码 | 处理 |
| --- | --- |
| `MODEL_NOT_INSTALLED` | 运行 `vcli init` |
| `MODEL_CAPABILITY_MISSING` | 初始化并选择所需能力 |
| `MODEL_INITIALIZATION_FAILED` | 检查平台、显存、网络和模型文件 |
| `MODEL_RECOGNITION_FAILED` | 增大 `--timeout`，检查显存 |
| `MODEL_TEXT_EMPTY` | 换清晰图片或改用 VLM |
| `INVALID_ARGUMENT` | 检查互斥模式与参数范围 |
