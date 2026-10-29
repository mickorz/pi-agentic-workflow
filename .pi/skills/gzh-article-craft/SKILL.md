---
name: gzh-article-craft
display_name: 公众号文章创作全流程
description: 从引用材料/产品热点写公众号文章的完整流程：定位讨论→标题10候选→大纲→逐章写作(实时落盘+逐章确认)→引用截图下载入文→配图提示词(关键图带关键词文字+expected_text)→export-review审批→两阶段生图→准备文章入草稿箱。Use when 用户要基于引用文章、产品发布或热点"写一篇公众号文章"、讨论大纲、生成配图提示词，或走文章准备流程。
description_zh: 从引用材料到成文、配图提示词、入草稿箱的公众号文章生产全流程，含踩坑规避清单。
---

# 公众号文章创作全流程（gzh-article-craft）

本 skill 沉淀自 2026-10-28《Personal Agent 元年：蚂蚁灵光 2.0》全流程实战（引用消化→成文→16 张截图→4 张生成图提示词→审批文档）。

**先读 `references/pitfalls.md`**——踩坑清单是本流程的地基，写作/生图/发布各阶段的"必须避免"都登记在那。

## 流程总览

| 阶段 | 动作 | 产物与落盘点 |
|---|---|---|
| A 定位 | 三问 + 标题 10 候选 + 大纲 | 定位结论（chat 内确认），大纲随第一章落盘 |
| B 写作 | 逐章写，**每章完立即 `cat >>` 追加到正文 md**，用户确认再写下一章 | `文章目录/<标题>.md` |
| C 截图 | 引用材料中的图下载入 `imgs/` 并插正文 | `imgs/NN-分类-主题.jpg` + 正文引用 |
| D 提示词 | 构造 `image-prompts.json`（关键图带文字+expected_text） | `image-prompts.json` |
| E 审批 | `export-review.mjs` 渲染，用户过目提示词成稿 | `image-prompts-review.md` |
| F 生图 | preview 封面→用户确认→batch 正文（article-image-generate workflow） | `imgs/cover-*.png`、`imgs/NN-*.png` |
| F2 入文 | 生成图按锚点插入正文（edit 精确替换，不重排全文） | 正文引用 + `imgs/` |
| F3 去AI味 | humanizer 全文扫描 → 生成审批文档 → 用户批准 → 改原文 → 重新对账 | `review-humanizer.md` + 修订后正文 |
| G 入箱 | 准备文章流程（normalize→check_state→publish） | 草稿箱 + `publish-state.json` |

文章目录约定：`60_Workspace/写作/单篇/<YYYYMMDD>/<主题>/`（坚果云），正文 md 与 `引用/`、`imgs/` 同级。

## A. 定位讨论（开写前必做）

先读 `引用/` 下全部材料，给用户三样东西讨论：

1. **材料干货提炼表**（每篇引用一个核心增量，含评论区金句和反方声音）
2. **差异化定位**：A 趋势判断型 vs B 实操体验型；推广向 vs 中立向；冷思考轻重（轻提=一小段实话；重写=专章）。让用户拍板，不要自作主张
3. **标题 10 连不同类型**：事件型/数字型/悬念型/利益型/对比型/身份代入型/痛点型/惊叹型/攻略型/趋势型，各一个
4. **大纲 v1**：钩子→是什么→实测/论证→方法→(轻)冷思考→行动收尾。用户确认后再动笔

常见用户偏好（历史决策）：实操推广向、亮点前置到开头钩子（如"免费"）、竞品做铺垫不做对手（Manus=国人能力证明，本产品=落地国内生态）、结尾留下篇预告钩子。

## B. 写作规范

- **逐章制**：一章一交付，写完立即落盘（防丢失），用户回复"ok/确认/继续"才写下一章；用户中途改需求就地编辑已写章节
- 文风参考基线：短段落（单段 1-3 句）、每章 400-700 字、全文 6-8 章 3000-5000 字、章题用问句或判断句
- **事实纪律**：只使用引用材料中的事实；为承载配图加的过渡句也必须源自引用事实，不虚构功能/数据
- **禁用网友 @handle 表达**（2026-10-29 定案）：正文不得出现 @某某 网名句柄（含不带 @ 的英文 handle，如 LinearUncle），统一改写为身份描述（"一位工程师""评论区有人""还有人""面试官""作者"等）；引用的事实与金句保留，只去掉句柄。首搜提到时用"一位/某个+身份"建立指代，后文用"那位/他/前面那份方案"回指
- 修改类需求（如"免费要放开头"）：直接改已存盘章节并在回复中 diff 说明，避免重复内容

