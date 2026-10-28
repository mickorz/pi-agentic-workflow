# WX-QA-P0 执行报告（失败任务统计与自动诊断 · P0 里程碑）

> 阶段：需求 A P0（T0 口径定稿 + T1 关联校验脚本 + T2 生产数据校准）
> 完成时间：2026-10-28
> 方案：`dev-docs/planning/2026-10-27-失败任务统计与自动诊断执行方案.md`（V1.2，两轮外部评审修订）
> 里程碑状态：**完成**（T3 P0.5 每日报告脚本待启动）

## 一、交付清单

| 交付物 | 路径 | 说明 |
|--------|------|------|
| 方案 V1.2 | `dev-docs/planning/2026-10-27-失败任务统计与自动诊断执行方案.md` | 三层口径（请求启动/Run 终态/通知交付）、asOf 能力分级、7 项验收清单、第八节 T2 校准记录 |
| 关联校验脚本 | `dev-examples/manual-test/wx-quality/wx-linkage-check.py` | 只读七项校验；stdout [OK]/[WARN]/[FAIL] + `=== ALL DONE ===` 契约；exit 0/1 |
| Example 测试 | `dev-examples/manual-test/wx-quality/wx-linkage-check-Example.py` | 合成夹具，14/14 PASS |
| 生产校验产物 | `.pi-wechat/quality/linkage-2026-10-2{7,8}.json` | 两日生产数据实测报告 |

## 二、七项校验实现要点

1. **三向 runId 差集**（audit.target.runId ↔ tasks.runId ↔ runs 目录）：差集只报告不判 FAIL（可能为正常时序）。
2. **attemptId 一致性与去重**：unknown/unresolved 一律以 `run-attempts.attemptId` 为准（一次尝试多条审计事件不虚高）；`launched` 未 link 标 unresolved（超时也不判失败，AM-P0 原则）。
3. **孤立 Run**：run-links 有 runId 无 TaskBinding → 单列人工核对清单，不自动判失败。
4. **消息到审计覆盖率**：可关联集合 = audit messageId ∪ run-attempts originMessageId ∪ tasks messageId；未关联入 unclassified（不排除出报告）。
5. **应通知入队覆盖**：应通知终态 = completed/failed/interrupted（对齐 RunMonitor.pollOnce 实测入队分支，cancelled 无入队）；缺失即 FAIL（唯一 FAIL 线）。
6. **两源数量差异率**：inbox 首见 vs chat-logs 入站，只报差异不下"丢失"结论。
7. **updatedAt 链单调性**：asOf 折叠可行性验证。

## 三、测试与验证证据

- Example 合成夹具：14/14 PASS——含 unknown 按 attemptId 去重（2 条审计 → 1）、跨日 asOf 折叠取 interrupted（次日 completed 不泄漏）、断裂行 2 条容忍、应通知未入队 → 1 FAIL → exit 1 契约。
- WX-MOCK 留存数据冒烟（approval-pass 场景 data 目录）：FAIL 0 / WARN 1；unclassified 2 条为审批回复"批准"——发现审批交互无 messageId 关联的真实盲区（校准 C2）。
- 生产 `.pi-wechat` 两日实测：FAIL 0 / WARN 3；chat-logs 无断裂行。

## 四、T2 生产数据五项口径校准（已回写方案第八节）

| # | 发现 | 校准决定 |
|---|------|----------|
| C1 | `.pi-workflows/runs` 仓库级共享（74 个中 67 个与微信无关） | Run 层分母发现源 = tasks ∪ run-links ∪ audit run.start；runs 仅证据补充 |
| C2 | 审批回复类消息（批准/拒绝/恢复任务）无 messageId 关联 | unclassified 规则补审批指令词表，归类"审批/控制交互" |
| C3 | ChatLog 10-27 晚部署，10-27 无 chat-log 文件 | 报告标注统计启用日 2026-10-28 |
| C4 | 生产 run-links 有 8 个孤立 Run；当日出站含「处理中中断…转入人工核对」 | 孤立 Run 清单保留人工核对语义，P0.5 报告必列 |
| C5 | 生产 run-attempts 当日 0 条（legacy 路径为主） | unknown/unresolved 指标保留，首期基数可能为 0 不隐藏 |

## 五、开发中踩的坑（3 个，均为脚本首版缺陷，Example 逐个暴露）

1. JSONL 读取未防御非 dict 行（裸字符串行 json.loads 成功返回 str）→ read_jsonl 非字典计断裂跳过。
2. 集合推导式取值表达式与过滤条件字段写错（`t.get("runId")` vs `t.get("target",{}).get("runId")`）→ 集合全 None，join 崩溃。
3. 删模块级全局后函数内残留 `date` 引用 → NameError；函数签名补参修复。

## 六、遗留与下一步

- **T3**（P0.5）：wx-quality-report.py 每日三层报告 + Example（实现约束：C1/C2 校准）。
- **T4/T5**：WX-MOCK 夹具验证 + 生产首基线人工抽核（≥3 种真实异常逐项核对 + 7 项验收清单勾验）。
- **8 个孤立 Run** 待人工核对（多为 10-27 agent 恢复流程产物，见 linkage JSON check3.orphanRuns）。
- 审批指令词表（C2）在 T3 实现时落地。

