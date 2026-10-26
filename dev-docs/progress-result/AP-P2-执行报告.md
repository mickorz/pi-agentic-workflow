# AP-P2 执行报告：公开发表能力（freepublish）

> 阶段：article_pipeline P2（基于已有草稿的公开发表）
> 日期：2026-10-23
> 需求依据：`dev-docs/planning/公众号文章统一处理流水线（article_pipeline）需求文档（V1.2）.md` 第七节 P2 清单
> 状态：**已关闭：Mock Gate 24/24 + P0/P1 回归全绿；真实发表验证经用户裁决免除——日常链路终点为草稿箱，公开发表仅在用户显式要求时手动触发**

## 交付清单

| 文件 | 变更 |
|------|------|
| `draft_manager/wechat_draft_api.py` | 真实+Mock 增加 `freepublish_submit`/`freepublish_get`（publish_status 0 成功/1 发表中/2 原创失败/3 常规失败等）；Mock 故障注入 `publish-timeout`/`publish-errcode`/`crash-after-submit`；Mock 发表成功后自动把草稿标记删除（模拟真实"发表后草稿箱移除"） |
| `draft_manager/publish.py` | 新增发表模式：`--freepublish`（校验 drafted+Hash 未变 → draft/get 远端核对 → submit → 轮询 get 确认后才写 published）、`--publish-status`（纯查询）、`--resolve-publish-id`（人工补记）、`--clear-pending`（人工丢弃未决）；pendingOperation 记录 publishId 用于崩溃恢复 |
| `scripts/article_publish.js` | publish 工作流：状态检查（drafted 且无 pending，否则 rejected 并说明）→ **独立授权** checkpoint（不复用 prepare 批准）→ bash publish.py --freepublish → 返回 published/publishing/unknown/failed/rejected 真实状态 |
| registry 两处 | 新增 `article-publish`(external-side-effect)；**下线旧 `wechat-article-publish`**（V1.2 收敛决定：不再重新上传整篇） |
| `scripts/wechat_article_publish.js` | 加弃用说明头部（绝对路径/token 写死等问题随下线一并消除），文件保留作历史参考 |
| `draft_manager/run_p2_gate_suite.py` | P2 Gate 套件（7 组场景 24 断言） |

## 契约要点（V1.2 4.5 落地）

1. **submit ≠ 发表成功**：freepublish/submit 仅受理（返回 publish_id），必须 freepublish/get 轮询到 publish_status=0 才写 `published`；首查常为"发表中"（[PUBLISHING]，退出码 0，重跑即确认）——测试 T1 验证了完整两阶段。
2. **重复发表拒绝**：status=published 再发 → [FAIL] already published（T2）。
3. **内容变更拒绝**：drafted 但 Hash 与当前内容不一致 → 拒绝并提示先 prepare（T3）。
4. **失败二分**：明确失败（errcode/原创失败）→ 清 pending 保留 drafted 可重试（T4）；不确定失败（timeout/crash）→ pending unknown 或 running 无 publishId，禁止自动重试，人工 --clear-pending / --resolve-publish-id 恢复（T5/T6）。
5. **发表后草稿移除**：真实微信行为，Mock 同步模拟（T1）；后续 draft/get 为 None 的处理在 P0 已覆盖（降级重建）。

## Gate 结果

**P2 套件（run_p2_gate_suite.py）：24/24 PASS**

| 场景 | 结果 |
|------|------|
| T1 正常发表两阶段 + 发表后草稿移除 | PASS |
| T2 重复发表拒绝 | PASS |
| T3 内容变更后发表拒绝 | PASS |
| T4 明确失败保留 drafted 可重试 | PASS |
| T5 timeout 不确定 → unknown → 人工 clear | PASS |
| T6 crash-after-submit → publish_id 未落盘 → 人工 resolve 补记 | PASS |
| T7 --publish-status 纯查询 | PASS |

**回归：P0 46/46（连续 4 轮）+ P1 17/17。**

## 过程中发现并修复的间歇性缺陷

P0 套件曾以 ~50% 概率在 T6（slot2 多账号）挂 `[LOCKED] article busy`——复现转储定位：Windows 下并发轮次刚结束时，前序进程可能"管道 EOF 已返回但进程未退出"片刻仍持有文章锁，属**设计内行为**（活进程持有 → 拒绝），非锁缺陷。两处加固：

1. `article_lock.py` 接管循环加 5 次上限（unlink 持续失败时明确报错，替代潜在死循环）；
2. `article_state.py` RMW 忙等加 ~10s 上限（超时明确报错含 holder 信息）；
3. 套件 T6 对 [LOCKED] 模拟用户稍后重试一次（与真实使用一致）。

加固后连续 4 轮 P0 全绿 + P1/P2 各一轮全绿。

## 已知边界与遗留

1. **真实 freepublish 验证：经用户裁决免除**（2026-10-23）：日常链路止步草稿箱，不执行真实公开发表；article-publish 工作流与 --freepublish 保留为手动能力，仅当用户显式要求发表时使用（届时仍需独立确认）
2. 群发推送（message/mass）按 V1.2 为独立后续需求，未实现。
3. `wechat-md-to-draft` 打开草稿箱的 DRAFT_BOX_URL token 仍写死在其脚本内（登录态本就需人工刷新，维持现状）。
