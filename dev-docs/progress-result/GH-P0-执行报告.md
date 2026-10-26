# GH-P0 执行报告 — GitHub 项目研究与知识库（github-research）

> 阶段：GH-P0（GitHub 项目研究与推荐文章需求 · P0）
> 需求：`dev-docs/planning/2026-10-26-GitHub项目研究与推荐文章需求文档.md`
> 方案：`dev-docs/planning/2026-10-26-GitHub项目研究与推荐文章执行方案.md`（V1.1，含评审五项修订）
> 完成时间：2026-10-26
> 结论：**P0 独立验收通过**（不依赖文章生成能力）

## 一、验收结论

| 验收项（方案第九节 P0 口径） | 结果 | 证据 |
|------|------|------|
| 真实 GitHub URL → 完整项目档案 | 通过 | `pi-workflow run github_research.js`（psf/requests，agents:1 / 78.4s），档案含 raw 四源 + analysis 七段 + evidence 10 条 + project.json（repoId/treeSha/license/pushedAt 等快照字段） |
| 重复输入秒回 reused | 通过 | 二次运行 agents:0 / 3.5s，直接复用档案 |
| 评审用例 T-A 并发不丢索引 | 通过 | 套件用例（两进程并发 archive，索引两条都在） |
| 评审用例 T-B 中断续传 | 通过 | 套件用例（只补失败源 readme，不重抓已有源）+ 真实网络 SSL 超时后重跑只补 readme |
| 评审用例 T-C force 失败原档案完好 | 通过 | 套件用例（staging 清除、analysis/关联原样）+ force 成功路径（firstArchived 保留、staging 替换后目录消失） |
| 评审用例 T-D 恶意 README 不执行 | 通过 | evil-readme fixture：注入文本只作素材落盘 raw；workflow 提示词含素材边界包裹 |
| 测试套件 | 42 用例全 PASS（含真实网络冒烟；--skip-network 时 41 PASS + 1 SKIP） | `python run_github_kb_suite.py` |
| 证据等级契约 | 通过 | documented/inferred 区分落 evidence.json；无证据百分号被归档校验拒绝（套件用例） |
| 索引并发与崩溃一致性 | 通过 | .kb-lock 互斥 + 临时文件原子替换 + rebuild-index 无损重建（套件用例） |

## 二、交付清单

| 产物 | 路径 | 说明 |
|------|------|------|
| 知识库脚本 | `dev-examples/wx-article/scripts/github_kb.py` | 确定性域逻辑（零 LLM）：parse-url / fetch（白名单 api.github.com、拒跨域重定向、限流显式报错、**README 图片本地化到 raw/imgs 并改写引用**）/ detect-duplicate / archive（校验+锁+staging 暂存替换+repoId 改名迁移）/ locate / register-article / rebuild-index / resolve-root（vault 70_KnowlegeBase/01_Github 回退链）/ read-raw / download-images（补图） |
| Workflow A | `dev-examples/wx-article/scripts/github_research.js` | 解析→查重→缓存状态机抓取→素材边界包裹的 LLM 分析（七段+证据+meta）→归档校验→返回 |
| 抓取 fixture | `dev-examples/wx-article/scripts/fixtures/github/` | demo-repo（正常样本）+ evil-readme（指令注入样本） |
| 测试套件 | `dev-examples/wx-article/scripts/run_github_kb_suite.py` | 42 用例（布局变更后重写）：URL 解析 5、抓取 .incoming/续传 2、README 图片本地化 4、查重 2、归档校验 4（含 .incoming raw 保留）、合法归档/分类目录/project.md frontmatter 6、同名冲突守卫 2、关联登记 3、force 暂存 4、重建 1、改名迁移 2、resolve-root 3、并发 T-A 1、T-D 1、真实网络冒烟 1、其他 1 |
| 冒烟自检 | `dev-examples/wx-article/scripts/github_kb_Example.py` | 30 秒快速冒烟（解析→抓取→归档→定位） |
| registry | `dev-examples/wx-article/registry.json` | 新增 `github-research`（write 级，enabled=true，url 必填 + force/fixture/kb_root 可选） |

## 三、验证记录（命令与输出要点）

