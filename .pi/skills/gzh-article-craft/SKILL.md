---
name: gzh-article-craft
display_name: 公众号文章创作全流程
description: 从引用材料/产品热点写公众号文章的完整流程，两确认点制（2026-11-12）：①大纲包（定位结论+标题10候选+章题大纲）用户修改确认；②确认后全自动连跑（写作→截图→提示词→生图→入文→humanizer自批修订→入箱准备），gzh-preview 预览工作台内编辑保存后聊天确认发布。Use when 用户要基于引用文章、产品发布或热点"写一篇公众号文章"、讨论大纲、生成配图提示词，或走文章准备流程。
description_zh: 从引用材料到成文、配图提示词、入草稿箱的公众号文章生产全流程，含踩坑规避清单。
---

# 公众号文章创作全流程（gzh-article-craft）

> **路由边界（2026-11-10）**：用户要制作小绿书、图片卡片或发布贴图（图片帖）时，必须使用 `xiaolvshu` skill，不得使用本文章流程；本 skill 只管长文。

本 skill 沉淀自 2026-10-28《Personal Agent 元年：蚂蚁灵光 2.0》全流程实战（引用消化→成文→16 张截图→4 张生成图提示词→审批文档）。

**先读两份文档**：① `references/pitfalls.md`——踩坑清单是本流程的地基，写作/生图/发布各阶段的"必须避免"都登记在那；② 仓库根 `preference.md`——用户偏好登记册，开写前先过一遍，历史口味（标题风格、段落节奏、钩子默认、纠偏记录）都在里面。

**偏好即时登记（2026-11-09 定案）**：流程中用户每一次拍板选择（定位/标题/钩子/封面风格…）或纠正写法（"不要这种开头""太长"…），凡属可复用偏好而非本篇特例，必须当场登记到仓库根 `preference.md` 对应分类下（注明定案日期与场景），并 commit；本篇特有的选择记在大纲.md，不进偏好册。

## 流程总览

| 阶段 | 动作 | 产物与落盘点 |
|---|---|---|
| A 定位+大纲 | 材料提炼+定位结论+标题 10 候选+大纲包 → **确认点 1**（用户修改后确认） | `大纲.md` 落盘 |
| B 写作 | 大纲确认后全章连写，每章完立即 `cat >>` 落盘，无章级审批 | `文章目录/<标题>.md` |
| C 截图 | 引用材料中的图下载入 `imgs/` 并插正文（agent 视觉核对内容后归位） | `imgs/NN-分类-主题.jpg` + 正文引用 |
| D 提示词 | 构造 `image-prompts.json`（关键图带文字+expected_text） | `image-prompts.json` |
| E 留档 | `export-review.mjs` 渲染成稿留档（不设用户门） | `review-image-prompts.md` |
| F 生图 | batch 直跑（style_approved 自动通道）+ agent 视觉核对（article-image-generate workflow） | `imgs/cover-*.png`、`imgs/NN-*.png` |
| F2 入文 | 生成图按锚点插入正文（edit 精确替换，不重排全文） | 正文引用 + `imgs/` |
| F3 去AI味 | humanizer 两遍法扫描（全文索引→分章精扫+缓存）→ 建议改 agent 自批直接应用 → 对账只重扫改动章 | `review-humanizer.md` + `humanizer-scan-cache.json` + 修订后正文 |
| G 入箱 | 准备文章流程(normalize→check_state→**G.5 预览工作台=确认点 2**→publish→停台) | 草稿箱 + `publish-state.json` |

**两确认点制（2026-11-12 定案，取代逐章 ok 制/三级分批审批制/封面签样/humanizer 审批/提示词过目等全部用户门）**：全流程只留两个用户确认点——**确认点 1=大纲包**（A 阶段，用户修改+确认后进入全自动段）、**确认点 2=gzh-preview 预览工作台**（G.5，用户在预览内编辑/浏览/保存，聊天确认后发布）。其余环节 agent 自主推进+自主质检（视觉核对/引用对账/check_state 照旧）；用户随时可在聊天提修订（非门禁，agent 即改）。代价与对策：中途无用户门，跑偏返工面是全文——把关前移到大纲（确认点 1 的每章要点必须写细：引用哪些事实/数字、结论是什么）；生图无签样，风格靠 space-image 九套默认+历史偏好锁定，不满意在确认点 2 提出重生成。

