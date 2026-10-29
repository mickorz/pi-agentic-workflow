# WX-A1 执行报告：抖音灵感《用AI做游戏，大多数人都搞反了》全链路成文入草稿箱

> 日期：2026-10-28
> 链路：灵感（抖音转写）→ idea_article_start → 选方向 B → Brief → idea_article_write（大纲→正文→审稿→修改扩写）→ idea_article_handoff → 封面生图（preview+裁切）→ article_prepare 入草稿箱
> 结果：**成功**——草稿入箱（status=drafted，draftMediaId 已留档），途中修复 3 个真 Bug（已随链路提交 `2393234`），遗留 1 个流程缺口（审稿无字数维度）
> 性质：需求 A/B 之外的独立实战，首次零模板全链路真机跑通（此前 WX-P4 验收为手动插图范例文，本次为自动生图封面）

## 一、任务与输入

- **灵感素材**：抖音视频转写 `0-raw.md`（190s，12 年游戏从业者 COCO 谈 AI 做游戏方法论：顺应 AI 美术/自然语言叙事两优势选题 + 选接得住 AI 的引擎）
- **用户决策**：不用写作模板（走原稳定链路）、方向全程自主、配图只生成封面（最小费用路径）
- **账号**：wx8cc123bf38237132（account_slot=1）

## 二、执行时间线（全链路步骤与耗时）

| # | 步骤 | 脚本/命令 | 结果 | 关键数据 |
|---|------|----------|------|----------|
| 1 | 灵感登记+选题分析 | `idea_article_start.js --args {content,title,message_id}` | 85s / 2 agents | 工作目录 `写作/灵感/用AI做游戏，大多数人都搞反了/`，A/B/C 三候选落 `2-topic.md`，状态 waiting_topic_confirmation |
| 2 | 方向选择 | `idea_article_turn.js --args {message:"选B"}` | **连续 2 次失败**（Bug ①）→ 修复后成功 | 选 B：方法型候选素材支撑最完整（两优势各配一现成案例）；Brief 落 `3-brief.md`，状态 brief_confirmed |
| 3 | 全链写作 | `idea_article_write.js --args {message:"继续写文章"}` | 174s / 4 agents | 大纲→正文→审稿一轮过：**draft_ready，但正文仅 1204 净汉字 < targetWords 下限 1500**（审稿八维度全过、无字数维度，未拦截——遗留缺口） |
| 4 | 修改扩写 | `idea_article_write.js --args {message:"修改文章: …扩写到1800-2200字…"}` | 全链重生成 | 1478 净汉字（含标点约 1980），八维度零 blocking；Brief「确认记录」段追加修改意见 |
| 5 | 交接 | `idea_article_handoff.js` | 三件套落 `写作/单篇/用AI做游戏，大多数人都搞反了/`（正文+article.yaml+配图建议） | 状态 handed_off |
| 6 | 摘要修正 | 人工编辑 article.yaml | digest 从审稿报告摘录换为读者向摘要 | 原 digest 是「八维度均无 blocking…」流程话术，不适合当公众号摘要——**handoff 生成 digest 的来源待改进** |
| 7 | 封面提示词 | 手写 `image-prompts.md` → `article_image_prompts_convert.js --force` | 确定性解析零 LLM | 踩坑：非标准格式解析错（prompt 只剩 "filename: cover.png"、style_prefix 空）→ 按标准 md 格式重写 + 手动补 style_prefix |
| 8 | 封面试生成 | `article_image_generate.js --args {mode:"preview"}` + checkpoint 批准 ×2 | gpt-image-2 1 张 ¥0.08 / 1 attempt | 1536×1024；图像分析评估：主题契合（岔路+引擎意象）无文字乱码无硬伤 |
| 9 | 封面裁切 | PIL 等比裁切 | **1880×800 精确 2.35:1** | 按「略偏上保齿轮徽章」方案裁（errcode 53401 精确校验教训，见 experience/wechat-cover-235-ratio-and-filename-traps.md） |
| 10 | 风格锁定+batch | `article_image_generate.js --args {mode:"batch"}` | 1.5s（仅 1 张已完成，无新增请求） | manifest status=succeeded |
| 11 | 入草稿箱 | `article_prepare.js --args {skip_confirm:true,account_slot:1}` | **两次中断（Bug ②③）→ 修复 + 门禁全绿后成功** | draft_media_id 留档 publish-state.json，14:02:01 入箱 |

