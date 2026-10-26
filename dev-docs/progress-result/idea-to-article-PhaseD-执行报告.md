# idea_to_article Phase D 执行报告（handoff 交接层 + T18–T20 + 交付核对）

- 日期：2026-10-24
- 范围：执行方案 §2 D7 handoff 适配层、§8 T18–T20、D8 话术文档、§15 交付定义核对
- 前置：Phase A（7985bb1）/ B（6e3cbb7）/ C（422fdd0）

## 交付清单

| 交付物 | 位置 | 说明 |
|---|---|---|
| handoff 子命令 | `dev-examples/wx-article/scripts/draft_manager/idea_files.py` | 确定性交接：前置校验（draft_ready/无 ⛔/无 stale）→ `单篇/<标题>/` 三件套（O_EXCL）→ handoffId 幂等 → 回写 handed_off |
| 交接 workflow | `dev-examples/wx-article/scripts/idea_article_handoff.js` | 薄壳：locate → handoff → 播报（含「准备文章」指引）；unknown 转人工不自动重试 |
| 双 registry 注册 | am-p0（22 条）/ wx-article（16 条） | idea-article-handoff（write，**不在 auto-approve 白名单**——关键节点保留审批） |
| e2e 测试 | `tests/unit/idea-article-handoff.test.ts` | 7 用例：T18a/b/c、前置三拒、冲突命名、T19、T20 |
| 话术文档 | `dev-docs/guides/2026-10-24-idea-to-article-wechat-话术编排.md` | D8 补齐：能力总表+状态机话术对应+边界治理+真机示例 |

## 交接契约（D7 落地）

- **三件套**：`<标题>.md`（正文，frontmatter 缺 title/description 才补）+ `article.yaml`（pipeline 格式 title/author=AI奇点/digest=审稿总结首句/title 回退/publish_completed:false/content_source）+ `配图建议.md`（可选：工作目录已有则复制，否则从 4-outline.md `## 配图建议` 段提取，均无则跳过并 note）。
- **正文唯一性对齐 check_state**：交接正文命名 `<标题>.md`，不落 article/draft/review 前缀与中文保留词——测试内用同规则过滤断言 `candidates==1`。
- **handoffId**：`sha256(articleId|sha256(5-article))[:16]`；重复交接内容一致→幂等成功零重写；不一致→`unknown` 拒绝+播报人工核对；部分失败（目录丢文件）→ O_EXCL 续补。
- **冲突命名**：`单篇/<标题>` 被占 → `<标题>-YYYYMMDD-<articleId 后 4>`；再冲突→invalid。
- **T20 不自动发布**：脚本无 publish/freepublish/draft 通道（源码断言）；registry 无 idea-article-publish；下游只经用户消息触发现有 article-prepare（external-side-effect 独立审批）。

## 验证证据

- `npx tsx --test tests/unit/idea-article-handoff.test.ts`：7/7 PASS
- `run_idea_files_suite.py`：47/47（handoff 动作不破坏存量契约）
- `npm run build` 零错误；`npm test` 475 tests 474 pass + 1 skip，0 fail
- `run_resolver_suite.py`：18 PASS + 1 SKIP
- 手工冒烟（/tmp/ho-demo）：首次交接三件套+digest 取审稿总结+description 补齐；幂等重试 ok；改稿后 unknown 转人工——与单测一致
- PM2 restart：healthy，registry 22 条 sha e163f036（版本指纹 git 422fdd0）

## §15 交付核对（需求交付定义逐项）

| 需求交付项 | 状态 | 证据 |
|---|---|---|
| F01–F03 灵感→选题→Brief | ✅ 代码+e2e | Phase B 10/10；真机主话术已通（灵感落点 1-idea.md） |
| F04–F07 大纲/正文/审稿 | ✅ 代码+e2e | Phase C 10/10（含大纲审批/修复循环/断点续写） |
| F08 状态查询 | ✅ | status 列表/详情 e2e |
| F09 交接 | ✅ 代码+e2e | 本报告 T18a/b/c |
| F10 安全（T19 素材边界/路径防逃逸/幂等转人工） | ✅ | T19 + idea_files 47/47（穿越/symlink/元字符/1MB） |
| T01–T20 | ✅ e2e 层全绿（T01/T10/T12 随 start 上线回归过；T18–T20 本期）；**真机三场景 A/B/C 待用户配合验收** |
| §14 实施前核查 7 项 | ✅ | 执行方案 §14 表（调研双报告背书） |

## 偏差与遗留

1. **真机三场景 A/B/C**（一句话灵感全链/长素材多轮/跨天续）待用户微信实测——e2e 已覆盖等价链路；话术文档第四节给出照抄脚本。
2. **7-publish.md 降级**（方案 D7 既定偏差）：交接只记 `handed_off`+播报，不侵入 publish-state.json。
3. **配图建议来源**：V1 由大纲 `## 配图建议` 段提供（handoff 提取）；write 脚本大纲 prompt 已注明可附该段，LLM 未附时不阻断交接（可选件）。
4. **发布凭证**：本机无 aws.env，草稿/发布环节按约定在 Windows 机执行。
5. stats.durationMs/lastRunAt 通道已开未强制记录（agentCount 已记）。