文章目录约定：`60_Workspace/写作/单篇/<YYYYMMDD>/<主题>/`（坚果云），正文 md 与 `引用/`、`imgs/` 同级。

## 耗时记录（2026-11-11 新增，scripts/track_time.py）

每阶段完成时记一条时间戳（数据落文章目录 time-log.jsonl，随文章同步），发布后一键出耗时报告，支持跨篇历史分析：

```bash
S=".pi/skills/gzh-article-craft/scripts/track_time.py"
# 阶段完成时顺手记一条（补录历史加 --ts "YYYY-MM-DDTHH:MM:SS"）
python3 "$S" log --article-dir <文章目录> --stage 写作
# 审批完成时记一条交互点（confirm=纯确认 / rework|edit=返工，附修改产物）
python3 "$S" log --article-dir <dir> --stage 写作 --interaction approval --result confirm
python3 "$S" log --article-dir <dir> --stage 写作 --interaction approval --result rework --artifacts chapter-03.md,chapter-04.md
# 发布完成后：单篇报告（各阶段耗时+占比；耗时为相邻完成点间隔，含阶段内等待用户的时间；含审批返工率）
python3 "$S" report --article-dir <文章目录>
# 跨篇历史分析
python3 "$S" report --vault-root "<vault>/60_Workspace/写作/单篇"

# Token 用量离线分析（2026-11-11 新增）：阶段时间窗 × pi session jsonl → 各阶段 Token/成本/工具统计
U=".pi/skills/gzh-article-craft/scripts/session_usage_report.py"
python3 "$U" --article-dir <文章目录> --session <session.jsonl 路径>
#   或自动挑与时间窗重叠最多的 session：--sessions-dir ~/.pi/agent/sessions
#   输出含归因可信度 high/medium/low；low 表示会话混杂，数据不得进跨篇对比结论
```

- 标准阶段名（跨篇一致）：定位 / 写作 / 截图 / 提示词审批 / 生图 / 入文 / humanizer / 入箱准备 / 排版审阅 / 发布；会话开始可加一条 `--stage 定位 --event start`
- **两确认点制下的交互点（2026-11-12）**：交互条目只记两个确认点及其多轮修改——确认点 1（stage=定位，用户每轮修改记一条，最后一轮 confirm；rework 附修改产物如 `大纲.md`）、确认点 2（stage=排版审阅，confirm；用户在预览阶段要求返图的记 rework 附产物）；聊天中的非门禁修订指令（用户随时提的措辞/事实修正）按 rework 记在对应阶段；交互条目一律在**用户回复后**落笔，不得在 agent 交付时预记、不得漏记
- 报告执行时机：G publish 成功后，把 report 输出贴进当篇交付总结；需要落盘时存 `dev-docs/progress-result/<日期>-<主题>篇全流程执行报告.md`（含执行/等待拆分时按对话轮次手工补充）

## A. 定位与大纲包（确认点 1）

先读 `引用/` 下全部材料，产出**大纲包**（一份 chat 摘要 + `大纲.md` 落盘），内容四件：

1. **材料干货提炼表**（每篇引用一个核心增量，含评论区金句和反方声音）
2. **定位结论**（agent 按材料气质定并写明理由，用户在确认时可改）：趋势判断 vs 实操体验、推广向 vs 中立向、冷思考轻重（默认轻提）、结尾处理（默认不留钩子自然收尾，preference 2026-10-31 定案；要留钩子由用户在确认时写明候选）
3. **标题 10 连，全部 GEO 疑问句（2026-11-04 定案）**：十种角度(事件/数字/利益/对比/身份代入/痛点/惊叹/攻略/趋势/是什么)各一个，一律疑问句形态，标注推荐项；GEO 三要素照旧：
   - ①疑问词开头：怎么/如何/为什么/是什么/哪个/值不值
   - ②核心关键词前置：工具名/场景词放在问句主干，匹配搜索意图
   - ③答案暗示入题：问句后缀方案名/数字
   - 禁纯悬念空题；禁问句与后缀脱节
   - **主关键词任何交付形态都不得漏（2026-11-12 定案，Minimax H3-Image 篇纠偏）**：每个候选的完整标题都必须含主关键词（工具名/产品名）；chat 表格、交互选项 label、缩写标签等一切展示形态都不得为省字数把主关键词截掉——选项 label 放不下就换更短的题，不许出"无主关键词版"，更不许表格里带词、选项里丢词两副面孔
