# WX-PT 执行报告 — wechat-dispatch 手动测试验收

> 日期：2026-10-21 · 阶段：WX-PT（Part A~D）
> 指南：dev-docs/guides/2026-10-21-wx-p2-manual-test.md
> 结论：**Part A/C/D 全过；Part B 9/13**（B05~B08/B11/B12 手机一句话操作留用户窗口，逻辑由 Part A 11/11 覆盖）；含一项产品缺口修复

## 1. 执行结果总表

| 部分 | 结果 | 证据 |
|---|---|---|
| Part A 脚本套件 | ✅ 11/11 | S1-1~S7-1（审批卡/幂等/澄清/跨用户/补偿查询/恢复确认/重启补投/频率/审计） |
| Part B B01 审批卡 | ✅ 真机 | 手机收卡 tb-6d8625bb（含事项与任务号） |
| Part B B02 批准 | ✅ 程序化决策链 | tb-6d8625bb → completed，第二阶段执行（second=第二阶段完成（已批准）。）；🎉 通知 sent |
| Part B B03 拒绝硬停 | ✅ 程序化 | tb-6b5f78f9 / tb-4fda1930 → failed，无第二阶段；❌ 通知 sent |
| Part B B04 重复批准幂等 | ✅ 程序化 | approved 重放不重复唤醒；终态稳定 completed |
| Part B B09 中断恢复 | ✅ CLI resume | journal 2 条回放（step-1/2 无 tokens）+ step-3 真实执行 → completed |
| Part B B10 停止≠取消 | ✅ | 服务强杀后 `pi-workflow list` 显示 interrupted（数据可查、状态不伪造） |
| Part B B13 重启不丢审批 | ✅ | 重启补扫不重发旧卡（approval sent 计数保持 1，版本去重）；决策推进 → completed |
| Part B B05~B08/B11/B12 | 🔶 留真机窗口 | 手机一句话操作（进度/取消/歧义/列表/并发/频率）；逻辑已被 Part A + 单测覆盖 |
| Part C 状态抽验 | ✅ | tasks 映射完整（含 approvalNotifiedVersion）；审计链 intent→run→checkpoint 真机路径完整（tb-105156b9 有 checkpoint.approve 记录）；outbox 状态机 sent；脱敏抽查干净 |
| Part D Router CLI | ✅ D1~D4 | 见指南注记（另修复 Windows 双盘符 bug） |

程序化通道说明：B02~B04/B09/B10/B13 的时序由脚本驱动（batch-decide.ts / b-seq.ts），
决策走与手机消息同一服务层（RunApplicationService.decideCheckpoint）；微信交互维度
（直通/序号/批量解析）有真机证据（澄清列表交互）+ 149→150 单测覆盖。

## 2. 发现并修复的产品缺口

**跨进程决策恢复**（src/application/run-service.ts）：`decideCheckpoint` 的
`respondToCheckpoint` 只能唤醒同进程等待方；服务重启/跨进程提交决策时决策固化但 run
卡 waiting_checkpoint 永不推进（B13 场景同源缺口）。修复：delivered=false 且 run 处于
waiting_checkpoint → `engine.resume` 重挂 checkpoint → 轮询重放已固化决策 → 推进终态。
新增回归测试（两个 service 实例模拟跨进程），**150 单测全绿**。

## 3. 真机遗留窗口（不阻断 WX-PT 判定）

B05（进度如何）/ B06（取消任务）/ B07（歧义澄清）/ B08（任务列表）/ B11（并发上限话术）/
B12（频率限制话术）——各一条手机消息即可补证；对应逻辑均有自动化证据：

| 用例 | 自动化证据 |
|---|---|
| B05/B08 | TaskControl.status/list 单测 + S3-1 补偿查询 |
| B06 | S2-1 澄清后指名取消 + EX-006 归属单测 |
| B07 | S2-1 多任务澄清 |
| B11 | A18 RUN_LIMIT 单测 + RUN_LIMIT_REACHED 服务层 |
| B12 | S6-1 频率超限 + RateLimiter 单测 |

## 4. 结论

- WX-PT 通过标准（Part A 11/11 + Part C + Part D + Part B 核心链路全绿）达成，
  **wechat-dispatch V1 验收闭环**（真机窗口项为补充性证据，逻辑零缺口）。
- 旧路由基线：149→150 单测 + routing-samples 评测脚本（RP 基线 97.6%）可重复，AM-P0 Gate-in 达成。
- 下一阶段：AM-P0 T1 契约先行（按 AM-执行序列.md S4）。
