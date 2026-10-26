# 全局 pi-workflow 链接指向旧仓库导致 command is not defined

## 问题现象

在本仓库（github-rearch 工作区）新写的 workflow 脚本使用了 `command()` 原语，CLI 执行报：

```
❌ 执行失败：ReferenceError: command is not defined
```

而 `src/runtime/workflow-runtime.ts` 源码里 `command` 明明在 globals 里。

## 排查过程

1. 检查本仓库 `dist/` —— 根本不存在（未构建过）；
2. 追 `which pi-workflow` → `/d/DevTools/npm-global/pi-workflow` → shim 实际执行
   `D:/DevTools/npm-global/node_modules/pi-agentic-workflow/dist/cli/index.js`；
3. 该 node_modules 下的 `pi-agentic-workflow` 是符号链接，指向 `/e/WorkProjects/pi-agentic-workflow` ——
   **另一份旧仓库检出（E: 盘）**，其 dist 构建产物不含 `command` 原语（旧版本）。

## 根因

全局 npm link 是历史操作（10-20），链接目标不是当前开发仓库。换工作区/换目录开发时，
全局命令仍在跑旧代码，报的是「原语不存在」这类迷惑性错误而非版本错误。

## 解决方案

在当前开发仓库根执行（CLAUDE.md 手动测试约定第 1/3 条）：

```bash
npm run build && npm link
```

重新构建并让全局符号链接指向当前仓库。验证：

```bash
grep -c "    command," dist/runtime/workflow-runtime.js   # >0
```

## 预防/注意事项

- 换工作区后第一次跑 `pi-workflow` 前，先确认链接指向：
  `readlink -f $(npm root -g)/pi-agentic-workflow`（或等价方式）；
- 报「X is not defined（某原语）」且 src 里明明存在时，第一反应查 **dist 是否过期/链接是否指错**，
  而不是怀疑脚本写法；
- 本仓手动测试约定的「link 前必须先 build」同样适用于「link 必须在目标仓库执行」。