4. **大纲**：钩子→是什么→实测/论证→方法→(轻)冷思考→行动收尾。**章题一律 GEO 疑问句，框架序号词（第一层/第二步/阶段一）不进章题（2026-11-04 多Agent篇教训）**；每章列**要点三件：写什么、引用哪些事实/数字、结论是什么**；附配图规划（哪些章用引用截图、哪些章需生成图）

**确认点 1**：用户改 `大纲.md` 文件或聊天提修改，可多轮；回复确认后锁定大纲进入全自动段（B→G 中途无用户门）。**大纲确认即质量契约**：中途无章级审批，跑偏返工面是全文，把关全部前移到本确认点——逐章核对要点是否材料支撑充分、章题是否可检索、结构是否达意。

常见用户偏好（历史决策）：实操推广向、亮点前置到开头钩子（如"免费"）、竞品做铺垫不做对手（Manus=国人能力证明，本产品=落地国内生态）。

## B. 写作规范

- **全章连写制（2026-11-12 两确认点制定案；三级分批审批制与动态降级规则同日作废）**：大纲确认（确认点 1）后全部章节连续写作，每章写完立即 `cat >>` 落盘（防丢失不变），全文写完直接进 C 阶段；不设章级/批次审批门
- **修订主场**：gzh-preview 预览工作台（确认点 2，可直接编辑正文并保存写回）+ 聊天内随时提修订（非门禁，agent 收到即改已落盘章节并在回复中 diff 说明，不重复内容）
- 文风参考基线：短段落（单段 1-3 句）、每章 400-700 字、全文 6-8 章 3000-5000 字、**章题一律 GEO 疑问句(2026-11-04 定案,同日补禁框架序号词)**：章题=该章核心问题的搜索问法,疑问词开头+关键词入题,与主标题关键词呼应不重复;**禁用文章自造的框架序号词开头**(第一层/第二步/阶段一等——读者不会搜"第一层怎么做",搜索词必须是真实用户语言,如"通知消息怎么写""会话怎么命名""控制平面是什么");框架内部的层号/步骤号放章内正文交代,不进章题
- **事实纪律**：只使用引用材料中的事实；为承载配图加的过渡句也必须源自引用事实，不虚构功能/数据；大纲要点即事实清单，写作不得超出大纲引用的事实范围
- **禁用网友 @handle 表达**（2026-10-29 定案）：正文不得出现 @某某 网名句柄（含不带 @ 的英文 handle，如 LinearUncle）；引用的事实与金句保留，只去掉句柄
- **去第三人称转述框架（2026-11-04 定案）**：正文不用"一位独立开发者发推讨教""有网友分享"类人物转述框架——引用材料的事实与场景直接**去人称化**融入行文：把"他遇到两个痛点"写成"这套做法很快撞上两个真痛点"，把人物状态写成现象本身；需要保留金句时用直接引语(引号引用原句,不加"他说");需要留出处时用最轻的来源标注("评论区当场有人接话"而非"有位做产品的人回复说");禁止为叙事感虚构人物视角

## 浏览器通道优先级（2026-11-12 定案）

需要浏览器采集/操作（引用截图下载、网页截图、登录态页面）时：**默认 chrome-use**（image-use/open_preview 同通道，驱动用户已登录 Chrome，零 API key、免粘贴）；**chrome-use 不可用才回落 pi-browser-use**（或 curl 直下等替代通道）。不可用判定：relay 预检 `[FAIL]` 且处理后仍不连（见 dev-docs/experience/chrome-use-relay-not-connected-upgrade-1-5.md）、pi-browser-use ENOENT 等（见 dev-docs/experience/pi-browser-use-enoent-stale-nvm-execpath.md——nvm 迁移后需重启 pi 会话）。不要跳过 chrome-use 直接走替代通道。

