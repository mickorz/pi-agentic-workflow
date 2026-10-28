# IMG-L 阶段二执行报告（T4 文字验收闭环）

> 日期：2026-10-28
> 依据：《生图链路遗留需求执行方案》V2 · 阶段二（解决确定的质量问题）
> 结论：T4 全链落地并全绿；T2 依阶段一 T1 实测裁定缓行（不实施）。阶段二完成，阶段三（T3 证据链 + T5 度量）待启动。

## 一、交付清单

| 落点 | 内容 |
|---|---|
| `validate-plan.mjs` | `expected_text` 可选字段校验（非空字符串数组） |
| `compile.mjs` | items 纯透传 `expected_text`；**实施修正：不进 prompt 合成**（见二） |
| `lib/validate.mjs`（D6） | `expected_text` optional 校验（非法形态拒绝） |
| `lib/manifest.mjs` | `REVIEW_STATUS` / `requirementsHash()` / `newContentReview()` |
| `generate.mjs` | 生成成功（主链+候选提升）挂 pending 审核并绑定 sha；计划阶段失效检查；`--approve-text` / `--reject-text` 审核动作（锁内 RMW 零请求）；summary 增 `text_pending_review` / `text_pending_ids` / `text_rejected_ids` + `[TEXT-CHECK]` 清单 |
| `draft_manager/check_state.py` | 消费侧质量门：pending/rejected/sha 不符 → 阻断 prepare_ready；path 缺失（重命名断裂）→ 仅提示 |
| 测试 | IU-15（8 段闭环断言）+ `test_text_review_gate.py`（6 场景门测试） |

回归：executor 45/45（44+IU-15）、P0 Gate 46/46、P1 Gate 31/31、门测试 6/6。

## 二、对 V2 方案的唯一实施偏离（已回填方案）

方案 5.2 原文"compile 在 prompt 合成中加入'必须包含以下文字'约束段"与 5.4 失效规则
"仅修改验收要求不得触发重新付费生图"**自相矛盾**：expected_text 进 prompt 会改变
prompt_hash，纯改要求即判输入变化 → 触发重新付费生成。

裁定：失效规则优先（不重复计费是安全边界承诺）。expected_text 作为纯验收元数据透传，
不进 prompt。佐证：T0 取证已证明负向文字约束在 web 后端无效，正向约束的生成增益未经验证，
不为未验证的增益牺牲确定性的失效语义。

## 三、状态机语义（落地形态）

```
生成成功（声明 expected_text 的条目）
  → content_review = { status: pending, image_sha256: <文件sha>, requirements_hash: <要求哈希> }
--approve-text <id> / --reject-text <id>（人工动作，锁内 RMW）
  → approved / rejected（重绑当前文件 sha + 当前要求哈希）
失效（均回 pending，绝不自动重发请求）：
  - 图片重生成提升（重生成即重审，保守语义）
  - 文件 sha 变化（含被手改）
  - expected_text 变化（纯改要求：审核回 pending，但零重新生成——IU-15 断言 calls=0）
消费门分级（check_state）：
  - pending / rejected / approved 但 sha 不符 → 阻断 prepare_ready
  - approved 但 path 缺失 → 提示不阻断（T0 取证：下游重命名断裂是现网常态，硬阻断会打死现网流程）
  - 无 manifest / 无 expected_text 条目 → 零影响
```

## 四、T0 结论到 T4 实现的映射

| T0 取证结论 | T4 落地 |
|---|---|
| 零字约束系统性失效（3/3，28/25/8 处） | 文字策略翻转：`expected_text` 从"验证无字"转为"验证指定字" |
| 封面主标题后期合成是现网实践 | 叠字路线实证成立，作为 expected_text 的互补选项（本期不实施，评估结论在 T0 报告） |
| manifest 与文件系统 5/5 断裂 | 消费门对 path 断裂仅提示；彻底修复属 T3（重命名解绑语义） |
| 3 张样本不足以统计违规率 | T4 门不依赖违规率：声明即审核，未声明零影响 |

## 五、顺带修复

- `check_state.py` imgs/ 目录缺失时崩溃（上 commit 4edf581 封面优先级提示的 `iterdir()` 先于 `is_dir()` 求值）——测试最小文章目录撞出，提守卫修复。

## 六、commit 与下一步

- f49d0b2 feat(image-gen): T4 文字验收闭环（全链 + 测试 + 文档）
- 阶段三待做：T3 证据链补强（promoteEntry 同步已随 T6 完成；剩 duration/failure_class/受限日志引用/重命名解绑语义）+ T5 度量口径（双耗时/双计数）。
