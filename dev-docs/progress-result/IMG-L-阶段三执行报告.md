# IMG-L 阶段三执行报告（T3 证据链 + T5 度量）

> 日期：2026-10-28
> 依据：《生图链路遗留需求执行方案》V2 · 阶段三（增强可观测性）
> 结论：T3/T5 落地，executor 46/46 绿。**IMG-L 全部三阶段完成**；唯一未实施项（T3 重命名解绑）超出执行器边界，登记为独立后续任务。

## 一、T3 证据链（交付形态）

| 字段/机制 | 写入时机 | 说明 |
|---|---|---|
| `entry.duration_ms` | 成功（provider 口径 `r.durationMs`）/ 失败（尝试累计） | 单图耗时证据，五类事件一致 |
| `entry.error_code` | 失败 / unknown | **既有字段即失败分类**（统一错误属性 err.code 透传）——未新增 `failure_class` 同义字段 |
| `entry.evidence_log` | 失败 | 受限日志引用 `.image-gen-logs/<runId>-<id>-a<n>.log`；内容含完整 message、provider 附带诊断尾部（image-use stderr 尾部含**会话 URL**，供 unknown 人工 recover——此前 URL 仅控制台可见，窗口关闭即丢失）；**未脱敏内容不进 manifest 正文** |
| `entry.provider/model` | 成功 / 候选提升（T6 已修）/ `--resolve-unknown` 导入（`manual` / `manual-import`） | 五类事件字段一致性 |
| provider `err.evidence` | image-use 失败 | 错误对象附诊断尾部（attachEvidence），执行器侧消费写证据文件 |

**未实施（登记）**：T0 实锤的"下游重命名致 manifest 路径断裂"彻底修复（重命名同步 manifest 或显式解绑语义）——需改 article_pipeline 发布管线，超出 image_gen 执行器边界；消费门已分级容忍（path 断裂仅提示），非阻塞。后续独立任务处理。

## 二、T5 度量（交付形态）

- **双耗时**：`exec_duration_ms`（锁前→summary，评估链路优化收益、不含审批等待）与 `wall_duration_ms`（进程→退出）分列。
- **双计数**：`human_action_required`（unknown 停转 + budget 停转 + 文字待审 + 已拒 + 预览待确认）与 `human_actions_completed_total`（`manifest.actions_log` 台账长度；approve-style / approve-text / reject-text / resolve-unknown / promote 五类动作登记）。
- **风格门提前退出计数缺口（评审指出）已补**：fail 前输出 `blocked_by:"style_gate"` + `human_action_required:1` + `wall_duration_ms` 的 RESULT JSON。
- **抽检提醒**：succeeded>0 时输出 `[SAMPLE-CHECK]`（口径锚定 T0 报告，执行器不自动评分）。

## 三、测试与回归

- IU-16 新增（8 段）：失败证据文件内容断言 / duration 双口径 / actions_log 登记 / 风格门度量输出 / summary 双耗时双计数。
- executor 46/46 绿（44 + IU-15 + IU-16）；P0/P1 Gate 与门测试在阶段二已全绿（本次改动不触 draft_manager）。

## 四、IMG-L 三阶段总览（收束）

| 阶段 | 任务 | 结果 |
|---|---|---|
| 一 | T6 修复 / T0 取证 / T1 验证 | 修复 2 个重复计费级 bug；零字约束 3/3 失效实锤 + 文字策略翻转；keep-tab 收益不成立，T2 缓行 |
| 二 | T4 文字验收闭环 | expected_text 契约链 + content_review 状态机 + 审核动作 + 消费门分级阻断（唯一实施偏离：expected_text 不进 prompt，失效规则优先） |
| 三 | T3 证据链 / T5 度量 | duration/evidence_log/manual 标记/actions_log/双耗时/双计数/风格门度量 |

日报 2.2 三个卡点的处置归档：卡点 1（模板遵循）→ 设计层归《生图流程优化执行方案》；卡点 2（文字缺失）→ T4 闭环；卡点 3（频繁开关页面）→ T1 实测定位真根因（上游固有 opening 动作），keep-tab 不解决、不改造。

> **【2026-10-28 归属修正】**：T0 取证样本实为用户手动生成图，非执行器产物；初版"零字约束失效 3/3"
> 与"构图劫持"根因结论作废，"文字策略翻转"的实证依据待真机跑批重取（遗留任务已登记）。
> T4 闭环机制依据的是日报卡点 2 的用户第一手经验，机制保留不受影响。

## 五、遗留任务登记

1. **manifest 重命名解绑**（T0 断裂彻底修复）：article_pipeline 侧改造，独立任务。
2. **叠字路线评估落地**（无字底图 + 确定性排版叠字）：T0 已实证现网实践（封面标题后期合成），需 Pillow 依赖登记或替代方案选型，独立任务。
3. **上游同对话连发能力跟踪**：若 image-use 未来支持真正的上下文复用，重启 T2 评估（env 开关设计已备）。

## 六、commit 记录

- 8b33637 feat(image-gen): T3 证据链 + T5 度量（IU-16，46/46 绿）
- （本报告与方案回填随本 commit 提交）