## C. 引用截图下载

- **下载通道（2026-11-12 定案）**：默认 chrome-use（已登录态直存原图，含 X/微信等需登录页），chrome-use 不可用才回落 curl 直下（`-x http://127.0.0.1:7897` 代理按需）或其他通道；curl 下载仅适用于公开直链，登录态资源会拿到登录墙页（下载后必查可发现）

- 命名与校验（curl 回落通道同样适用）**：`NN-分类-主题.jpg/png`，NN=章序号；**禁空格/括号/全角括号**（IMG_REF 正则 `[^)]+` 会在首个 `)` 截断，见 pitfalls #1）
- 下载后必查：`file -b` 非 empty、大小 >10KB；404（X 端原图下架）→ 用同段落替代图并同步改配文，或弃用
- 全部入文后跑一遍"引用↔文件一一对应"检查（引用数=文件数、无悬空、无未引用、无违规文件名）

## D. image-prompts.json（配图提示词）

schema（`version / article_id / style_prefix / items[]`），每 item：`id, kind(cover|body), heading(对应##章节，封面留空), diagram_type(生图类型标注，如：3D信息图/流程图/状态机/架构图/时间线，审批文档与 json 均显式标注), prompt, expected_text?, filename`。

**技术讲解类文章先读 diagram-design（2026-10-29 定案，2026-11-02 补竖版规则）**：技术架构/原理/流程类文章，正文图核心是技术架构图、流程图、状态机、时间线，先读 `.pi/skills/diagram-design`（扁平编辑风、节点 ≤9、直角圆弯连线、无阴影无辉光、强调色只给 1-2 个焦点元素），按其设计语言写 body 图提示词；封面保留账号 3D 风格，body 图 prompt 开头显式声明“扁平编辑风格技术示意图（不出现 3D 人物与办公场景）”覆盖风格头；事件名/标识符用等宽字体小字，中标题大字号。**画幅默认竖版**（2026-11-02 定案）：手机竖屏是主阅读场景，横版宽图缩放后字号不可读（实测 1600 宽横版在 390 宽手机上字号只剩 4-6px）——示意图宽 ≤850、主流程纵向自上而下、保证节点名在手机有效字号 ≥10px；mermaid 自动布局只用于快速草稿，正式图用 diagram-design 手绘 HTML → 无头 Chrome 2x 截图 → 1200px 落 imgs/

**第一章必须有中心图（2026-10-29 定案）**：第一章是全文定调章，必须生成一张能表达全文核心论点的生成图（`01-` 前缀，diagram_type 如实标注），不是装饰图：先问“这篇文章的中心思想用一句话是什么”，把那句话翻译成画面；封面表达钩子，01 图表达中心，两者分工不同不重复。跳过 01 图视为流程违规。

**封面风格默认 space-image 九套(2026-11-09 定案,首次接入 2026-11-05,首试 lifestyle-handdrawn 已验证)**:封面 style_prefix 默认从 `references/space-image-styles.md` 的九套里按内容气质选(用户不指定时按该表场景映射选,如系统/工程/Agent→premium-black-chrome),用 space-image 时**必须先走其"提炼五项"视觉简报**(主题/关键词/关系句/中心隐喻/视觉冲突,中心隐喻禁止每词一图标),prompt 用风格头完整语法;账号 Business AI 3D 降为可选(用户点名时用);正文图规则不变(diagram-design/生图铁律),body 图 prompt 开头显式声明扁平编辑风覆盖风格头;生图铁律(expected_text/2.35:1/filename)照旧。

