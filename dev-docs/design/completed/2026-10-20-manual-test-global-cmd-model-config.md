# 手动测试指南调整方案：全局命令 + 模型本地 JSON 配置

> 日期：2026-10-20
> 背景：`dev-docs/guides/2026-10-19-v1-v2-manual-test.md` 目前用 shell 变量
> `WF="node ../../dist/cli/index.js"` 和 `MODEL="cc-switch-zhipu-glm/glm-5.3-flash"`
> 拼接命令，使用繁琐。本文分析两项调整的可行性。

## 结论速览

| 调整 | 可行性 | 代码改动 |
|---|---|---|
| 命令 link 成全局指令 `pi-workflow` | 可行 | 零（package.json 已声明 bin） |
| 模型改本地 JSON 配置读取 | 可行 | 零（Pi 原生 settings 链路已打通）；仅 v2-service-demo.ts 参数改可选（1 行级） |

## 调整一：命令全局化

### 方案

仓库根执行一次：

```bash
npm ci && npm run build
npm link
```

之后所有用例直接用全局命令 `pi-workflow`，替代 `$WF`。

### 可行性依据

1. `package.json` 已声明 `"bin": { "pi-workflow": "dist/cli/index.js" }`，npm link 直接复用该声明。
2. `npm link` 创建的是**符号链接**：后续 `npm run build` 重新生成 dist 后，全局命令立即用上新构建，无需重复 link。
3. Windows 下 npm link 在全局 bin 目录生成 `pi-workflow.cmd` shim，行为与 macOS/Linux 一致。
4. `v2-service-demo.ts` 走 `npx tsx`，不依赖 `$WF`，不受影响。

### 风险与注意

- bin 指向 `dist/`，**link 前必须先 build**，否则命令报"找不到模块"。
- 若未来改 bin 名称或路径，需重新 link（当前不会发生）。
- 全局命令与仓库版本强绑定（符号链接），删除仓库或 `npm unlink` 后失效——开发期这是预期行为。

## 调整二：模型改本地 JSON 配置

### 方案（推荐）：不传 `--model`，走 Pi 原生 settings 默认模型

测试命令直接删掉 `--model $MODEL`，如：

```bash
pi-workflow run 01-smoke.js
```

### 可行性依据（源码链路已逐级验证）

1. **本项目侧**：`src/cli/commands/run.ts` 不带 `--model` 时 `options.model` 为 undefined；
   `src/adapters/pi/pi-agent-adapter.ts:50` 中 `modelSpec = options.model ?? this.defaultModel`，
   spec 为空则不向 `createAgentSession` 传 `model`。
2. **Pi SDK 侧**（`@earendil-works/pi-coding-agent` `dist/core/sdk.js:76`）：
   `settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir)`——
   默认加载用户级 `~/.pi/agent/settings.json` 与项目级 `.pi/settings.json`（项目覆盖用户级）。
3. **默认模型解析**（`sdk.js:105-113`）：无显式 model 时走 `findInitialModel`，
   读取 `settingsManager.getDefaultProvider()` / `getDefaultModel()`。
4. **本机现状**：`~/.pi/agent/settings.json` 已配置
   `"defaultProvider": "cc-switch-zhipu-glm"` + `"defaultModel": "glm-5.3-flash"`，
   正是原测试文档写死的 `MODEL` 值。**零配置、零代码，立即生效。**

### 可选增强：项目级隔离（`.pi/settings.json`）

若希望"仓库内跑 workflow 用 A 模型、其他项目用 B 模型"，可在仓库根建 `.pi/settings.json`：

```json
{ "defaultProvider": "cc-switch-zhipu-glm", "defaultModel": "glm-5.3-flash" }
```

项目级覆盖用户级。注意：**项目级 settings 需要 project trust**（在该目录跑过 pi 并信任项目），
未信任时项目配置不加载、静默回退用户级。当前用户级已就绪，此项仅在未来需要隔离时启用。

### 否决项：CLI 自建配置文件（如 `.pi-workflows/config.json`）

CLI 自己读一个 json 的 defaultModel——Pi 已有完全同能力的 settings 机制，重复造轮子，不做。

### 边界确认

- **脚本级 model 仍优先**：`04-fallback-race.js` 内部故意写坏的模型 spec（C3/C4 用例）
  不受默认模型影响，用例照常成立。
- **`v2-service-demo.ts`**：目前 `process.argv[2]` 强制要求模型参数，需改为可选
  （不传则 `service.start` 不带 model，走同一 settings 默认链路）。这是唯一一处代码改动。
- **常见问题条目更新**：`model not found` 提示改为"检查 settings.json 的 defaultModel/defaultProvider
  或显式传 --model"。

## 改动清单

| 文件 | 改动 |
|---|---|
| `dev-docs/guides/2026-10-19-v1-v2-manual-test.md` | 环境准备改为 `npm link`；全文 `$WF` → `pi-workflow`；删除所有 `--model $MODEL` 与 `MODEL=` 变量；§3 命令、§5 常见问题同步 |
| `dev-examples/manual-test/v2-service-demo.ts` | argv[2] 改可选，注释说明默认模型来自 `~/.pi/agent/settings.json` |

## 引用

- Pi Settings Reference（defaultProvider/defaultModel）：
  `D:/DevTools/npm-global/node_modules/@earendil-works/pi-coding-agent/docs/settings.md`
- Pi Configuration（用户级/项目级 settings 文件位置与 trust）：
  `D:/DevTools/npm-global/node_modules/@earendil-works/pi-coding-agent/docs/configuration.md`
- Pi Models（模型发现与 models.json）：
  `D:/DevTools/npm-global/node_modules/@earendil-works/pi-coding-agent/docs/models.md`
- 本项目链路：`src/adapters/pi/pi-agent-adapter.ts`、`src/adapters/pi/model-resolver.ts`
- Pi SDK 链路：`@earendil-works/pi-coding-agent/dist/core/sdk.js`（createAgentSession / findInitialModel）、
  `dist/core/settings-manager.js`（getDefaultModel / projectSettings）
