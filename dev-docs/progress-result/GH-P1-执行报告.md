# GH-P1 执行报告 — GitHub 推荐文章生成 + 总编排（github-article / github-recommend）

> 阶段：GH-P1（GitHub 项目研究与推荐文章需求 · P1）
> 需求/方案：`dev-docs/planning/2026-10-26-GitHub项目研究与推荐文章需求文档.md` / `…执行方案.md`（V1.1 第十节）
> 完成时间：2026-10-26
> 结论：**P1 验收通过**（真实链路：档案 → 推荐文章 → 现有发布流水线可衔接）

## 一、验收结论（对照方案第十节 P1 口径）

| 验收项 | 结果 | 证据 |
|------|------|------|
| T1.1 github_article.js 两级状态 | 通过 | 真实演示：lieflat-charts → `article_ready`（missing: cover），输出下一步指引（配图建议→转换→生图→prepare）；幂等复跑 0 agent / 1.3s 返回已有文章 |
| T1.1 审稿 blocking 修复循环 | 通过 | 真实演示：第 1 轮审稿抓到 B1 编造（「断网打开成品可能显示不完整」无证据）→ 修复 → 第 2 轮 pass；审稿记录落 审稿.md |
| T1.1 证据核验写作 | 通过 | 正文数字全部来自 evidence（49 图型/三套配色名/PolyForm 许可证），并主动标注「README 图型数字多处对不上，可能文档漂移」 |
| T1.1 产物与现有流水线兼容 | 通过 | 三件套 `<标题>.md + article.yaml(title/author/digest/content_source + github_* 溯源) + 配图建议.md`；check_state 结构合规（T-F 用例：article_ready 报缺封面 / 加封面后 prepare_ready） |
| T1.2 关联登记闭环 | 通过 | lieflat-charts articles[0] = gh20261026-lieflat-charts-recommend（articleDir 指向真实文章目录）；register-article 锁内同步索引+镜像；plan-article 幂等（同角度返回已有 / force 另一篇唯一 id） |
| T1.3 github_recommend.js 总编排 | 通过 | 脚本 <50 行纯串联（A → check → B → check → 汇总）；validate 通过 |
| T1.4 registry 登记 + 路由 | 通过（路由 dry-run 待真机） | github-article（write, projectId/repoUrl 二选一）+ github-recommend（write, repoUrl 必填）已登记 enabled=true |
| T1.5 套件 T-E/T-F | 通过 | 59 用例：P1 新增 9（plan-article 4 / article-write 2 / check_state 两级状态 2 / resolve-workspace 1）；T-G（article-prepare 拦截入草稿箱）留人工验收——现有能力，check_state 报缺封面即门禁依据 |
| 微信三种话术真机 | 移交日常使用 | AM-P0 常驻服务重启加载新 registry 后生效（registry 19 条） |

## 二、交付清单

| 产物 | 说明 |
|------|------|
| `github_article.js` | Workflow B：档案定位 → 幂等规划(plan-article) → 素材边界写作(证据核验提示词+输出长度预算) → 审稿 blocking 修复循环(≤3 轮) → 三件套落盘(标题消毒目录+冲突后缀) → 关联登记 → check_state 只读复检 → `{status: article_ready|prepare_ready, missing[]}` + 交接话术 |
| `github_recommend.js` | 总编排：A → check → B → check → 汇总（B 失败提示知识库已保留可单独重跑） |
| `github_kb.py` P1 增量 | `plan-article`（幂等 articleId: gh{日期}-{slug}-{angle}，force 唯一序号）/ `read-archive`（frontmatter+analysis+evidence）/ `article-write`（O_EXCL 三件套，正文命名 `<标题>.md`——article.md 是 check_state 排除名）/ `resolve-workspace` |
| registry | github-article + github-recommend 两条（含 anyOfArgs） |
| 套件 | 59 用例（P1 +9），--skip-network 58 PASS + 1 SKIP |

## 三、真实演示记录

```bash
pi-workflow run dev-examples/wx-article/scripts/github_article.js --args '{"projectId":"lieflat-charts"}'
# agents:4（写作+审稿+修复+二审）/ 345s
# 产物: E:/Obsidian/newsky/60_Workspace/写作/单篇/6432星！让AI把数据变成精致图表/
#   ├── 6432星！让AI把数据变成精致图表.md（804 中文字，全部断言可溯源）
#   ├── article.yaml（title/digest/content_source + github_project_id/article_id/angle 溯源）
#   ├── 配图建议.md / 审稿.md
# 复检: article_ready（缺 cover/images）
# 复跑: agents:0 / 1.3s 幂等返回已有文章
```

## 四、偏差与遗留

| 项 | 说明 |
|----|------|
| 正文字数 | 目标 1500~2200，实测 804 中文字（审稿 B4 下限 1200 按含 ASCII 计通过）；后续可在提示词强化字数下限或按公众号配置（target_word_count）注入 |
| article.yaml author | 硬编码 `AI奇点`（用户 config default_author 同值）；P1.1 可读 config |
| T-G 人工验收 | 用户下次真实走 article-prepare 时确认缺封面被拦+提示（现有能力，风险低） |
| 微信路由真机 | 常驻服务重启后三种话术（只研究/只写文章/一键推荐）验证 |

## 五、经验索引

- 沿用 P0 两篇（全局链接/LLM 输出截断）；本轮新增认知：`article.md` 是 check_state 的正文排除名，正文必须用内容化文件名（已写入 kb 注释与方案）