**铁律（文字缺失复现教训，见 pitfalls #4）**：
1. style_prefix **不得**带"画面中不出现任何文字"条款；写"文字只允许出现在指定标题位置"
2. **每张图写 prompt 前先问：这张图的关键词是什么？** 封面=主标题关键词；章节主图=一个短词/短语（visual-rules 纪律：字号大、笔画清晰、不排长句）
3. 声明了画面文字的图**必须**同步声明 `expected_text: ["关键词1","关键词2"]`（T4 验收契约：生成后 content_review pending → 用户核对 → approve/reject，漏字不会静默放行）
4. 尺寸：封面 prompt 写"宽高比 2.35:1 横版、关键视觉居中安全区"；正文写"16:9 横版"
5. filename：封面 `cover-中文主题.png`；正文 `NN-中文标题.png`（NN=第 N 个 ## 章节，与既有截图序号衔接）
6. 风格头沿用账号统一风格（Business AI 3D Infographic，色板 #142B49/#1776E8/#16B6AF/#FF9B35/#F5F8FC），保持系列一致性

## E. 成稿留档

```bash
node dev-examples/wx-article/scripts/image_gen/export-review.mjs --article-dir <文章目录>
```

渲染 `review-image-prompts.md`（2026-10-28 修复命名：review- 前缀命中正文定位排除规则，旧名 image-prompts-review.md 会把 md 候选搞成不唯一）：风格头全文 + 逐张完整成稿（style_prefix+分隔符+prompt）+ expected_text + 状态 + 调整指引。**不设用户过目门（2026-11-12 两确认点制）**：文档作为留档与生成后核对参照；agent 自查发现 prompt 问题直接改 `image-prompts.json` 源头重渲染（本文档只读）。

## F. 生图（batch 直跑）

```bash
# 两确认点制（2026-11-12）：preview 用户签样门取消，batch 直跑（style_approved 自动通道）
pi-workflow run dev-examples/wx-article/scripts/article_image_generate.js --non-interactive \
  --args '{"article_dir":"<绝对路径>","mode":"batch","provider":"image-use","skip_confirm":true,"style_approved":true,"retry_failed":true}'
# 若执行器报风格门（style_gate required）：先跑一次 preview+style_approved:true 完成自动锁定再 batch
```

- **preview 用户签样门取消（2026-11-12 两确认点制）**：不再等用户看封面确认后才 batch；风格锁定靠 space-image 九套默认+历史偏好（preference.md），封面/图质量由 agent 视觉核对把关（expected_text 逐张核对+approve-text）；用户对图不满意在确认点 2（预览工作台）提出，agent 改 prompt → 重 batch → 重新入文核对
- `provider: image-use`（默认 pi-image-gen 是智谱 API，需要 IMAGE_GEN_API_KEY，一般没配）
- **`retry_failed: true` 必带**（manifest 里有 failed 条目时不重试会"空跑"，见 pitfalls #6）
- **生成前先跑 relay 预检（2026-10-29 定案，替代口头提醒"记得开 Chrome"）**：`python dev-examples/wx-article/scripts/image_gen/preflight_relay.py` → 输出 `[OK]` 才进 batch；`[FAIL]` 时按脚本输出的中文指引让用户处理（正常打开日常使用的 Chrome 即可，扩展随浏览器自动上线；**绝不杀 Chrome**），处理后复跑预检直到 `[OK]`；命令找不到或仍不连，升级与 native host 注册路径见 dev-docs/experience/chrome-use-relay-not-connected-upgrade-1-5.md
- E_ENV（chrome-use 驱动不了 Chrome）处置见 pitfalls #5：**不要杀 Chrome**——让用户正常开 Chrome（relay 扩展随浏览器上线），冷启动/杀进程后的 profile 拉不起 chatgpt.com
- 生成成功后：封面走文字核对（expected_text → content_review pending → `--approve-text`），正文图同理
- **图片核对一律用视觉分析工具（2026-10-29 定案）**：主模型可能不支持直接读图，生成后/挑图时核对 expected_text 拼写、画面元素、乱码畸形，统一用 `zai_mcp_server_analyze_image`（或同类视觉分析工具）逐项检查，全部通过后才 `--approve-text`；不许凭"生成成功"默认放行。引用截图下载后如需确认内容未下错，同样用该工具

## F2. 生成图入文（手动生成/批量生成后）

