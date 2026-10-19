# pi-agentic-workflow

基于 pi coding agent 的动态 agentic workflow 编排研究与实现。参考 `thirdparties/` 下的两个第三方实现，探索将一个请求变成跨隔离子 agent 分发、按任务路由模型、交叉检查并合成最终结果的编排方案。

## 概述

- 调研动态工作流编排模式：多 agent 协作、并行执行、控制流、验证与检查点
- 参考实现：
  - [pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows) —— 为 Pi 构建的动态工作流编排，面向全库审计、多视角评审、大型重构与带源检索的研究
  - [opencode-dynamicworkflows](https://github.com/mickorz/opencode-dynamicworkflows) —— OpenCode 的动态工作流编排（agents、并行、控制流、checkpoint、可复用 workflow）
- 研究笔记与设计方案沉淀在 `dev-docs/`（不进 git），读者向文档见 `docs/`

## 快速开始

```bash
git clone https://github.com/mickorz/pi-agentic-workflow.git
cd pi-agentic-workflow
```

第三方参考仓库已被 `.gitignore` 忽略，不随仓库分发，按需手动获取：

```bash
git clone https://github.com/QuintinShaw/pi-dynamic-workflows thirdparties/pi-dynamic-workflows
git clone https://github.com/mickorz/opencode-dynamicworkflows thirdparties/opencode-dynamicworkflows
```

## 目录结构

```text
docs/          读者向文档（英文 + zh-CN 中文版）
dev-docs/      开发过程文档（不进 git）
dev-examples/  开发期沙盒（不进 git）
thirdparties/  第三方参考仓库（不进 git）
```

更多文档：[快速开始](docs/getting-started.md) · [操作指南](docs/how-to-guides.md) · [常见问题](docs/troubleshooting.md) · [中文文档](docs/zh-CN/getting-started.md)