```bash
# 1. 套件（全量，含真实网络）
python dev-examples/wx-article/scripts/run_github_kb_suite.py
# === ALL DONE === PASS=30 FAIL=0 SKIP=0 TOTAL=30

# 2. Example 冒烟
python dev-examples/wx-article/scripts/github_kb_Example.py
# === ALL DONE === PASS

# 3. 真实仓库端到端（CLI，全局命令，缺省模型）
pi-workflow run dev-examples/wx-article/scripts/github_research.js \
  --args '{"url":"https://github.com/psf/requests","kb_root":"C:/tmp/gh-kb-smoke-real"}'
# ✅ agents:1, 78.4s; 档案 C:/tmp/gh-kb-smoke-real/projects/psf__requests/

# 4. 幂等复用（同参数重跑）
# ✅ agents:0, 3.5s, reused

# 5. force 暂存替换（fixture）
# ✅ staging 建立→替换→消失; firstArchived 13:32:06 保留, lastResearched 13:44:53 刷新
```

真实分析质量抽样（psf/requests analysis.md）：证据意识符合设计——「87% 测试覆盖率来自 README 自述的 CI 报告，未经独立验证」主动标注；推荐角度建议给出 3 个候选角度。

## 四、与方案的偏差说明

| 偏差 | 原因 | 影响 |
|------|------|------|
| `project.json` 存 `treeSha`（默认分支树 SHA）而非 commitSha | 保持 4 请求/次（不额外请求 commits API）；treeSha+pushedAt 同样满足变更检测 | 无实质影响；后续需要精确 commit SHA 时加第 5 个请求即可 |
| 索引键采用 camelCase（repoId/pushedAt…） | 与 registry.json 风格一致，json 标准库无歧义 | 无 |
| 微信路由命中未真机验证 | 启动微信服务需真机窗口（AM-P0 指南流程），P0 验收口径不强制 | 移交 P1 真机（T1.4 一并验证三种话术路由） |

## 五、遗留问题

1. **微信路由命中（route dry-run 已验证）**：`pi-workflow route --text "研究这个 GitHub 项目 https://github.com/psf/requests"` → `intent=execute_workflow / action=start_execution / workflowId=github-research / args={repoUrl:...}`（confidence 0.98）。修复根因一处 src bug：`src/dispatch/intent-router.ts` 对 `argsSchema.required`（数组）误用 `Object.keys()`，把必填参数名列表变成 `["0"]` 误导路由模型；修复后与 task-control-facade 同构。url-router 套件 31/1（唯一失败为干净基线同样失败的既有环境问题）。真机（微信服务）验证移交 P1（T1.4）。
2. **知识库根生产配置（已落地）**：resolve-root 链：--kb-root → GITHUB_KB_ROOT → config 显式 `github_knowledge_root` → 从 article_workspace 向上找 vault 级 `70_KnowlegeBase/01_Github`（父目录在则自动建叶子，否则明确报错）。真机已配置：vault 生产 config（单篇/.aws-article）与仓库本地 config（dev-examples/wx-article/.aws-article，机器本地 gitignored）均写入 `github_knowledge_root: E:/Obsidian/newsky/70_KnowlegeBase/01_Github`；不带 --kb-root 端到端验证通过（game-ui-design-workflow 档案已落 vault）。resolve-root 回退/优先级/报错三用例入套件（33 用例）。
3. **GitHub 匿名限流 60 次/h**：网络抖动（SSL 握手超时）出现 2 次，重跑按 manifest 续传即恢复；建议生产配 GITHUB_TOKEN。

## 六、经验索引（本次沉淀）

- `dev-docs/experience/global-pi-workflow-link-stale-checkout.md` — 全局命令链接指向旧仓库导致 `command is not defined`
- `dev-docs/experience/llm-structured-output-truncation.md` — LLM 结构化输出超长被截断，提示词需加长度上限

## 七、下一步（P1）

按方案第十节：T1.1 github_article.js（两级状态 + check_state 复检）→ T1.2 register-article 闭环 → T1.3 github_recommend.js 总编排 → T1.4 registry + 微信三种话术路由真机 → T1.5 套件扩展（T-E/T-F/T-G）→ T1.6 文档收口。