图片到位后按锚点插入正文（edit 精确替换，不重排全文）：

- **封面**：正文第 1 行插 `![文章封面](imgs/cover-主题.png)`（手动插图流程约定，正文定位/封面识别都认）
- **正文图**：按 prompts 的 heading 找该章金句/总结句之后插入 `![一句话描述](imgs/NN-主题.png)`；alt 写画面含义不写文件名
- 插入前注意：用户可能已在 Obsidian 改过章题/正文——**edit 的 oldText 必须先 grep 当前文件核实**，不要拿记忆里的旧句当锚点

## F3. 发表前 humanizer 去 AI 味（2026-10-29 新增，必过；2026-11-11 改两遍法+分章+缓存）

上传发表前，用 humanizer skill（`.pi/skills/humanizer/`）全文过一遍，**先审批后改动**，流程改两遍法（耗时优化：首扫靠分章并行压缩，重扫靠缓存只碰改动章）：

**第一遍（全文层，快）**：通读全文只做三件事，不逐句精扫：
1. **跨章模式检查**（只在全文层查，不进分章分支）：§7 重复句首、§2 全文节奏、§12 AI 词频统计——这类模式单章内看不见
2. **问题索引**：可疑段落定位（章号+段位置），作为第二遍精扫范围
3. **章节 sha 计算**：逐章算内容 sha，写入缓存（见下）

**第二遍（分章层，可并行）**：按问题索引对命中章节精扫——每章只读 humanizer SKILL.md 相关模式组 + 该章原文，普通章可并行子 agent（子 agent 只产出结构化命中清单，审批文档由主 agent 汇总统一格式）；未命中章节直接标 clean。

**扫描缓存 `humanizer-scan-cache.json`（落文章目录，每章一条）**：

```json
{
  "chapter_id": "03",
  "chapter_sha": "<章节内容 sha>",
  "rules_sha": "<humanizer SKILL.md 文件 sha>",
  "scanner_version": "1.0.0",
  "status": "clean | has_hits | failed | stale",
  "hits": [],
  "scanned_at": "2026-11-11T15:59:00"
}
```

- **缓存有效条件：chapter_sha、rules_sha、scanner_version 三者全部相同**；任一变化（文章改了/规则改了/流程升级）即判 stale 重扫——防"文章没变但规则变了"的假命中；scanner_version 在扫描流程改版时手动递增
- **四态纪律：`failed` 不得当 `clean`**——扫描失败（子 agent 超时、输出不合规）必须重扫，不得静默放行；`stale` 由对账时计算得出，不落盘

生成审批文档 `review-humanizer.md`（review- 前缀命中正文定位排除规则；**格式不变**）：每条含【位置（章）】【原句摘录】【命中模式（§编号）】【建议改法】【处置建议】；**只出文档不动原文**（处置时改）。

**文体豁免原则**：公众号文体的短段落、金句收尾、排比节奏是刻意修辞，命中模式但属文体选择的标注"保留（文体）"并说明理由；只把真正的 AI 腔列为"建议改"。源自引用材料的原句（如受访者金句）一律保留。

**agent 自批直接应用（2026-11-12 两确认点制）**：不再等用户批准——"建议改"条目直接改原文，"保留（文体）"照旧保留，review-humanizer.md 作为处置留档（用户可事后查阅）；**改动不得引入新事实**（事实纪律继续有效），改完对账重扫**只碰 hash 变化的章**（缓存命中的章直接复用结果）；全部章 clean/has_hits 处置完毕后重新跑引用↔文件对账。
若已入草稿箱，改完后重新 publish 更新草稿。

## 教学类文章变体（软件教学，2026-10-29 新增）

拆解/介绍某款软件的文章（如 ThinkRail IDE 篇），配图以**用户自截软件截图**为主，agent 不代截；流程在标准流程上叠加：