## C. 引用截图下载

```bash
curl -s --max-time 25 -x http://127.0.0.1:7897 "<图URL>?format=jpg&name=large" -o "imgs/NN-分类-主题.jpg"
```

- **命名**：`NN-分类-主题.jpg/png`，NN=章序号；**禁空格/括号/全角括号**（IMG_REF 正则 `[^)]+` 会在首个 `)` 截断，见 pitfalls #1）
- 下载后必查：`file -b` 非 empty、大小 >10KB；404（X 端原图下架）→ 用同段落替代图并同步改配文，或弃用
- 全部入文后跑一遍"引用↔文件一一对应"检查（引用数=文件数、无悬空、无未引用、无违规文件名）

## D. image-prompts.json（配图提示词）

schema（`version / article_id / style_prefix / items[]`），每 item：`id, kind(cover|body), heading(对应##章节，封面留空), diagram_type(生图类型标注，如：3D信息图/流程图/状态机/架构图/时间线，审批文档与 json 均显式标注), prompt, expected_text?, filename`。

**技术讲解类文章先读 diagram-design（2026-10-29 定案）**：技术架构/原理/流程类文章，正文图核心是技术架构图、流程图、状态机、时间线，先读 `.pi/skills/diagram-design`（扁平编辑风、节点 ≤9、直角圆弯连线、无阴影无辉光、强调色只给 1-2 个焦点元素），按其设计语言写 body 图提示词；封面保留账号 3D 风格，body 图 prompt 开头显式声明“扁平编辑风格技术示意图（不出现 3D 人物与办公场景）”覆盖风格头；事件名/标识符用等宽字体小字，中标题大字号。

**第一章必须有中心图（2026-10-29 定案）**：第一章是全文定调章，必须生成一张能表达全文核心论点的生成图（`01-` 前缀，diagram_type 如实标注），不是装饰图：先问“这篇文章的中心思想用一句话是什么”，把那句话翻译成画面；封面表达钩子，01 图表达中心，两者分工不同不重复。跳过 01 图视为流程违规。

**铁律（文字缺失复现教训，见 pitfalls #4）**：
1. style_prefix **不得**带"画面中不出现任何文字"条款；写"文字只允许出现在指定标题位置"
2. **每张图写 prompt 前先问：这张图的关键词是什么？** 封面=主标题关键词；章节主图=一个短词/短语（visual-rules 纪律：字号大、笔画清晰、不排长句）
3. 声明了画面文字的图**必须**同步声明 `expected_text: ["关键词1","关键词2"]`（T4 验收契约：生成后 content_review pending → 用户核对 → approve/reject，漏字不会静默放行）
4. 尺寸：封面 prompt 写"宽高比 2.35:1 横版、关键视觉居中安全区"；正文写"16:9 横版"
5. filename：封面 `cover-中文主题.png`；正文 `NN-中文标题.png`（NN=第 N 个 ## 章节，与既有截图序号衔接）
6. 风格头沿用账号统一风格（Business AI 3D Infographic，色板 #142B49/#1776E8/#16B6AF/#FF9B35/#F5F8FC），保持系列一致性

## E. 审批文档

```bash
node dev-examples/wx-article/scripts/image_gen/export-review.mjs --article-dir <文章目录>
```

渲染 `review-image-prompts.md`（2026-10-28 修复命名：review- 前缀命中正文定位排除规则，旧名 image-prompts-review.md 会把 md 候选搞成不唯一）：风格头全文 + 逐张完整成稿（style_prefix+分隔符+prompt）+ expected_text + 状态 + 调整指引。给用户过目；要改就改 `image-prompts.json` 源头再重渲染（本文档只读）。

## F. 两阶段生图

```bash
# ① preview 封面（非交互模式：风格确认检查点进入等待态，不阻塞进程死亡）
pi-workflow run dev-examples/wx-article/scripts/article_image_generate.js --non-interactive \
  --args '{"article_dir":"<绝对路径>","mode":"preview","preview_id":"cover","provider":"image-use","skip_confirm":true,"retry_failed":true}'
# ② 用户看过预览图+核对文字后，带 style_approved 重跑完成风格锁定，再 batch
#    --args '{"...","mode":"batch","provider":"image-use","skip_confirm":true,"style_approved":true}'
```