**费用**：生图 1 张 ¥0.08；LLM 消耗约 28 万 tokens（七次 workflow 累计）。

## 三、修复的 3 个真 Bug（commit `2393234`，P0/P1/P2 门禁 46/33/24 全绿）

### Bug ①：Brief 校验与提示词冲突 → 「选方向」必现失败

- **现象**：`选B` 连续两次 `[CHECK_FAILED] Brief 缺少必备段落或过短`。
- **根因**：提示词九段写作要求写成编号列表（"1 最终选题与标题 2 目标读者 …"），模型照抄输出 `## 2. 目标读者`；校验却是 `(brief_md).includes('## 目标读者')` 精确串匹配——**提示词引导的输出格式必然不满足校验**，非概率性失败。
- **修复**：提示词明确「每段用二级标题，标题不带编号（如 ## 目标读者）」；校验放宽为正则 `/##\s*\d*[.、)]?\s*目标读者/`（双保险）。
- **教训**：LLM 输出格式约束与确定性校验必须用同一份格式定义；编号列表式提示词天然诱导带编号标题。

### Bug ②：check_state.py 零图文章 FileNotFoundError

- **现象**：prepare 就绪检查崩溃（无 JSON 输出，agent 返回失败）。
- **根因**：根目录封面优先级提示逻辑（2026-10-27 坑的修复）里 `(article_dir/"imgs").iterdir()` 未先判目录存在——零图文章（无 imgs/）直接 FileNotFoundError。
- **修复**：`imgs_dir.is_dir()` 前置守卫，不存在则空列表。
- **反讽点**：上一轮踩坑修复（封面优先级提示）自身引入了新崩溃路径。**每次为踩坑加的检查代码，也要过「字段缺失」的用例。**

### Bug ③：多 md 歧义不认 content_source 显式指定

- **现象**：文章目录有两个 md（正文 + image-prompts.md 转换产物场景），check_state 报 `md candidates=2` 拒绝，prepare_ready=false——而 article.yaml 明确写了 `content_source: 用AI做游戏，大多数人都搞反了.md`。
- **根因**：check_state 只做「唯一 md 候选才自动」判定，从不读取 yaml 的 content_source 字段（该字段此前仅落档不参与判定）。
- **修复**：content_source 存在时确定性精确匹配（命中即唯一、不命中报错不猜）；无 content_source 多 md 仍拒绝猜测（原语义保留）。P1 门禁 B2 用例更新为新语义 + 新增「无 cs 歧义」用例。
- **顺带发现并修**：新分支曾漏定义 `md_path=None` 导致 UnboundLocalError——新分支每个出口都要补齐全量变量。

## 四、遗留问题

1. **审稿八维度无字数维度**：1204 字低于 targetWords 1500 下限照样 draft_ready，靠人工发现再人工扩。建议审稿加第 9 维「字数达标」（blocking 级，直接读 config.targetWords），待确认后实施。
2. **handoff 生成的 digest 来源不当**：把审稿报告摘录当摘要写进 article.yaml。建议 digest 由正文导语生成或人工提供。
3. **image-prompts.md 非标准格式确定性解析静默产出坏 JSON**（prompt 只剩 filename 行、style_prefix 空未报错）——建议 convert 增加「items[].prompt 为空/过短即 FAIL」的产物自检。

## 五、验证与证据

- 门禁：run_p0_gate_suite 46/46、run_p1_gate_suite 33/33（B2 用例更新后）、run_p2_gate_suite 24/24。
- Example：wx-quality 套件不受影响（本次未触碰）。
- 草稿箱证据：publish-state.json accounts.wx8cc123bf38237132 = {status: drafted, draftMediaId: RzpZ…1T-, thumbMediaId: RzpZ…JT-, contentHash: eed5faee…, updatedAt: 2026-10-28 14:02:01}。
- 提交：`2393234`（4 文件，+41/-13）；执行进度续八已登记。

## 六、下一步（待用户）

- 草稿箱预览确认 → 微信「发表文章」或走 article-publish。
- 遗留 1/2/3 是否立项修复，待指令。
