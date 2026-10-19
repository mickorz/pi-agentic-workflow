# 快速开始

从零到本地跑通本调研仓库。英文版见 [../getting-started.md](../getting-started.md)

## 前提条件

- Git
- Node.js ≥ 20（可选，仅在需要运行第三方参考仓库时安装）

## 安装

```bash
git clone https://github.com/mickorz/pi-agentic-workflow.git
cd pi-agentic-workflow
```

`thirdparties/` 已被 git 忽略、不随仓库分发，按需手动获取参考仓库：

```bash
git clone https://github.com/QuintinShaw/pi-dynamic-workflows thirdparties/pi-dynamic-workflows
git clone https://github.com/mickorz/opencode-dynamicworkflows thirdparties/opencode-dynamicworkflows
```

## 验证

```bash
ls thirdparties
# 获取后应包含：opencode-dynamicworkflows  pi-dynamic-workflows
```

## 第一次运行

本仓库处于研究阶段，暂无可运行代码。建议从两个参考仓库的文档读起：

- `thirdparties/pi-dynamic-workflows/README.md`
- `thirdparties/opencode-dynamicworkflows/README.md`

调研笔记存放在 `dev-docs/research/`（不进 git）。

## 下一步

- 操作指南：[how-to-guides.md](how-to-guides.md)
- 常见问题：[troubleshooting.md](troubleshooting.md)