---

## 增补：P0.5 里程碑（T3，2026-10-28 同日完成）

**交付：**

| 交付物 | 说明 |
|--------|------|
| `wx-quality-report.py` | 三层每日报告：请求启动/Run 终态（asOf+final 双口径）/通知交付（入队覆盖率+发送成功率）；snapshots/daily 快照存档；stdout 四指标契约 |
| `wx-quality-report-Example.py` | 合成夹具 20/20 PASS |
| `wx-quality/README.md` | 用法 + 定时挂法（schtasks/cron）+ 口径速查 |

**Example 覆盖的关键断言：** 跨日双口径差异（asOf interrupted=1/completed=1 vs final 0/2）、unknown 按 attemptId 去重、unresolved 超 15min 窗口单列不判失败、审批控制交互 C2 词表命中、同任务双通知去重与重试链计数、outbox asOf snapshot_unavailable、断裂行容忍、快照存档、stdout 契约。

**生产验证（三天）与两处口径缺陷修复：**

1. run-links 发现未按"当日首现"过滤 → 历史链接污染每日分母（孤立 Run 每天重复报 8）→ 按 runId 首条 updatedAt 归属日过滤。
2. task_msgs 未按 createdAt 归属日过滤 → 历史任务的 messageId 每天重复进有效请求集（10-28 出现 10-27 任务的幻影请求 6/6）→ 按 createdAt 归属日过滤。

修复后三天数据自洽：10-26 无新任务但孤立 Run 4 个（当日晚 agent 恢复流程 run-links 首现，与续十七 WX-P6 时间线吻合）；10-27 六请求七任务、Run 终态 4/7 (57.1%)、通知 7/7 入队 7/7 发送；10-28 暂无新任务（全 N/A，符合当日 chat-log 0 入站）。

**下一步：** T4（WX-MOCK 场景级验证——跑完整场景后比对报告数字）/ T5（生产抽核 ≥3 种真实异常 + 7 项验收清单勾验）/ T6（P1 wx-failure-diagnose.py）。

---

## 增补二：P1 里程碑（T6+T7，2026-10-28 同日完成）

**交付：** `wx-failure-diagnose.py`（两级归类 + 指纹聚合 + 排行榜）+ `wx-failure-diagnose-Example.py`（10/10 PASS）。

**验收对照（方案 P1 验收标准）：**

1. 401/429/500 分指纹——Example 断言 1：MODEL_API_ERROR errorCodes=["401","429"] 两类（500 由 errorCode 保留机制同理覆盖）。
2. 生产 7 天窗口首榜（T7）——3 条异常 3 类，影响任务数 1 ≤ 失败次数 1（无虚高）；Top1 待用户确认直觉。

**生产首榜内容（2026-10-28，窗口 10-22~10-28）：**

| # | 类别 | 次数 | 影响 Workflow | 可恢复性 |
|---|------|------|--------------|----------|
| 1 | WORKFLOW_ERROR | 1 | article-image-generate | 未知模式（风格审批门 non 即 batch 校验失败） |
| 2 | WORKFLOW_ERROR | 1 | github-research | 未知模式（知识库根未配置） |
| 3 | WORKFLOW_ERROR | 1 | article-image-generate | 需人工评估（interrupted，checkpoint 无） |

**Example 覆盖断言：** 401/429 不归并、429 同根因不同 runId 同指纹（count=2 影响任务 2）、工具错误不同参数/路径归一化同指纹（`<path>` 标记）、AGENT_UNKNOWN 按 attemptId 去重且必须人工、unresolved 不判失败、sk-/token= 敏感串脱敏、interrupted 可恢复性输出 checkpoint 文件存在性事实而非"可 resume"结论、completed 任务不入榜、count 降序 + 字段齐全、stdout 契约。

**遗留：** T4（WX-MOCK 场景级验证——跑完整场景后比对报告数字与场景预期）/ T5（生产抽核 ≥3 种真实异常逐项核对 + 7 项验收清单勾验，P0.5 验收第 2/3 条）。

---

## 增补三：T4 + T5 完成（2026-10-28，需求 A 主体收官）

### T4 WX-MOCK 场景级验证

| 场景 | 报告数字 | 场景预期 | 结论 |
|------|----------|----------|------|
| execution-success | 请求 1/1、Run 终态 1/1 (100%)、入队 1/1、待发送 1 | taskCompleted + 产物存在 | 一致；待发送 1 = mock 服务停止前 outbox 未 flush（pending 单列按设计） |
| execution-failure | 请求 1/1、Run 终态 0/1 (0%)、入队 1/1、排行榜 WORKFLOW_ERROR ×1 | taskFailed + error 含 e2-injected | 一致；归一化消息 "mock failure: en-injected"（数字归一为设计行为），证据指向 manifest.json |

坑：mock 场景 runs 落仓库根 `.pi-workflows/runs`（engine 断言同源），报告默认从 `data.parent` 推导不成立，需 `--runs` 显式传（README 已记）。

### T5 生产抽核（≥3 种真实异常，逐项对原始日志）