1. 初稿完成后、截图到位前，先生成**截图分析 md**（放文章根目录，如《截图插入分析.md》）：两条来源线（软件内实拍 / GitHub 等网页截图）+ 总览表（章/文件名/内容/来源/优先级）+ 分镜详解（插入锚点引正文原句、拍什么、画面要求、隐查提醒）
2. 用户自截后图丢入 imgs/（命名建议 NN-主题.png，不合规也可，agent 识别后反推）
3. **正文二次调整**：根据截图分析文档对齐正文与图——补充"如图"类引用、删去与截图重复的描述、调整段落让图落在语义节点上
4. agent 用视觉工具逐张识别（内容/文字/可辘认知度/隐私）→ 产出"图 × 候选锚点 × 理由"插入意见表落盘留档并**直接插入**（2026-11-12 两确认点制，用户拍板门取消）；用户在确认点 2（预览工作台）过目调整
5. **GIF 动图配置规范（2026-11-02 定案）**：livepanel 主题默认 light-pastel；**不做轮播场景模块**——无 cycle 机器、无盒子 when/then 轮播高亮、无底部日志条；**不带 credit 引擎署名行**（原创 config 无需署名，直接不写 credit 元素）；动画只保留 path flow 流动包与结构本身（贴“清晰表示流程/结构/架构”的诉求）；时长 6-10s、宽 ≤800px、体积 <10MB；改 diagram_source/filename 不触发 prompt_hash 变化，需微调 prompt 或删 manifest 条目强制 stale 后重渲
6. **手机竖屏可读性验证（2026-11-02 定案，发布前必过）**：全部配图就位后，逐张把图缩放到 **390px 宽**（模拟手机正文宽度）再交给视觉工具检查——节点名/关键文字有效字号 ≥10px、无不可读的长条横版图；不达标（如横版架构图）重排竖版或放大字号后重验。背景：DeepSeek 篇横版架构图实测 1600 宽在手机上字号只剩 4-6px 不可读，事后才发现已入箱
7. 对账 → F3 humanizer → 入箱，照旧

首例：ThinkRail IDE 篇（《截图插入分析.md》，8 张截图 + 1 张生成中心图）。

## G. 准备文章入草稿箱

按 article-prepare 手动插图链路(参考 `dev-docs/experience/wechat-cover-235-ratio-and-filename-traps.md`):

1. `normalize_manual_images.py --article-dir <dir>`(wiki 内嵌→标准引用 + 补 article.yaml;已标准引用则 [SKIP] 但仍补 yaml)
2. **检查 article.yaml 的 digest**:封面图占第 1 行后,自动 digest 会抓成第一个章题(如"一、xxx")——手工改成一句话导语再继续
3. `check_state.py --article-dir <dir>`(prepare_ready=true 才继续;看 cover/exact_235/序号提示)
4. **G.5 预览工作台 = 确认点 2(2026-11-03 新增,必过,方案见 `dev-docs/planning/2026-11-03-GZH排版工作台执行方案.md`;2026-11-12 定名确认点 2)**:check_state 通过后、publish 之前,打开本地预览工作台,用户在预览内编辑/浏览/保存:
   1. **打开工作台**:若 Server 未起,先跑 `pi-workflow web`(或 `node dist/cli/index.js web`)。**优先用 chrome-use 免粘贴打开器(2026-11-04 定案)**:`python3 dev-examples/gzh-preview/open_preview.py --dir <文章目录绝对路径>`——自动读 pi-workflow.config.json 固定 token、注入 localStorage、在用户 Chrome 里直接打开已登录页面,用户只需看;chrome-use 不可用/relay 未连时才回落旧方式(把横幅 URL + token 给用户,让用户打开 `<URL>/gzh-preview` 粘贴 token)。vault root 自动从 `.aws-article/config.json` 解析,也可用 `GZH_PREVIEW_VAULT_ROOT` 指定
   2. **用户操作**:左侧改正文、切主题、看图(含 GIF);页面上的"保存"直接写回文章目录(md 原子替换,切主题只写 article.yaml 的 style 字段不动正文)
   3. **确认点 2（预览内编辑+聊天确认，与确认点 1 同为全流程仅有的两个用户门）**:用户在预览工作台内编辑正文、切主题、看图(含 GIF)、点"保存"写回文章目录(md 原子替换,切主题只写 article.yaml 的 style 字段不动正文);对图/文不满意可当场在聊天提出,agent 修订后重新进本确认点。改完在聊天里回复确认后才能继续;若用户改了正文,保存后**必须重跑 check_state**(digest/图片引用可能变化),通过才进第 5 步。**确认即停台(2026-11-12 定案,Minimax H3-Image 篇纠偏)**:用户回复确认发布的同时,agent 自己起的预览 web 服务(`pi-workflow web`,默认端口 4317)就地停掉——起服务时记下 PID(或 netstat 查端口监听进程)后 kill,不留到事后收尾再停;不是 agent 起的服务(用户自己常驻的)不动
   4. **原则**:切模板不改正文;预览页无发布权限,发布仍走第 5 步 publish。**入箱分支(2026-11-04 补定案,立体书篇踩坑):用户在工作台切过主题并确认发布的,必须走 layout-html 入箱**——先确保工作台已点「导出渲染 HTML」生成文章目录 layout.html(或 POST /api/gzh/article/export),检查 layout.html 比正文新、图片引用齐全,然后 publish 加 `--html-file layout.html`(图片引用保持 imgs/ 相对路径,上传时统一替换微信 URL);只有用户未选主题时才走默认固定转换。**发布前还要确认草稿未在后台设置定时发布**(定时中的草稿被微信锁定,draft_update 报 errcode 53407,需先在后台取消定时才能更新)
   5. 主题推荐初表(实际键名见 huasheng_editor styles.js,18 个):AI 术语科普→`wechat-anthropic`;技术教程→`wechat-tech`;GitHub 项目推荐→`warm-docs`;企业 AI 案例→`warm-dossier`;行业趋势分析→`wechat-ft`;深度观点→`wechat-apple`;杂志风→`warm-dossier`;极简→`wechat-apple`。仅推荐,最终用户拍板
