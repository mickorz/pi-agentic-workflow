# RP-P1 执行报告 — CLI 路由评测

> 阶段：RP-P1 · 日期：2026-10-20 · 基线 HEAD：a4660af（RP-P0）
> 结论：**PASS —— 基线报告落盘（混淆矩阵/逐字段/耗时/tokens/跨 channel），A/B 与多模型对比完成**

## 交付

`dev-examples/router-eval/evaluate.ts`（复用唯一样本库 `wx-p1/routing-samples.json`，42 条不扩）：

- 判定口径：expectedAction + expectedWorkflowId；LLM 调用失败与合法 unsupported 分计
- 增强：**逐字段参数准确率**（repoUrl/text/targetLang/url）、**耗时 p50/p95**、**tokens 统计**（onUsage 真实采集）、**跨 channel 分组**（wechat 38 / cli 4）、**Prompt A/B**（--prompt B 精简无 few-shot 变体）、**多模型**（--model + --label）
- 报告：`dev-examples/router-eval/reports/<label>.json|.md`

## 基线数据（真实 LLM）

| 报告 | 准确率 | 逐字段 | 耗时 mean/p50/p95 | tokens |
|---|---|---|---|---|
| baseline-real（Prompt A，默认模型） | **97.6%**（41/42）| 全字段 100% | 5220/4334/11301 ms | 173,671 |
| glm53flash-real（cc-switch-zhipu-glm/glm-5.3-flash） | **97.6%**（41/42）| 全字段 100% | 7148/6630/11049 ms | 174,049 |
| promptB-real（Prompt B 精简版） | **64.3%** ❌ | repoUrl/url 100%，text/targetLang 未达标 | 10806/6820/18419 ms | 287,459 |
| baseline-fake（确定性管线自检） | 90.5% | — | ~0 | 0 |

关键发现：

1. **Prompt A 的 few-shot 与参数抽取规则是质量关键**：B 变体去掉后 start_execution→ask_clarification 混淆 7 例（模型不敢填参数），延迟翻倍、tokens +65%。
2. 两模型（默认 vs glm-5.3-flash）行为一致，均 97.6%；唯一分歧样本「帮我个忙好吗」（chat vs clarify 边界，两条边界均合理，样本库可考虑标注宽限）。
3. 跨 channel：wechat/cli 分组均无系统性偏差（报告 byChannel 字段）。

## 回归

146/146 绿；报告文件不进 gitignore 白名单外路径（dev-examples 运行产物按约定 gitignore——本次报告以执行报告为据，报告文件已随 commit 落盘）。
