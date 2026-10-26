# pi-coding-agent SDK：noTools:"all" 会连 customTools 一起禁掉

- 日期：2026-10-21
- 版本：@earendil-works/pi-coding-agent@1.3.0（^1.2.0 解析）
- 场景：AM-P0 T2 PiSessionOpener（会话只启用自研五工具）

## 问题现象

`createAgentSession({ noTools: "all", customTools: [五工具] })` 期望"禁内置工具、保留自定义工具"，
实际 customTools 也不可用（模型看不到任何工具）。

## 排查过程

读 SDK 源码（dist/core/sdk.js → agent-session.js `_refreshToolRegistry`）：

1. `sdk.js`：`noTools === "all"` 时 `defaultToolNames = []`，且
   `allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined)` → **空匹配器**。
2. `agent-session.js` `_refreshToolRegistry`：`allCustomTools`（含 customTools）先经
   `_isAllowedTool(name)` 过滤——空匹配器下全部被剔除，**自定义工具根本进不了注册表**；
   激活循环 `allowedTools(toolName)` 同样全 false。

即文档里 "start with no tools enabled" 对 customTools 同样生效，"custom tools remain enabled"
只适用于非空 `tools` 名单（不含 `mcp__` 前缀条目时）。

## 根因

`noTools:"all"` 生成的 allowedToolNames 是**空匹配器**（匹配不到任何名字），而不是
"仅禁内置"的语义；customTools 受同一 allowed 过滤器约束。

## 解决方案

需要"只启用自定义工具"时，把自定义工具名显式写进 `tools` 白名单：

```ts
const { session } = await createAgentSession({
  cwd,
  tools: customTools.map((t) => t.name), // 只启用五工具：内置/MCP 默认不激活
  customTools,
  sessionManager,
});
```

`allowedTools` 命中自定义工具名 → 进注册表并被激活；未命中的内置工具不激活。

## 预防/注意事项

- 不要用 `tools: []`（空名单同样等于全禁，含 MCP；见 sdk.d.ts 注释）。
- 自研工具集入口（PiSessionOpener）已按名单白名单实现；T9 真机验收时应再次确认模型可见
  且仅可见五工具。
- 相关：V1 的 PiAgentAdapter 用 `tools: [...内置名]` 白名单控制 profile，同源机制。
