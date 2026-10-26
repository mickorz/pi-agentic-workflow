# WX-P4 执行报告：手动插图（Obsidian wiki 内嵌）识别与链接规范化

- 日期：2026-10-26
- 触发：用户 m00458——「准备文章」流程需支持手动插图类型：任何操作前先检查正文是否已手动插图（范例：60_Workspace/写作/单篇/用Manus改造Manus，AI Native组织的团队分享）；手动插图的不走自动插图流程，只把图片链接改成公众号方式；并分析对发布草稿箱流程的影响。
- 结果：**已完成**。check_state / 新脚本 normalize_manual_images.py / article_prepare.js 三处交付，P1 门禁 30/30，范例文真机验证通过（prepare_ready=true）。

## 可行性分析结论（实施前）

- 范例文用 Obsidian wiki 内嵌 `![[01-xxx.png]]`（6 处：5 正文图 + 1 封面，部分带 `|300` 尺寸后缀）。
- 流水线三处只认标准 markdown 引用 `![](...)`：check_state.py IMG_REF（needs_insert 误判 true → 会重复插图）、content_hash.image_refs（不上传不替换）、publish_html.convert_md（wiki 内嵌当纯文本发出去）。
- 手动插图且已是**标准格式**的文章现有逻辑天然覆盖（referenced≥files → needs_insert=false 直接发布）；唯一缺口是 wiki 格式 → 方案最小化：识别 wiki 内嵌 + 确定性链接规范化，publish.py **零改动**。

## 交付清单

1. **check_state.py**（dev-examples/wx-article/scripts/draft_manager/check_state.py）
   - 新增 `WIKI_EMBED = re.compile(r"!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]")`（与 IMG_REF 同源计数，容忍 `|尺寸` 后缀）。
   - wiki 目标按文件名解析到 imgs/：命中计入 `imgs.referenced`（needs_insert 自然变 false）；未命中 → issues 加 `引用图缺失: ![[名]]`（阻断 prepare_ready，不猜）。
   - `imgs` 输出新增 `wiki_embeds` 计数（供 prepare 判定手动模式）。
2. **normalize_manual_images.py**（新脚本，draft_manager/，确定性零 LLM）
   - `![[名.png]]`/`![[名.png|300]]` → `![](imgs/名.png)`；封面（cover 前缀）→ `![文章封面](imgs/名.png)`（与 insert_images.py:281 标记约定一致）。
   - imgs/ 无同名文件 → [FAIL] 退出码 1（不猜、不复制别处图片）；非图片 wiki 链接原样保留。
   - article.yaml 缺 title/digest 时补最小元数据：title=md 文件名 stem（与标题确定性优先级一致）、digest=首个非空段落（去 md 记号）截 120 字句读边界、author=AI奇点、content_source、publish_completed=false；已有字段原样保留只追加缺失键。
   - 幂等：无 wiki 内嵌 → [SKIP] 文件不动。stdout 契约：[WIKI]/[SKIP]/[META]/[FAIL]/=== ALL DONE rewritten=N meta=patched|kept ===。
3. **article_prepare.js**（dev-examples/wx-article/scripts/article_prepare.js）
   - 状态检查后确定性读 `imgs.wiki_embeds`：>0 → **手动插图模式**——notify info 换文案、checkpoint 计划步骤 1 换「跳过自动插图,仅规范化链接」、跳过插图 workflow，改 `command()` 直跑 normalize（python3/python/py 试运行探测，参照 videodigest 执行器演进 2026-10-26，零 LLM）。
   - 规范化失败 → notify failed + return（ok:false, manual_normalized:false）；成功 → 复查（normalize 已补 yaml → prepare_ready=true）→ publish 链原样。
   - 完成通知与返回值区分手动模式（「手动插图链接已规范化」/ `manual_normalized` 字段）。
   - 序号预检对手动模式天然不触发（预检条件 needs_insert=true）。

## 对发布草稿箱流程的影响（结论：零改动复用）

- publish.py 上传/URL 替换/快照 hash/draft add-update-reuse 全复用：规范化后的 md 是标准引用 → image_refs 正常识别。
- md 变化 → contentHash 变化 → 首次 draft_add（新稿），同内容重跑 reuse；二次规范化 [SKIP] 不改文件 → hash 稳定。
- Obsidian 兼容：标准 markdown 引用在 Obsidian 同样渲染，用户笔记不受影响。

