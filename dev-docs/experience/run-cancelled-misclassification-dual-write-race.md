# 失败 run 谎报 run.cancelled 事件（事件流与 manifest 终态矛盾）

## 问题现象

V2-P2 浏览器验收门中，checkpoint 被人工拒绝后：UI 显示「已中断」，`GET /api/runs/:id` 返回 `status=running + effectiveStatus=interrupted`，而 events.jsonl 最后一条是 `run.cancelled`、journal 已终结、Worker 进程已退出。同一 run 出现三种互相矛盾的信号。

单独最小复现（in-process engine + fake runner + 抛错脚本）：

```
events: 1:run.started 2:node.started 3:node.completed 4:run.cancelled
manifest: failed | Error: boom
```

事件说 cancelled、manifest 说 failed——任何依赖事件流推导状态的消费端（Web 前端 runModel、SSE 观察者）都会得出错误结论。

## 排查过程

1. 浏览器门 G7（拒绝路径）断言「失败」超时 → 用 Playwright response 监听确认 decision POST 200、checkpoint 落 rejected，但终态停在 running/interrupted。
2. 读 events.jsonl：`checkpoint.resolved(approved:false)` 之后紧跟 `run.cancelled`——拒绝应该走 failed，为什么会发 cancelled？
3. 追 `run.cancelled` 唯一发射点（workflow-runtime.ts 终态事件）：`aborted = shared.aborted || signal.aborted || code===WORKFLOW_ABORTED`。
4. 查 `shared.aborted` 赋值点：`executeWorkflow` 的 catch 里 `if (!scope.parent) shared.aborted = true`——**任何**根脚本异常（包括普通 Error 和 CHECKPOINT_REJECTED）都置位。
5. 注释自证：「用于中止后续调度」——它是内部调度闸门，不是「用户取消」的证据；终态事件却把它当取消依据。

## 根因

`shared.aborted` 承担了两个语义：①中止后续调度（任何根异常都该置位）②终态事件分类（只有真取消才该 cancelled）。两个语义耦合在一个标志上，普通失败 run 全部谎报 run.cancelled。

附带发现第二 bug（同一次浏览器门暴露的**双写竞态**）：Server 端 `wireCheckpointRecording` 收到 `checkpoint.resolved` 无条件把 manifest `waiting_checkpoint→running`；拒绝路径下 Worker 在 resolved 事件之后微任务级就写终态 failed，Server 的回翻经 IPC 延迟**晚于** Worker 终态写入落地，把 failed 覆盖回 running → pid 已死 → effective=interrupted。

## 解决方案

1. workflow-runtime.ts 终态事件分类：`cancelled = signal.aborted || code===WORKFLOW_ABORTED`（去掉 `shared.aborted`）；脚本异常（含人工拒绝 CHECKPOINT_REJECTED）发 `run.failed`。`shared.aborted` 保留原调度语义不动。
2. run-service.ts wireCheckpointRecording：`approved:false` 不回翻 running（拒绝即奔终态，回翻无意义且引入竞态窗口）。

## 预防/注意事项

- **状态标志单一语义原则**：一个布尔量不要同时服务「内部调度」与「对外分类」两种用途，否则分类口径被调度需求污染。
- **双写竞态是跨进程事件驱动的固有风险**：事件处理器回写状态前必须考虑「事件发出者此刻可能已推进到更晚状态」——无条件回写 = 用旧信息覆盖新事实。加前置条件读（仅 waiting 才回翻）不够，还要考虑事件语义（拒绝=即将终态，别回翻）。
- 断言事件流与 manifest **一致性**的测试此前缺失：单测只查 manifest.status，事件类型从未被断言。终态一致性（事件类型 ↔ manifest.status 映射）值得专门的契约测试。
- 浏览器级 E2E 门抓到两个单测都放过的 bug——真实浏览器+真实子进程链路（REST→IPC→Worker→SSE 回流）是单测拼不出来的覆盖面。

## 续章：approve 分支的同类竞态（审计发现，验收后补修）

首次验收审计中，审计员重跑 `cd web && npm run mock` 抓到 xss.spec.ts 失败，并在 API 层 2/2 复现：**checkpoint 为最后节点**的 workflow，approve 后 manifest 卡 running、effectiveStatus=interrupted，而 events.jsonl 已有 run.completed、result.json 已有结果。上文修复只覆盖了 reject 分支（`approved!==false` 才回翻），approve 分支的 waiting→running 回翻仍在，且当 checkpoint 后无异步节点时 Worker 在回翻落地前就已写终态。

第一次补修（终态不可逆守卫：TERMINAL_STATUSES 内丢 status）在跨进程下仍然不原子：worker-supervisor 全栈回归「单跑过/全文件跑稳定挂」，DEBUG 日志实锤 events 已到 5:run.completed 而 manifest 仍 running——守卫的 read-check-write 在 Server/Worker 两进程间存在交错窗口（Server 读 waiting→Worker 写 completed→Server 写 running 覆盖）。

最终修复（双层）：
1. run-store.ts `withManifestLock`（manifest.lock 文件锁：openSync "wx" 获锁、Atomics.wait 阻塞等待 15ms/轮、陈锁 4s mtime 自愈 rmSync、finally 释放），updateManifest 整体（含终态守卫判定）移入锁内；
2. engine/CLI resume 传 opts.force 允许跨终态恢复；failRun 改为读后非终态才写 interrupted。

教训：
- **read-check-write 不是锁**：同一进程内的顺序代码可依赖同步性，跨进程的「检查后再写」永远存在 TOCTOU 窗口；互斥必须显式构造（锁/单写者/事务）。
- **IPC 延迟窗口把偶发竞态变成可复现**：全文件测试负载拉大 readline→事件订阅→回翻的延迟，使单独跑永远绿的用例稳定红——负载下重跑全文件是验证跨进程修复的必要手段。
- **异步无消息互斥的文件锁三要素**：O_EXCL 创建（获锁原子）、陈锁自愈（持锁者崩溃不永久卡死）、有界等待（Atomics.wait 让出 CPU 而非忙转）。
