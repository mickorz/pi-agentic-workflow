# wx-quality — 微信任务质量统计（只读分析）

失败任务统计与自动诊断（需求 A）P0/P0.5 脚本。方案：`dev-docs/planning/2026-10-27-失败任务统计与自动诊断执行方案.md`（V1.2）。

## 脚本

| 脚本 | 用途 |
|------|------|
| `wx-linkage-check.py` | P0 七项数据关联校验（口径定标） |
| `wx-linkage-check-Example.py` | 合成夹具测试（14 断言） |
| `wx-quality-report.py` | P0.5 每日三层质量报告（请求启动/Run 终态/通知交付，asOf+final 双口径） |
| `wx-quality-report-Example.py` | 合成夹具测试（20 断言） |
| `wx-failure-diagnose.py` | P1 失败诊断与故障排行榜（两级归类 + 归一化指纹聚合， errorCode 保留 HTTP 状态码） |
| `wx-failure-diagnose-Example.py` | 合成夹具测试（10 断言） |

## 用法

```bash
# 关联校验
python3 dev-examples/manual-test/wx-quality/wx-linkage-check.py \
    --data .pi-wechat --date 2026-10-28

# 每日报告（输出 quality-<date>.{json,md} + snapshots/daily-<date>.json）
python3 dev-examples/manual-test/wx-quality/wx-quality-report.py \
    --data .pi-wechat --date 2026-10-28

# 故障排行榜（近 N 天，输出 diagnose-<date>.{json,md}）
python3 dev-examples/manual-test/wx-quality/wx-failure-diagnose.py \
    --data .pi-wechat --date 2026-10-28 --days 7 --top 10
```

`--runs` 可显式指定 runs 目录（缺省 `<data>/../.pi-workflows/runs`）；`--out` 指定报告目录（缺省 `<data>/quality`）。

## 每日定时（已挂载：wx-quality-daily，每天 23:59，产出当日报告）

脚本 `--date` 缺省即今天，定时调用无需日期展开（%DATE% 依赖系统区域设置不可靠）。本机实际挂载：

```
schtasks /create /tn wx-quality-daily /tr "python E:\\WorkProjects\\pi-agentic-workflow\\dev-examples\\manual-test\\wx-quality\\wx-quality-report.py --data E:\\WorkProjects\\pi-agentic-workflow\\.pi-wechat --runs E:\\WorkProjects\\pi-agentic-workflow\\.pi-workflows\\runs" /sc daily /st 23:59 /f
```

Git Bash 里需 `MSYS_NO_PATHCONV=1` 前缀（/create 会被误转路径）；手动验证：`schtasks /run /tn wx-quality-daily`。

## 口径速查

- 请求启动成功率 = 启动成功/(启动成功+启动失败)；unresolved/unknown/拒绝/控制交互/unclassified 单列不计入
- Run 终态成功率 = completed/(completed+failed+interrupted)；cancelled/running/waiting 只进全量分布
- 通知交付 = 入队覆盖率 + 发送成功率（按任务去重）；outbox 历史 asOf 不可重建（snapshot_unavailable）
- 统计启用日 2026-10-28（此前 chat-log 缺失属部署边界）

## 注意：WX-MOCK 数据目录的 runs 位置

mock 场景的服务进程 runs 落在**仓库根 `.pi-workflows/runs`**（不在 runDir 下）。对 mock data 目录跑诊断时需显式传：

```bash
python3 wx-failure-diagnose.py --data <reports>/<ts>-<name>/data --runs ../../../../.pi-workflows/runs ...
```
