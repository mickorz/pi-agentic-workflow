# 微信服务单轮预算限制（Turn Limits）——代码实现与统计逻辑调研

日期：2026-10-26 ｜ 类型：代码调研 ｜ 背景：WX-P3.1 将服务单轮上限从默认 12/20/5min 提至 **60 次请求/100 工具/15 分钟**（`--agent-limits 60,100,900000`）

## 1. 总体设计：双层预算

出自 V2.1 §6 / AM-P0 T1，两层相互独立、共同生效：

| 层 | 对象 | 粒度 | 实现 |
|----|------|------|------|
| 累计预算 | 每用户总 token 消耗 | 跨 Turn、跨重启持久 | `CumulativeBudget` 接口 → 生产实现在 `src/gateway/wechat-app.ts:185`（适配 `BudgetTracker`） |
| 单 Turn 硬限 | 一次会话回合（一条用户消息触发的 agent loop） | LLM 请求数 / 工具调用数 / 时长 | `TurnBudget` 类（`src/agent-host/agent-budget.ts:23`） |

关键语义：**超限「安全停止」只中止 Agent Loop（会话循环），不影响已通过工具启动的 Workflow Run**——工作流在独立 worker 进程里继续跑完并正常落盘/通知。这就是用户看到「⚠️ 已达单轮预算上限…已启动的任务不受影响」警告、但草稿最终照样入箱的原因。

## 2. 单 Turn 硬限：TurnBudget（三维度计数器）

文件：`src/agent-host/agent-budget.ts`（纯逻辑，无 IO）

```ts
export class TurnBudget {
  private llmRequests = 0;   // onLlmRequest() 递增
  private toolCalls = 0;     // onToolCall() 递增
  private startedAt = 0;     // activate() 记录计时起点
  private active = false;    // activate()=true / settle()=false

  exceeded(): ExceedReason | null {
    if (!this.active) return null;
    if (this.llmRequests > this.limits.maxLlmRequests) return "llm_requests";
    if (this.toolCalls > this.limits.maxToolCalls) return "tool_calls";
    if (Date.now() - this.startedAt > this.limits.maxDurationMs) return "duration";
    return null;
  }
}
```

- 默认值：`DEFAULT_TURN_LIMITS = { maxLlmRequests: 12, maxToolCalls: 20, maxDurationMs: 300_000 }`（`src/agent-host/types.ts:154`）。
- 构造时可传 `Partial<TurnLimits>` 覆盖（`{ ...DEFAULT_TURN_LIMITS, ...limits }`），即 `--agent-limits` 只需给全三值。
- 判定是**后验式**（计数/时长「大于」上限才触发），检查时机见下节；`duration` 维度靠定时器兜底（即使无新事件也会触发）。
- `begin(userId)`：Turn 开始前查累计预算余量，不足（`remaining <= 0`）直接不开回合，抛「累计 Token 预算已用尽，本轮不执行（已启动任务不受影响）」。

## 3. 执行链路：事件如何被计数与拦截

入口 `src/agent-host/agent-host.ts:130 runTurn()`（每条用户消息一个 Turn）：

```
runTurn(userId, entry)
 ├─ new TurnBudget(cumulative, deps.limits)          :135
 ├─ budget.begin(userId) 不足→markFailed+抛错        :136-140
 ├─ budget.activate()（计时起点）                     :145
 ├─ session.observe(cb)                              :153
 │    ├─ e.type=="llm_request" → budget.onLlmRequest()
 │    ├─ 其余事件（tool_call）→ budget.onToolCall()
 │    ├─ 累计容差检查 overCumulativeTolerance(×1.2)→ tripLimit("cumulative")
 │    └─ budget.exceeded() 命中 → tripLimit(reason)
 ├─ setInterval(budget.exceeded, budgetPollMs=500ms) :165-170（duration 兜底；timer.unref 不阻进程退出）
 ├─ await session.prompt(entry.text)                 —— agent loop 真正执行
 │    └─ tripLimit() 内部: session.abort()           :149-152（只停会话循环）
 ├─ budget.settle(userId, outcome.usage)             :175（成功路径入账）
 └─ catch: budget.settle(userId, currentUsage() ?? 零) :192（失败也入账，已读实时用量则按实际）
```

超限后的用户可见行为（`agent-host.ts:178`）：prompt 正常返回后，回复文本前拼接
`⚠️ 已达单轮预算上限（${limitHit}），已安全停止；已启动的任务不受影响，可稍后查询任务状态继续跟进。`（`limitHit` ∈ llm_requests / tool_calls / duration / cumulative）。

### 事件来源（pi 会话适配层）

`src/agent-host/pi-session.ts:76-96`：订阅 pi `session` 事件并翻译成 `TurnEvent`（`src/agent-host/types.ts:34`，仅两种）：

- `message_end` + `role==="assistant"`（一次 LLM 响应完成）→ `{type:"llm_request"}`，同时把 `event.message.usage.input/output` 累进 `inputTokens/outputTokens`（`currentUsage()` 实时可读，供容差检查与失败入账）；
- `tool_execution_start` → `{type:"tool_call"}`。

