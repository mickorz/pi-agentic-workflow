# Workflow DSL（P1）

> P1 新增：fallback / race / workflow / check / verify / retry / fileExists / commandSuccess。P2 将扩充 checkpoint 与 resume。
> 脚本必须是 `.js` 文件，首条语句必须是纯字面量的 `export const meta = {...}`。

## 脚本信封

```js
export const meta = {
  name: "my_workflow",            // 必填，snake_case
  description: "一句话描述",       // 可选
  phases: [{ title: "分析" }],     // 可选，声明阶段标题
}
// ...编排正文（顶层 await）
return resultValue
```

约束：
- `meta` 只能是纯字面量（对象/数组/字符串/数字/布尔/null）；不允许插值、spread、计算属性、方法。
- 禁用 `Date.now()` / `Math.random()` / `new Date()`（破坏确定性重放）；时间戳/随机数经 `args` 传入。
- 脚本必须至少调用一次 `agent()`；纯计算会被拒绝。

## 原语（P1 新增）

### `fallback(nodes)` → Promise<unknown>

串行竞争候选：首个 success 结果返回。「agent 耗尽失败返回 null + 新增闸门登记」视为候选失败，自动换下一候选；全部候选失败返回 null（fallback 是显式降级机制，闸门登记被吸收）。结构性错误直接上抛。

### `race(nodes)` → Promise<unknown>

并行竞争：首个 **success** 分支胜出并取消其余候选（局部中止面，不影响 run 级中止）。失败分支不获胜；全部候选可恢复失败 → null；结构性错误直接上抛。

### `workflow(ref, args?)` → Promise<unknown>

子流程调用。`ref` 为脚本路径字符串（`./child.js`）或 `{ scriptPath, label? }`。
- 路径解析：**父脚本目录优先**，其次运行 cwd（CLI 自动传入根脚本路径）。
- 子流程共享父级并发上限、agent 配额、中止信号与日志；参数与返回值均 structuredClone 隔离。
- 防护：自环/祖先调用检测、嵌套深度上限（缺省 3，可配 `maxWorkflowDepth`）。

### `check(condition, message?)` → Promise<true>

确定性事实检查：`condition` 返回 `true` → 通过；返回 `false` → 抛 `CHECK_FAILED`（可恢复失败：sequence 停止、fallback 换候选、parallel 塌缩 null）；`condition` 自身 throw → 结构性错误（检查代码 bug 不许伪装成验证未通过）。

### `fileExists(target)` → boolean / `commandSuccess(cmd, timeoutMs?)` → Promise<boolean>

确定性检查 helper（供 `check()` 使用）：文件存在性（相对 cwd）；命令退出码 0（超时视为失败，缺省 30s）。

### `verify(item, opts?)` → Promise<{real, realCount, total, votes}>

AI 对抗式审查：`opts.reviewers`（缺省 2）个独立 reviewer agent 尝试反驳 item（schema 结构化输出 `{real: boolean, reason?}`），投票比 ≥ `opts.threshold`（缺省 0.5）判真。职责分离：check 客观事实 / verify AI 质量判断。

### `retry(thunk, opts?)` → Promise<unknown>

有界重试糖：`opts.attempts`（缺省 3）次内直到 `opts.until(result)` 通过，返回最后一次结果（不抛错）。

## 原语（P0）

### `agent(prompt, options?)` → Promise\<unknown\>

每次调用创建一个**独立隔离的子会话**（in-memory，互不共享上下文）。

| 选项 | 类型 | 说明 |
|---|---|---|
| `label` | string | 展示名（缺省按 phase + 序号生成） |
| `phase` | string | 覆盖当前 phase 标记 |
| `agentType` | "explore" \| "general" | 工具权限：`explore`（缺省）只读白名单 read/grep/find/ls；`general` 可写 read/bash/edit/write |
| `model` | string | "provider/modelId" 或裸 modelId；缺省用运行级默认（`--model`） |
| `schema` | object | JSON Schema；传入时要求模型只输出符合 schema 的 JSON，返回解析后的对象 |
| `timeoutMs` | number \| null | 本 agent 超时（毫秒）；null = 无上限 |
| `retries` | number | 可恢复失败后的重试次数（0-3） |

失败语义：
- 可恢复失败（网络抖动等）自动重试；耗尽后**返回 null** 并登记阶段失败闸门（下一 phase 边界或 run 终检终止 workflow，不会静默成功）。
- 结构性错误（脚本校验错、未知 agentType、模型不存在）直接抛出，不重试。
- 取消/超时 → 终止为 cancelled/失败态，绝不报告成功。

### `parallel(thunks)` → Promise\<unknown[]\>

并行执行；`thunks` 必须是**函数数组**（`() => agent(...)`），不是 Promise 数组。
可恢复失败塌缩为 `null`（对应位置），不可恢复失败终止整个 run。输出按输入索引排列。

### `sequence(nodes)` → Promise\<unknown\>

串行执行，前一个节点返回值作为下一个节点入参（`(prev) => ...`）。
- 抛出型可恢复失败 → 序列立即停止返回 `null`。
- agent 耗尽失败返回 null → 继续传递（与参考实现一致），由闸门终止 run。
- 结构性错误上抛；取消向上传播。

### `phase(title)`

标记阶段边界（可观测性 + 阶段失败闸门触发点）。

### `log(...values)` / `console.log`

写运行日志（随结果返回；不输出到终端 stdout）。

### `args`

`--args '{"key": value}'` 传入的 JSON 全局（JSON 可序列化数据）。

### `setConcurrency(n)`

运行中调整并发上限（1-16，钳制）。

## 完整示例

见 `examples/`：smoke / parallel / sequence / quality-gates / nested（父）/ nested-child（子）。
