---
name: xiaolvshu
display_name: 小绿书创作全流程
description: 素材(README/笔记/截图/文章)到成套 3:4 小绿书卡片(封面+内容页)的完整流程：页面规划(pages.json 容量纪律)->规划审批->版式渲染与截图证据页->审图(误读亲核)->两阶段发布授权->newspic 入草稿箱(后台手发)。Use when 用户要把素材"做成小绿书/做成卡片/卡片化/发布贴图/发布图片帖"。
description_zh: 素材到成套卡片、审图、newspic 入草稿箱的小绿书生产全流程，含页面容量纪律与踩坑规避清单。
---

# 小绿书创作全流程（xiaolvshu）

小绿书 = 微信"图片帖"（newspic）：一组 3:4 竖版卡片（1080x1440，封面+内容页）+ 标题 + 配文，入公众号草稿箱后**后台手动发表**。与公众号文章线（gzh-article-craft）是两条独立流程：用户要写长文走那边，要把素材做成图片卡片组走本 skill。

**先读两份**：① `references/pitfalls.md`——踩坑清单是地基，规划/制作/审图/发布的"必须避免"都在那；② 仓库根 `preference.md`——用户偏好登记册，流程中每次可复用的拍板（钩子风格、断行偏好、发布时机）当场登记并 commit。

分层职责：本 skill 管**规范、审批与救火**；确定性编排走 `sticker-cards` workflow；具体生产与发布由 `dev-examples/wx-article/scripts/sticker_cards/` 脚本族执行。本 skill 不重复脚本实现。

## 流程总览

| 阶段 | 动作 | 产物 / 落盘点 |
|---|---|---|
| A 页面规划 | 素材三问 -> 写 pages.json -> 规划审批门 | `<文章目录>/_cards/pages.json` |
| B 制作 | 截图预处理 -> (可选 AI 生图付费门) -> HTML 构建 -> 渲染 -> normalize -> verify | `_cards/output/01..NN.png` |
| C 审图 | 逐页读图核验 -> mark_review 结构化判定 | `_cards/cards-manifest.json` 审核状态 |
| D 发布授权 | prepare 取指纹 -> 人工批准 -> execute 同指纹 | `publish-state.json` kind=sticker, DRAFTED |
| E 发表 | 公众号后台手动发表（无自动发表通道） | — |

文章目录约定：`60_Workspace/写作/单篇/<YYYYMMDD>/<主题>/`，卡片工作目录 `_cards/` 在其下，与文章线 imgs/ 天然隔离（publish-state 记 kind=sticker，混型发布显式拒绝）。

## A. 页面规划（唯一内容产出点）

先回答素材三问，再动 pages.json：

1. 这组卡片**一句话讲什么**（中心论点，决定封面钩子与 quote 收尾）
2. 给谁看（他们的搜索词/关键词决定标题与封面文字）
3. 钩子是什么（封面第一眼：数字/反差/利益点）

pages.json（schema v2）硬约束，`validate_pages.py` 会拦：

- 页数 1~9；页 1 必须 role=cover；no 唯一递增；source 仅 html|ai-image
- html 页 layout 必填枚举：cover-hook / text-card / screenshot-with-caption / checklist / quote
- screenshot 页 asset 以 `_cards/assets/` 开头且文件真实存在（先把素材图复制进去）
- **title <=20 字**（微信后台实测上限，draft/add 接口不拦但后台拦）；content 配文 <=1000 字
- pages.json.title 就是发布标题（兜底链第一顺位），与最终 --title 保持一致——两者都进发布 hash，不一致会导致下次重跑 hash 漂移、触发无谓的 draft_update

**容量纪律（规划阶段就要过，不是渲染后才发现）**：

| 字段 | 版式 | 单行容量 | 纪律 |
|---|---|---|---|
| copy.title（text-card 大字 / 截图页·清单页标题） | h-display 124px | **约 7 个汉字** | 超了手工断行（写 \n）或缩句；每行断在语义边界（词组/标点后） |
| emphasis（quote 金句） | 64px | **约 13 字** | 长金句手工断行成 3~4 行等长行，末行 >=4 字防孤字 |
| 封面 gz-cover__title | --chars 自适应 | 按最长行缩放 | 支持 \n 三行设计；**品牌名不拆行**（Claude Code 必须同行） |
| 底部 meta 小字 | 每栏窄 | 自然折行可接受 | 不算缺陷，但别放关键信息 |

