# AP-S1 执行报告：小绿书卡片化（真实素材首跑 + newspic 真机入箱）

- **阶段**：AP-S1（T0~T6 详见 `dev-docs/planning/2026-11-05-小绿书卡片化接入执行方案.md` 及 progress 台账；本报告聚焦 2026-11-10 T7 真机 Gate C 的 A2+B 环节）
- **触发**：用户以 mcode-stack README（MiniMax-AI/mcode-stack 中文版，Obsidian 剪藏）为素材，要求走小绿书模式

## 真实素材全链（A2）

- 素材：`E:\Obsidian\newsky\60_Workspace\写作\单篇\20261110\mcode-stack\mcode-stack-README_ZH.md` + 仓库三张图（hero-zh / skills-map-zh / how-it-works-zh，2560px 宽，代理下载）
- 链路：`pi-workflow run wechat_sticker_cards.js`（规划 agent 产 pages.json，7 页 editorial/ink-classic，全 html 版式 + 2 截图页，零 ai-image 零生图费用）→ 规划审批（checkpoint 等待态 → 聊天确认 → resume 管道喂 y，见 `dev-docs/experience/pi-workflow-non-tty-checkpoint-pipe.md` 标准姿势）→ 截图预处理 → HTML 构建 → render.mjs 渲染 1080×1440 → normalize → verify
- 状态机断点续跑实战：首跑 run-mwahnv9f-bcek 在 validate_pages 环节瞬超时失败（RUNNER 子进程探测疑似 WindowsApps python3 占位符首触挂起，复现不成立，详见 `dev-docs/experience/sticker-runner-probe-transient-timeout.md`）；`resume` 回放规划 agent（免重跑 LLM）后全链走通

## 审图与修订（过程要点）

1. 工作流内置审图 agent 判 5/7 页 REVISION_REQUIRED（多为"疑似缺字/截断"）
2. 主 agent 用 zai 视觉逐张亲核推翻大部分误判：四处均无真实截断，实际问题为
   - 注入器封面 title 走 `esc()` 不转 `<br>`，pages.json 里的 `\n` 三行设计被 HTML 吞掉 → "Claude Code" 品牌名被自然折行拆开（真 bug）
   - 大字行折行产生孤字尾行（"合集"/"地"/"惯。"）——文案长度超出 h-display 124px 版式容量
3. 修复：`components.py` 三处 `esc()`→`esc_multiline()`（封面 title / 截图页 h1 / 清单页 h1，对无换行输入输出逐字节不变，五套件 109 断言回归全绿）；pages.json 三处文案改为手工断行短句
4. 重渲 4 页（render.mjs `--only` 逐页，多次 `--only` 只有最后一个生效）→ normalize 重绑 pages sha → 7 页全部 APPROVED（mark_review 结构化记录，审图人 agent-zai）→ `verify_cards --require-approved` 20/20 全绿

## 发布（B，真实账号首次 newspic 入箱）

- 两阶段授权：`publish_sticker_cards.py --prepare` 取指纹 `a75ca144...6877c`（绑定 pages/manifest/7 图/标题/配文/账号槽位）→ 聊天发布授权 → `--execute --approval` 同指纹
- 标题：`MiniMax 团队自用 Claude Code 工作流全开源了`（32 字）；配文 607 字（安装命令/19 Skill 六场景/工程笔记/话题标签）
- 输出契约：`[2] IMG i/7 OK` ×7 → `[5] DRAFT OK media_id=RzpZN4Rc6PTdKELZiQHK7bvyjqarrayopU1TXTj87b4JkMEEBHawM70H5kAJ0gyK` → `=== ALL DONE draft_media_id=... ===`
- **意义**：AP-S0 设计文档遗留的"真实账号 newspic 入箱未实测"至此补上真机证据（Gate C 的 B 环节）；publish-state 记 kind=sticker，与文章线 kind 隔离生效

## 遗留

- Gate C 的 C 环节：公众号后台手动发表后的实际显示效果待用户确认（newspic 无 freepublish，发表靠后台手发）
- 审图 agent 对"截断"类判断的误读率高（5 判 4 误），改进方向登记：审图 prompt 要求"疑似截断必须二次开图确认，OCR 假阴性不得单独作为 REVISION 依据"
- render.mjs 字体内嵌路径在弱网下载 Noto Serif SC 超 300s（本次用 `--no-embed` 旁路成功）；可考虑字体本地缓存
