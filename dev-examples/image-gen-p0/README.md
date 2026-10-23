# image-gen-p0 — 公众号批量生图 P0 技术验证沙盒

对应方案：`dev-docs/planning/2026-10-23-公众号批量生图接入执行方案.md` §6 P0。
结论沉淀：`dev-docs/progress-result/P0-执行报告.md`。

## 内容

- `scripts/probe_apis.mjs`：pi-image-gen / pi-ai 双 Provider 运行时导出与离线错误路径探针（T0.2/T0.3/T0.5）
- `scripts/t04_real_call.mjs`：pi-image-gen 真实生图（智谱 cogview-3-flash，自定义 provider + fetchImpl 兼容改写）（T0.4）
- `scripts/slow_task.py`：长任务模拟器（心跳标记 + stdout JSON 契约）（T0.6 配套）
- `scripts/t06_agent_bridge.js` / `t06_agent_bridge_180.js`：agent 单命令桥接 × 40s/180s 长任务验证（T0.6）
- `scripts/article_lock.mjs`：Node 版文章锁原型（与 wx-article `article_lock.py` 同协议）（T0.7）
- `scripts/t07_lock_interop.py`：锁协议跨语言互操作 5 用例矩阵（T0.7）
- `fixtures/image-prompts.sample.json`：9 条提示词合成样本（T0.8，待真实文章确认后替换）

## 运行产物（gitignored）

`out/`（标记文件、真实生图 jpg 证据）、`.pi-workflows/`（运行日志）。

## 复现要点

```bash
node scripts/probe_apis.mjs                      # 离线，零费用
node scripts/t04_real_call.mjs                   # 真实调用，需 cc-switch 智谱 key（读 ~/.cc-switch/cc-switch.db）
python3 scripts/t07_lock_interop.py              # 离线，零费用
pi-workflow run scripts/t06_agent_bridge.js --args "{\"sandbox\":\"$(pwd)\"}" --model <model>
```