孤字尾行（末行只有 1~2 字）不是错误但是硬伤——规划时就按容量断好行，省一轮重渲。

截图页素材规则：UI/代码截图强制 image_fit=contain（禁 cover 裁切）；宽 <720px 的图文字可能不可读，换高清图或放大局部；**过扁横幅（宽高比 >2:1）不做截图页**——contain 后只剩一条细带。

规划审批门：页表+主题（editorial 六色板/swiss 四色板）+截图预处理报告+生图费用提示，人工批准后才进生产。

## B. 制作

**路径一（首选）：workflow 一键。**

```bash
pi-workflow run dev-examples/wx-article/scripts/wechat_sticker_cards.js \
  --args '{"article_dir":"<文章目录绝对路径>","shots_dir":"<截图目录>","count":7,"style_mode":"editorial","publish_method":"draft"}'
```

args 契约：article_dir 必需；shots_dir 截图目录（规划 agent 会复制进 _cards/assets）；count 页数上限（缺 6，硬上限 9）；title/content 可显式传（覆盖 pages.json）；publish_method draft(缺省)|none；account_slot 缺 1；skip_confirm 只跳规划门——**AI 生图付费授权与发布授权两个 checkpoint 永不可 skip**。

checkpoint 语义：带 `--non-interactive` 时人工门进入等待态（退出码 3），批准后 `printf 'y\n' | pi-workflow resume <runId> --yes` 续跑（只余 checkpoint 一个 readline，喂一个 y；详见 pitfalls #6）。

**路径二（部分重做/断点）：手动驱动脚本族。** 全部在仓库根执行：

```bash
SC=dev-examples/wx-article/scripts/sticker_cards
C=<文章目录>/_cards
python $SC/validate_pages.py  --pages $C/pages.json --cards-root <文章目录>     # schema 门
python $SC/build_html.py      --pages $C/pages.json --out $C/index.html --cards-root <文章目录>
node thirdparties/guizang-social-card-skill/scripts/render.mjs $C/index.html --out $C/render            # 字体内嵌；弱网/超时直接加 --no-embed
node .../render.mjs $C/index.html --only xhs-03 --no-embed --out $C/render      # 单页重渲（多次 --only 只有最后一个生效，多页就逐条跑）
python $SC/normalize_cards.py --pages $C/pages.json --cards-dir $C              # 注意 --cards-dir 传 _cards 目录
python $SC/verify_cards.py    --pages $C/pages.json --cards-dir $C [--require-approved]
```

铁律：**pages.json 任何变更后必须重跑 normalize**（manifest 与 pages sha 绑定，不重绑 verify/发布门直接拒）；normalize 对未变化的页幂等并**继承已有审核**，只重置产物真变了的页。改一页文案 -> render --only 该页 -> normalize -> 该页重新 mark_review。

AI 生图页（可选）：付费授权 checkpoint 独立于 skip_confirm；走 image-use 通道（chrome-use 驱动已登录浏览器，零 API key）；拒绝=终止，提示词已存档可稍后重跑。纯文字+截图页的组合零费用，素材类内容优先这条路。

**图形页（流程图/架构图/结构化清单，2026-11-11 新增）**：内容含流程/架构/分组关系、纯文字卡表达不了时，用 diagram-design 规范手绘 SVG（参考 `.pi/skills/xiaolvshu/assets/diagram-templates/` 两个模板：workflow-map 架构图 / install-flow 流程图，参数化点见文件头注释）。硬纪律：
- **SVG viewBox 正方形 800×800 = well_ratio 1x1 比例**——图比例=框比例，免疫 contain/cover/fill 一切裁切与变形坑（pitfalls #19）
- 文字 ≥16px（viewBox 基准，落卡后 ≈14px）；命令/路径一律 Geist Mono；accent 单色 ≤2 处
- 产出链：chrome emulate 1200×1200 打开 HTML → 截图 → 裁出 svg 区域（body flex 居中：x=(宽-800)/2, y=(高-800)/2，尺寸 800×800）→ 存 `_cards/assets/<名称>.png` → pages.json 用 screenshot-with-caption + well_ratio 1x1 + crop manual contain
- 渲染前跑 `python3 .pi/skills/xiaolvshu/scripts/preflight_fonts.py` 预置字体内嵌缓存（首次必跑，否则字体内嵌下载超时，见 pitfalls #20）