## 验证记录

- P1 门禁 run_p1_gate_suite.py 新增 I4 六用例（manual-wiki-detected / manual-wiki-missing-file / manual-normalize-rewrites / manual-normalize-patches-yaml / manual-normalize-idempotent / manual-after-normalize-ready），全套 **30/30 PASS**。
- pi-workflow validate article_prepare.js valid:true。
- 范例文真机（用户授权）：
  - check_state（改后）：needs_insert=false、wiki_embeds=6、referenced=6、issues 仅 yaml 缺字段（prepare_ready=false 待补）。
  - normalize 实跑：6 处 [WIKI] 全部改写（封面带「文章封面」alt）+ [META] 补齐（title=《看完 Manus 团队的工作方式，我发现自己可能还没真正用好 AI》、digest=39 字首段、author=AI奇点）。
  - 幂等复跑：[SKIP] + meta=kept，文件不动。
  - 复查：needs_insert=false、wiki_embeds=0、prepare_ready=true、issues=[] —— 发布链可直接走通。
- registry 未动（无路由变更），workflow DSL 与 python 脚本运行时现读，**无需重启 PM2 服务**。

## 増补（同日）：手动插图封面预检（m00618 用户补充细节）

- 用户指出：封面只能由文件名约定告知（手动插图无法其它方式声明），publish 必须带封面。
- 确认机制：封面判定唯一来源 = check_state.cover_state（根 cover.* 或 imgs/ cover 前缀），自动/手动统一；publish --cover 必传（微信草稿硬性要求）；正文 ![文章封面](...) 标记与判定无关，只让封面同时显示在正文顶部（与自动插图行为一致）。
- 増补：article_prepare.js 手动模式在授权 checkpoint 前新增封面预检——cover_path 为空（无 cover 文件）即中断并指引「把选定封面图重命名为 cover-开头放 imgs/ 下后重试」，不再浪费一次授权+规范化周期（与序号预检同理）；门禁新增 I4.manual-cover-none-blocked，全套 31/31 PASS。

## 遗留

- publish 实建草稿留给用户微信实测「准备文章 用Manus改造Manus，AI Native组织的团队分享」（授权 → 规范化[SKIP 幂等] → 建稿）。
- wiki 内嵌引用本目录 imgs/ 之外的图（vault 其它路径）不支持——按设计报「引用图缺失」不猜（如需可后续扩展跨目录解析）。

## 增补二（同日）：真机全链路验证 + wechat rebind 绑定确认消息（m00746）

- **Manus 文真机验证成功**：用户微信发送「准备文章 用Manus改造Manus，AI Native组织的团队分享」→ run-mvpfq5pf-ige5 completed：手动插图模式（本次检出 7 处 wiki 内嵌，用户验证期间又手动加过图——幂等规范化只处理新增的 wiki 链接）、跳过自动插图、新建草稿 draft_mode=add、manual_normalized=true、media_id 落盘、completed 通知送达。WX-P4 功能全链路（微信指令→路由→手动插图分支→建稿）验收通过。
- **插曲：入站静默中断**：测试当晚 22:55 后 bot 收不到任何微信消息（出站正常、getupdates 持续空批、游标推进），出站发一条测试消息（23:51:28）后 14 秒入站即恢复（23:51:42 收到积压消息）。疑似 ilink 平台侧会话惰死、出站活动触发恢复；根因未定位，恢复手法（发一条出站消息"踢"链路）已验证有效。
- **wechat rebind 确认消息（用户需求 m00746）**：src/cli/commands/wechat-login.ts——扫码登录成功（含 rebind）后，经服务 outbox 给绑定用户自动发送「✅ 微信 Bot 重新绑定成功，链路已恢复」；数据目录定位（PM2 ecosystem args 的 --data 优先，cwd 相对 .pi-wechat 兜底）；无绑定用户（首次登录）或无数据目录则跳过并提示；尽力而为绝不阻塞登录流程。tsc 构建通过 + 冒烟（临时数据目录 enqueue 正确 / null 跳过正确）。发消息通道复用 notify_bot.py 同款 Outbox 契约（已真机验证过投递）。
