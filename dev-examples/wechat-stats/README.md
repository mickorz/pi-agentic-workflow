# wechat-stats：微信任务成功率统计基线（只读）

日报 2026-10-27 §5.2「Workflow 失败任务统计与自动诊断」的最小可验收实现（v0）：
不新建埋点，直接消费生产数据目录 `tasks.jsonl`（append-only，同 taskBindingId 多行、末行为准）。

## 用法

```bash
python3 dev-examples/wechat-stats/task_stats.py --data-dir .pi-wechat --stale-hours 2
# 只看某天起的任务
python3 dev-examples/wechat-stats/task_stats.py --data-dir .pi-wechat --since 2026-10-27
```

## 口径

- terminal = completed / failed / cancelled；running 超过 `--stale-hours`（默认 2h）无更新判为僵死
- strict 成功率 = completed / terminal（乐观）；real = completed / (terminal + 僵死)（悲观）
- 已知口径洞（待补）：run 层终态未落盘（run-attempts.jsonl 只有 launched/linked 事件），
  Run 层成功率暂不可算；tasks.jsonl 每行是状态快照，不去重会重复计数。

## 首次基线（2026-10-27，全部历史）

原始 77 行 → 去重 34 任务：completed 24 / failed 5 / cancelled 4 / running 1（僵死 1，cli summarize 10-21）。
**strict 72.7% / real 70.6%**，渠道 wechat 30 / cli 4。
Top 工作流：article-prepare 5/8 ok、videodigest-extract 5/7、github-research 3/6。
（比日报主观估计"约 50%"好；样本仍小，待每日累计。）