| # | runId | 报告归类 | 原始日志核对 | 结论 |
|---|-------|----------|--------------|------|
| 1 | run-mvqc133b-fu6x | WORKFLOW_ERROR 风格审批门 | manifest.error 逐字一致（--mode batch 风格审批 none） | 一致 |
| 2 | run-mvqc3alx-ilqo | WORKFLOW_ERROR 知识库根未配置 | manifest.error 逐字一致 | 一致 |
| 3 | run-mvqdnrv1-5405 | WORKFLOW_ERROR interrupted（需人工评估，checkpoint 无） | **task.status=interrupted 但 manifest.status=completed** | 发现真实数据分歧（见下） |

**发现：RunMonitor 终态回写窗口丢失**——run-mvqdnrv1-5405 的 TaskBinding 停在 interrupted（用户收到"已中断可恢复"消息），但 manifest 显示 run 最终 completed。推测：interrupted 通知发出后、run 实际完成前发生服务重启，RunMonitor 补扫未覆盖（pollOnce 只扫 running/waiting_checkpoint，interrupted 任务不再补扫）。修复属 RunMonitor 侧（补扫 interrupted 任务或对比 manifest 状态），超出本需求只读范围，登记遗留。报告层 final 口径以 tasks 为主（任务视角）维持不变。

### 7 项验收清单（二轮评审）最终勾验

1. [x] 无 TaskBinding 的路由/启动异常识别或标记 unclassified/unresolved（Example + 生产 10-26 孤立 Run 检出）
2. [x] 请求启动成功率与 Run 最终成功率分开计算（三层独立指标，stdout 四指标并列）
3. [x] 通知未入队/入队失败/发送失败分别识别（missingEnqueue / outbox failed / sendRate）
4. [x] asOf 缺证据返回 snapshot_unavailable，不填推测值（outbox/manifest 恒标注）
5. [x] unknown/unresolved/孤立 Run 不自动判失败或安全重试（单列 + 可恢复性"必须人工"）
6. [x] 多次状态更新/通知重试不重复计数（tasks 末条折叠、交付按任务去重、重试链单独计数）
7. [x] 抽核 ≥3 种真实异常并逐项核对（本节 T5 表）

### 需求 A 收官状态

P0 ✅ / P0.5 ✅ / P1 ✅（含 T7 生产首榜）；P2（AI 根因诊断）按方案待连续多日真实数据后启动；P3（受控自动修复）暂缓。遗留：RunMonitor interrupted 补扫窗口问题（上文）；每日定时未挂（README 提供 schtasks/cron 一行命令，建议挂 23:59）。

---

## 增补四：RunMonitor interrupted 补扫修复 + 每日定时挂载（2026-10-28，用户确认后执行）

### 1. RunMonitor interrupted 补扫（增补二发现的真 Bug 修复）

**根因**：`pollOnce` 只扫 running/waiting_checkpoint 的绑定；interrupted 绑定在服务重启窗口内 Run 自行完成后永远不回写（run-mvqdnrv1-5405：binding=interrupted、manifest=completed，用户收到「已中断」但实际完成）。

**修复**（src/dispatch/run-monitor.ts，+18/-1）：interrupted 纳入扫描；仅当 effectiveStatus ∈ {completed, failed, cancelled} 走对应终态分支（回写 + 通知 + run-links）；仍 interrupted/running/waiting_checkpoint/created 跳过（等用户 resume，不自动拉回——副作用安全原则）。

**测试**：新增 tests/unit/run-monitor-interrupted-resync.test.ts（5 用例：completed 同步+通知、failed 同步带原因、仍 interrupted 跳过不重复发中断通知、已 resume 到 running 跳过、cancelled 同步无通知）；run-monitor 相关 8/8 PASS；tsc 干净。全量回归 fail 19 vs 改动前基线 fail 22（工作树既有 wx-article 未提交改动 + pm2 临时目录 flaky，与本次无关，含新测试前后总数均为 502）。

**真机闭环**：pm2 restart wechat-bot → 启动补扫 3 秒内 run-mvqdnrv1-5405 binding 回写 completed（03:34:09Z）→ 🎉 完成通知送达用户（chat-log 03:34:09.647Z）→ outbox completed sent。用户收到迟到的正确结果。

### 2. 每日定时挂载（wx-quality-daily）

- wx-quality-report.py `--date` 改为可选（缺省今天）——schtasks /tr 中 %DATE% 不展开且依赖区域设置，缺省今天最稳；Example 20/20 不受影响。
- schtasks 创建 wx-quality-daily（每天 23:59，绝对路径 --data/--runs）。坑：Git Bash 需 `MSYS_NO_PATHCONV=1`（/create 被 MSYS 转路径）。手动 `/run` 触发验证：11:37 产出 quality-2026-10-28.{json,md} + snapshots/daily-2026-10-28.json。

### 需求 A 最终状态

P0 ✅ / P0.5 ✅ / P1 ✅ / T4 ✅ / T5 ✅ / RunMonitor 修复 ✅ / 每日定时 ✅。P2（AI 根因诊断）待连续多日数据积累后启动；P3 暂缓。
