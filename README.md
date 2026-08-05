# code-vcli — AI Agent Skill

AI 编码模型（如 GLM、DeepSeek、Qwen-max）能写代码，但**无法「看见」屏幕**。

`code-vcli` 给它们一双眼睛：把截图 / 网页截图 / 文档图片转成结构化文本和 JSON，让没有视觉能力的模型也能看懂 UI 布局、按钮位置、卡片结构，准确完成 web 开发任务。

推理在本地完成，图片不上传。

## 安装

```bash
# 克隆仓库
git clone https://git.dianplus.cn/shanfan/code-vcli.git
cd code-vcli

# 安装依赖并构建
npm install
npm run build

# 全局安装
npm install -g .
```

安装过程会自动部署运行依赖、用户级 `vcli` 启动入口并加入 PATH。首次安装后重新打开终端，即可直接运行：

```bash
vcli help
```

## AI Agent Skill

仓库提供 `code-vcli` Skill，让 AI Agent 调用 `vcli` CLI 对截图执行本地视觉识别与网页 UI 元素解析。

Skill 文件位于 `skills/code-vcli/SKILL.md`，可直接加载使用。

## 快速开始

```bash
vcli init                    # 初始化环境
vcli run ./image.png         # 普通模式：整图 OCR
vcli run ./screenshot.png --web --json   # Web 模式 + JSON 输出
```

## 许可

[MIT](./LICENSE)。