## C. 审图

逐页用视觉工具（zai_mcp_server_analyze_image）读 `_cards/output/NN.png`，分类型核验：

- screenshot 页：文字清晰、裁切正确（无地址栏/无关区域）、关键信息完整；缩略不可辨的地图/大图，确认其定位是"概览页"（图注承载要点）才算过
- ai-image 页：构图合理、与全组风格一致、事实准确、图中无错误文字
- layout-text 页：**逐字转录大字区**，无溢出无重叠、断行符合规划、无孤字尾行、正文完整收尾

**铁律：审图 agent（或任何读图环节）报"疑似缺字/截断"必须亲自开图逐字核验后才可采信**——OCR 假阴性率极高（首发 5 判 4 误，"合集/地/惯。"全部实际完好）。核验通过即推翻该意见；真截断才改文案重渲。

判定落盘：`mark_review.py --manifest $C/cards-manifest.json --no <N> --status APPROVED --reviewer <名> --notes "<意见+核验方式>"`。notes 写清核验方式（如"zai 逐字转录核验"）。`verify_cards.py --require-approved` 是发布硬门：审核缺失/过期（产物 sha 变了）/非 APPROVED 任一即拒。

## D. 发布（两阶段授权，副作用不可自动通过）

```bash
# 1. 纯本地 prepare：verify + 资格 + 指纹（不碰微信接口）
python $SC/publish_sticker_cards.py --pages $C/pages.json --cards-dir $C \
  --account-slot 1 --title "<=20字" --content "<配文>" --prepare
# 2. 人工看过实际 PNG/标题/配文/账号槽位后，以同一指纹执行
python $SC/publish_sticker_cards.py ... --execute --approval <64位指纹>
```

- 指纹绑定 pages/manifest/图片字节/标题/配文/账号槽位，**任一变化授权作废**（重新 prepare 取新指纹）
- 兜底链：title 取 args.title > pages.json.title；content 取 args.content > pages.json.content
- 执行语义：同 hash 且已入箱 -> draft/get 核对后直接复用不重发；hash 变（改标题/配文/换图）-> **draft_update 原地更新**（media_id 不变，已真机验证）；旧草稿已删/已发表（40007）-> 自动重置状态，重跑即新建；网络不确定 -> UNKNOWN pending 保护，人工核对后 `--resolve-media-id <id>` 或 `--clear-pending` 恢复，**禁止盲目自动重试**
- 成功字面量：`[5] DRAFT OK media_id=...` + `=== ALL DONE draft_media_id=... ===`
- 发布后：到公众号后台**手动发表**（newspic 无 freepublish，通道显式拒绝自动发表）；后台若给草稿设了定时发布会被锁（errcode 53407），先取消定时才能再 update

## 断点续跑与救火

- workflow 卡在人工门：`pi-workflow status <runId>` 看等待的 checkpoint 内容，批准后按 B 节 resume 姿势续跑；journal 回放已完成节点（不重跑 LLM、不重复副作用）
- command 节点"无输出超时"（如 validate_pages 180s 超时）：**先手动复跑同一命令**，秒过即瞬超时，直接 resume——不要加长超时、不要重起整个 run
- 审图没全过：改 pages.json / 重渲对应页 -> normalize -> 重新 mark_review -> verify --require-approved
- 渲染环境报 RENDER_BLOCKED：`thirdparties/guizang-social-card-skill` 没 npm install 或缺 chromium（`npx playwright install`），环境就绪后 resume，已产出的 pages.json/index.html 不动
- 输出用 `--json` 时终端 GBK 代码页可能混入中文导致解析失败：先 `pi-workflow status <runId>` 确认实际状态，别只信 stdout

## 首发实战索引

mcode-stack 案例（2026-11-10，7 卡全链）：标题 32->20 返工、审图误读推翻、瞬超时 resume 续跑、draft_update 真机验证——过程与证据见 `dev-docs/progress-result/AP-S1-执行报告.md`；规划/渲染/发布契约的设计细节见 `dev-docs/planning/2026-11-05-小绿书卡片化接入执行方案.md`。
