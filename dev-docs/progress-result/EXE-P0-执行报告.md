# EXE-P0 执行报告：Workflow 执行效率优化（M1 规范落地 + M3 执行数据面）

> 日期：2026-11-11
> 方案：`dev-docs/planning/2026-11-11-workflow执行效率优化执行方案.md`（用户评审"通过，四点补充后开工"，补充已全部并入）
> 范围：M1（T1~T4 skill 规范改造）+ M3（T6~T8 执行数据面）；M2（真实文章实测）与 M4（5~10 篇数据积累）挂条件待触发
> 基线：131 分钟全流程（Agent 47% / 等待 53%），B 逐章审批等待 51 分钟，F3 全文扫描 20 分钟

## 一、交付清单

### M1 规范落地（纯 skill 文档，零代码）

| 任务 | 交付 | 验收 |
|---|---|---|
| T1 | SKILL.md B 节：三级分批审批制（普通=两章一批/核心=单独/结论数据=强制单独），审批级别在大纲 v1 标注（A 节同步加标注入口）；**动态降级写入 B 节正式执行规则**（批内首章方向错误→停批→退单章→改大纲→重排批次→已通过章节不动） | 评审补充第 1 点落正式规则而非 pitfalls ✓ |
| T2 | SKILL.md F3 节：两遍法（第一遍全文层：跨章模式 §7/§2/§12 + 问题索引 + 章节 sha；第二遍分章精扫可并行）；`humanizer-scan-cache.json` 缓存结构含 **chapter_sha + rules_sha + scanner_version** 三条件有效判定 + 四态枚举 clean/has_hits/failed/stale（**failed 不得当 clean**）；批准后对账只重扫 hash 变化章；review-humanizer.md 格式不变 | 评审补充第 2 点（缓存版本控制）✓ |
| T3 | pitfalls.md #15（分批审批返工成本放大+降级规矩）/#16（分章扫描漏跨章模式防护+缓存三条件引用） | 编号衔接现有序列 ✓ |
| T4 | 一致性修正：frontmatter description 更新（逐章确认→三级分批审批+humanizer 两遍法）、流程总览 F3 行更新、A 节大纲条目补审批级别标注 | frontmatter/引用路径/humanizer skill 零改动 ✓ |

### M3 执行数据面（离线脚本，零侵入执行器）

| 任务 | 交付 | 验收 |
|---|---|---|
| T6 | track_time.py 新增交互点事件 `log --interaction approval --result confirm/rework/edit --artifacts ...`（**changed_artifacts 字段，评审补充第 4 点**）；report 扩展交互点表+审批返工率+平均距上事件耗时+修改产物计数；交互事件不参与阶段差分（不污染耗时）；`[OK]/[FAIL]` 契约与旧格式 time-log.jsonl 兼容 | track_time_example.py 全绿（含 6 组新用例：非法 result、rework+artifacts、交互不污染阶段差分、旧格式无交互节不报错）✓ |
| T7 | 新建 session_usage_report.py（纯标准库，Python 3.9 兼容）：阶段时间窗 × pi session jsonl → 各阶段六指标分列表（input/output/cacheRead/cacheWrite/reasoning/calls/cost，**cacheRead 不并入 input**，评审补充第 3 点）+ 工具调用计数 + **归因可信度 attribution_confidence（high <5% / medium <30% / low ≥30% 未归属 Token 占比）**；支持 --sessions-dir 自动挑选窗内消息最多的 session | Example 全绿（阶段归因/未归属尾/高低可信度/自动挑选/4 条错误路径，时区无关设计）+ 真实数据验证通过（见下）✓ |
| T8 | SKILL.md 耗时记录节登记两脚本用法（交互点 2 条命令 + Token 分析 3 行说明） | 用法可检索 ✓ |

## 二、真实数据验证（T7 验收证据）

用 2026-11-11 工具瘦身篇真实产物（文章目录 time-log.jsonl + 当天 session jsonl）实跑：

- 时间窗 **14:04→16:13 与执行报告完全吻合**（10 阶段逐窗归因）
- 115 次 LLM 调用与 session 文件 grep 计数一致；humanizer 窗内 13 次、写作 18 次
- 总量：input 447K / output 81K / cacheRead 12.4M / 推理 44K tokens（量级合理，GLM prompt cache 生效明显）
- **归因可信度机制实战生效**：该 session 文章完成后（16:13→17:16）还继续干别的活，未归属占比 39.3% → 正确判 **low** 并 [WARN] 禁止进跨篇对比——正是评审第 3 点要防的"把不可靠数据当结论"

## 三、遗留与挂起项

- **M2（T5）下一篇真实文章实测**：B 交互次数 7→≤5、F3 首扫耗时对比（基线 20 分钟）、缓存命中验证、质量三信号（humanizer 检出量/用户改动章数/发布后返工）；实测值进当篇执行报告，30 分钟估算不作为硬指标
- **M4（T9）5~10 篇数据积累**：三张表（阶段耗时/交互返工/Token）连续采集，之后产对比分析（审批可否再合并、瓶颈迁移）；low 归因数据不进结论
- L3 自主优化：本次明确不做（方案第八节分层边界），未来由 Agent 提案+人工审批

## 四、经验索引

- session 文件结构实测：assistant 消息带 usage（含 docs 未记载的 `reasoning` 字段；totalTokens=input+output+cacheRead+cacheWrite，不含 reasoning）；toolCall 块 `{"type":"toolCall","name":...}`；时间戳 UTC 带 Z，需转本地与 time-log 对齐
- 归因可信度不是摆设：单 session 常跨任务延续（本次 39.3% 未归属），无此机制直接拿阶段 Token 做对比会得出错误结论