5. `publish.py --article-dir <dir> --cover imgs/cover-*.png --account-slot 1 --md-file <md> --title <t> --digest <d> --author AI奇点`(封面非精确 2.35:1 会自动缩放并备份 `_cover-original/`;[COVER] 行看动作)。**标题/摘要不得带包裹引号**(2026-10-29 定案):昨天发生过 article.yaml 里 `title: "xxx"` 连引号进微信草稿标题的事故;publish.py 已加 `_unquote` 防护(去掉一层成对引号),但传参时仍直接裸串,不要手滑把引号写进值里
6. 成功标志:`[5] DRAFT OK media_id=...` + `=== ALL DONE draft_media_id=... ===`

## 交付前自检清单

- [ ] 本篇用户拍板与纠偏中的可复用偏好已登记 preference.md（本篇特例除外）

- [ ] **确认点 1 已过**：大纲包（定位结论+标题候选+大纲）已经用户修改并确认
- [ ] **确认点 2 已过**：用户在 /gzh-preview 预览内编辑/浏览/保存并聊天确认；改过正文的保存后已重跑 check_state；确认后预览 web 服务已停

- [ ] **标题与章题均为 GEO 疑问句**:主标题疑问词开头+关键词前置+答案暗示;各章题=搜索问法,无判断句/名词短语章题,无框架序号词开头(第一层/第二步/阶段一)
- [ ] 正文引用数 = imgs 文件数（无悬空/无未引用），文件名无空格括号
- [ ] 第一章有中心图（01- 前缀生成图，画面表达全文核心论点）
- [ ] 发表前过 humanizer 去 AI 味：review-humanizer.md 已生成留档，"建议改"已由 agent 自批应用，改动未引入新事实
- [ ] **手机竖屏可读性验证已过**：全部配图逐张缩放 390px 宽用视觉工具检查，关键文字可读（横版长条图必须重排）
- [ ] 每张生成图都有关键词文字设计 + expected_text
- [ ] 封面 prompt 是 2.35:1 且主标题关键词入画
- [ ] 踩坑清单（references/pitfalls.md）逐条过一遍再发布
- [ ] 发布前核对 article.yaml digest 是一句话导语而非章题；发布后确认 [5] DRAFT OK + publish-state.json status=drafted