- `provider: image-use`（默认 pi-image-gen 是智谱 API，需要 IMAGE_GEN_API_KEY，一般没配）
- **`retry_failed: true` 必带**（manifest 里有 failed 条目时不重试会"空跑"，风格确认门拿到空数据，见 pitfalls #6）
- E_ENV（chrome-use 驱动不了 Chrome）处置见 pitfalls #5：**不要杀 Chrome**——让用户正常开 Chrome（relay 扩展随浏览器上线），冷启动/杀进程后的 profile 拉不起 chatgpt.com
- 生成成功后：封面走文字核对（expected_text → content_review pending → `--approve-text`），正文图同理
- **图片核对一律用视觉分析工具（2026-10-29 定案）**：主模型可能不支持直接读图，生成后/挑图时核对 expected_text 拼写、画面元素、乱码畸形，统一用 `zai_mcp_server_analyze_image`（或同类视觉分析工具）逐项检查，全部通过后才 `--approve-text`；不许凭“生成成功”默认放行。引用截图下载后如需确认内容未下错，同样用该工具

## F2. 生成图入文（手动生成/批量生成后）

图片到位后按锚点插入正文（edit 精确替换，不重排全文）：

- **封面**：正文第 1 行插 `![文章封面](imgs/cover-主题.png)`（手动插图流程约定，正文定位/封面识别都认）
- **正文图**：按 prompts 的 heading 找该章金句/总结句之后插入 `![一句话描述](imgs/NN-主题.png)`；alt 写画面含义不写文件名
- 插入前注意：用户可能已在 Obsidian 改过章题/正文——**edit 的 oldText 必须先 grep 当前文件核实**，不要拿记忆里的旧句当锚点

## F3. 发表前 humanizer 去 AI 味（2026-10-29 新增，必过）

上传发表前，用 humanizer skill（`.pi/skills/humanizer/`）全文过一遍，**先审批后改动**：

1. 读 humanizer SKILL.md 全部模式（§1-§26），逐章扫描正文
2. 生成审批文档 `review-humanizer.md`（review- 前缀命中正文定位排除规则）：每条含【位置（章）】【原句摘录】【命中模式（§编号）】【建议改法】【处置建议】；**只出文档不动原文**
3. **文体豁免原则**：公众号文体的短段落、金句收尾、排比节奏是刻意修辞，命中模式但属文体选择的标注"保留（文体）"并说明理由；只把真正的 AI 腔列为"建议改"。源自引用材料的原句（如受访者金句）一律保留
4. 用户批准后按文档改原文；**改动不得引入新事实**（事实纪律继续有效），改完重新跑引用↔文件对账
5. 若已入草稿箱，改完后重新 publish 更新草稿

## G. 准备文章入草稿箱

按 article-prepare 手动插图链路（参考 `dev-docs/experience/wechat-cover-235-ratio-and-filename-traps.md`）：

1. `normalize_manual_images.py --article-dir <dir>`（wiki 内嵌→标准引用 + 补 article.yaml；已标准引用则 [SKIP] 但仍补 yaml）
2. **检查 article.yaml 的 digest**：封面图占第 1 行后，自动 digest 会抓成第一个章题（如"一、xxx"）——手工改成一句话导语再继续
3. `check_state.py --article-dir <dir>`（prepare_ready=true 才继续；看 cover/exact_235/序号提示）
4. `publish.py --article-dir <dir> --cover imgs/cover-*.png --account-slot 1 --md-file <md> --title <t> --digest <d> --author AI奇点`（封面非精确 2.35:1 会自动缩放并备份 `_cover-original/`；[COVER] 行看动作）。**标题/摘要不得带包裹引号**（2026-10-29 定案）：昨天发生过 article.yaml 里 `title: "xxx"` 连引号进微信草稿标题的事故；publish.py 已加 `_unquote` 防护（去掉一层成对引号），但传参时仍直接裸串，不要手滑把引号写进值里
5. 成功标志：`[5] DRAFT OK media_id=...` + `=== ALL DONE draft_media_id=... ===`

## 交付前自检清单

- [ ] 正文引用数 = imgs 文件数（无悬空/无未引用），文件名无空格括号
- [ ] 第一章有中心图（01- 前缀生成图，画面表达全文核心论点）
- [ ] 发表前过 humanizer 去 AI 味：review-humanizer.md 已生成并经用户审批，批准的修改已落原文
- [ ] 每张生成图都有关键词文字设计 + expected_text
- [ ] 封面 prompt 是 2.35:1 且主标题关键词入画
- [ ] 踩坑清单（references/pitfalls.md）逐条过一遍再发布
- [ ] 发布前核对 article.yaml digest 是一句话导语而非章题；发布后确认 [5] DRAFT OK + publish-state.json status=drafted