注意：计的是 **agent loop 自身**的 LLM 请求与工具调用；工作流内部各 agent 的 LLM 调用发生在 worker 子进程，**不计数**（所以「完整 prepare 撞 llm_requests 上限」耗的是会话循环+五工具编排的请求，而非工作流内部 agent）。

## 4. 配置入口：--agent-limits 的传递链

```
CLI: pi-workflow wechat service start --agent-limits 60,100,900000 ...（wechat-service.ts:241 声明同款 flags）
 │
 ├─ writeEcosystemConfig()（wechat-service.ts:147）
 │    生成 <data>/ecosystem.config.cjs，args = ["wechat","start","--registry",<abs>,"--scripts",<abs>,"--data",<abs>, ...其余 flags 原样透传]
 │    → PM2 按此 args 拉起 bot 进程
 ▼
 bot 进程: wechat start 解析（wechat.ts:130-139）
    CSV "llm,tools,ms" → { maxLlmRequests, maxToolCalls, maxDurationMs }（非法格式 exit 2）
 ▼
 new WechatApp({ ..., agentLimits })（wechat.ts:238，仅 routing-mode=agent 有意义）
 ▼
 WechatApp 构造（gateway/wechat-app.ts:198）：new AgentHost({ ..., limits: deps.agentLimits })
 ▼
 AgentHost.runTurn：new TurnBudget(cumulative, deps.limits)
```

要点：
- **未传 flag 时**用 `DEFAULT_TURN_LIMITS`（12/20/300000）。
- `service restart` 沿用上次 ecosystem 配置；**改上限必须 `service stop` + 带 flag `service start`**（重写 ecosystem）。
- 验证生效：`.pi-wechat/ecosystem.config.cjs` 内 `args` 数组应含 `"--agent-limits","60,100,900000"`；`pi-workflow wechat service status` 看 PM2 online。

## 5. 统计与入账逻辑

三处独立记录，各有用途：

1. **累计预算入账（决策用）**：`TurnBudget.settle()` → `CumulativeBudget.settle()`（`wechat-app.ts:189`）→ `BudgetTracker.record()`（`src/dispatch/limits.ts:70`）追加写 `<data>/budget.jsonl`，每行 `{userId, tokens, at}`；`used(userId)` 全量重读求和（断裂行跳过），重启后额度延续。上限来自 `--budget-tokens`（`maxTokensPerUser`，0/未传=不限）。
2. **Turn 回执审计**：`WechatApp.onTurnCompleted`（`wechat-app.ts:201-208`）统一出口——`budget.record(总tokens)`（与 settle 同额，追加落盘）+ `stats.recordTurn(总tokens)`（F8 累计统计）+ `audit.record({action:"am.turn.completed", ...})`。注意注释：回执仅此入队一次，防真机双发。
3. **累计容差实时中止**：`overCumulativeTolerance(cumulative, userId, used, tolerance=1.2)`（`agent-budget.ts` 尾部）——会话进行中实时 `currentUsage()` 已用 tokens 超过「剩余×1.2」即 tripLimit("cumulative")，不等 Turn 结束。

相邻的限流（同文件、不同机制，勿混淆）：`RateLimiter`（`limits.ts:30` 附近，`--rate-max` 每用户滑动窗口频率限制，管「每分钟条数」不管 token）。

## 6. 当前生效值与运维备忘

- 本机（2026-10-26 起）：`--agent-limits 60,100,900000` = 60 次 LLM 请求 / 100 次工具调用 / 15 分钟单轮时长；`--budget-tokens` 未设（累计不限）。
- 依据：完整 article-prepare 真机 ~8.5 分钟、会话循环 LLM 请求 >12 → 默认 12/5min 必撞；60/100/15min 留 5 倍/4 倍余量。
- 修改方法：`pi-workflow wechat service stop` → `pi-workflow wechat service start <全部原 flags> --agent-limits llm,tools,ms`（flags 见 `.pi-wechat/ecosystem.config.cjs`，文件头注明勿手工编辑）。
- 撞限 ≠ 任务失败：工作流继续后台跑完（journal/notify 正常），仅会话侧停止并提示；用户可发「任务列表/进度如何」续跟。

## 7. 关键文件索引

| 文件 | 职责 |
|------|------|
| `src/agent-host/agent-budget.ts` | TurnBudget 三维计数/判定、CumulativeBudget 接口、overCumulativeTolerance |
| `src/agent-host/types.ts:146-157` | TurnLimits 类型 + DEFAULT_TURN_LIMITS（12/20/300000） |
| `src/agent-host/agent-host.ts:130-197` | runTurn：begin/activate/observe/timer/abort/settle/超限文案 |
| `src/agent-host/pi-session.ts:76-96` | pi 事件 → llm_request/tool_call 计数、currentUsage 累计 |
| `src/cli/commands/wechat.ts:130-139,238` | --agent-limits CSV 解析、注入 WechatApp |
| `src/cli/commands/wechat-service.ts:147-191` | service start 生成 ecosystem，flags 透传 bot 进程 |
| `src/gateway/wechat-app.ts:84,122,185-208` | agentLimits deps、BudgetTracker、cumulative 适配、onTurnCompleted 入账/审计 |
| `src/dispatch/limits.ts:53-110` | BudgetTracker（budget.jsonl 追加+求和）、RateLimiter |
