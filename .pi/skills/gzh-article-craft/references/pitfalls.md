# 踩坑清单（gzh-article-craft）

按"发布链最先崩"排序。每条含：现象 → 根因 → 规避/修复。详细取证见关联文档。

## 1. 图片文件名含空格/括号 → 引用悬空

- 现象：`![](imgs/03-x (1).png)` 解析成路径 `imgs/03-x (1`，上传找不到文件
- 根因：全链 `IMG_REF = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")`（check_state.py / content_hash.py / publish_html.py）`[^)]+` 在首个 `)` 停止；浏览器重复下载的 "(1)" 后缀文件必中
- 规避：图片文件名只用 `NN-分类-主题.ext`（中文+连字符+数字）；normalize_manual_images.py 第 0 步已加预检 [FAIL]，但下载/重命名时就该守住
- 关联：`dev-docs/experience/wechat-cover-235-ratio-and-filename-traps.md`

## 2. 封面非精确 2.35:1 → draft_add errcode 53401

- 现象：1922×818（比例 2.3496，与 2.35 差 0.0004）被微信拒绝"封面图片尺寸不合法"
- 根因：微信按**精确 2.35:1** 校验，"接近"不算
- 修复（已入管线，无需人工）：publish.py 上传前 `ensure_cover_235()`——比例在 ±1% 内自动缩到精确 47k×20k（典型 1880×800）并备份原图到 `_cover-original/`；明显偏离（如 16:9）只 WARN 不动图（历史 16:9 曾通过，别自动裁剪毁构图）
- 注意：非 PNG 封面（jpg/webp）自动缩放不支持，会 WARN 后原样上传，53401 时人工换图

## 3. 根目录 cover.* 优先级高于 imgs/cover-*

- 现象：换手动封面后发布仍是旧图
- 根因：`check_state.py cover_state()` 先查根 `cover.png/jpg/jpeg/webp` 再回落 imgs/cover-*；旧一轮生成的根封面会顶掉手动封面
- 规避：换封面时把根 cover.* 移走（`_prev-round-日期/`）；check_state 已加"封面优先级提示"issues 项

## 4. 关键图文字缺失复现（"老问题"）

- 现象：封面按新要求带了关键词文字，但新增正文图提示词全部无字、无 expected_text
- 根因三层：①旧 style_prefix"画面中不出现任何文字"条款惯性沿袭（visual-rules.md 实际允许"一个短词或短语"）②关键图没有"默认带关键词"的正面约定 ③expected_text 是可选字段，validate 只校验格式不提示缺失
- 规避：**每张图写 prompt 前先问"这张图的关键词是什么"**；声明了画面文字必同步 expected_text；style_prefix 用"文字只允许出现在指定标题位置"
- 关联：`dev-docs/troubleshooting/2026-10-28-正文配图提示词文字缺失复现分析.md`、T0 报告（"零字约束失效"结论已作废）

## 5. image-use web 后端 E_ENV：chrome-use 驱动不了 Chrome

- 现象：`relay not connected` + `profile 'Default' unavailable: composer never appeared`（41s 超时）
- 根因：web 后端强依赖 **Chrome 开着 + ab-connect relay 扩展在线**（接管已打开的标签页）；Chrome 被杀后 chrome-use 冷启动 profile，国内网络下拉不起 chatgpt.com（疑似未走代理/被墙）。**杀 Chrome 重试没用**
- 规避：生成前让用户正常打开 Chrome（能开 chatgpt.com 的那个），relay 随浏览器上线再跑；备选 `IMAGE_USE_BACKEND=codex`（无头，消耗 Codex 订阅额度）
- 附：chrome-use 0.39.4 落后 1.5.0 有警告（image-to-image/model-switch 可能失败），待升级
- 诊断命令：`./thirdparties/image-use/image-use --backend web --quiet "probe" -o /tmp/p.png --timeout 90`（失败信息会给出三条修复路径）

## 6. preview 模式对 failed 条目"空跑"

- 现象：manifest 里 cover=failed（E_ENV 残留）时重跑 preview，生成步骤 0 秒结束，风格确认检查点拿到空数据（"代表条目: ?"）
- 根因：executor 对 failed 状态条目默认不重试；result 无 failed_ids → workflow 照常进风格确认门
- 规避：**preview/batch 命令必带 `retry_failed: true`**

## 7. X 图床 404（原图下架）

- 现象：引用文里的截图 URL 下载 0B，`?format=jpg` 与 `.png` 均 404
- 根因：作者删推/X 下架媒体
- 规避：用同段落语义最接近的替代图并同步改配文；删掉 0B 残留文件再对账

## 8. 网络与代理

- X 图床下载走本地代理 `-x http://127.0.0.1:7897`（git 的 http.proxy 同源）
- git HTTPS 走该代理抖动（SSL_ERROR_SYSCALL）时：SSH 可用，`git fetch git@github.com:<owner>/<repo>.git <branch>` + `git merge --ff-only FETCH_HEAD` 兜底
- 下载后校验：`file -b` 类型正确且非 empty、大小 >10KB

## 9. 配图序号语义（2026-10-28 定版）

- `NN-中文标题.png` 的 NN=第 N 个 `##` 章节；封面 `cover-中文主题.png` 落根（旧约定落根，手动插图流程放 imgs/ 亦可被识别）
- check_state 序号预检：**跳号=无图章节，降为提示不阻断；越界（>章节数）=阻断**；序号重复/混入无序号 → 检查不适用（走语义，不报缺号）

## 10. 审批文档命名干扰正文定位（已修源头）

- 现象：文章目录出现 `image-prompts-review.md` 后，normalize/check_state 报"正文 md 候选不唯一或缺席"
- 根因：正文定位排除规则只认 `^(article|draft|review)` 开头和 NAME_ILLEGAL（审稿/图片引用清单/大纲/配图建议）旧名命中不了
- 修复（已入 export-review.mjs，2026-10-28）：缺省输出改名 `review-image-prompts.md`；存量老文章目录里的旧名文件手动 mv 改名即可

## 11. 封面图占首行后 digest 抓成章题

- 现象：normalize 自动补的 digest 是"一、国内市场先跑出来的 Personal Agent，出现了"这类章题，不是导语
- 根因：first_digest 取首个非空文本块；封面图在第 1 行被剥掉后首个块成了第一个 ## 标题
- 规避：normalize 后必检查 article.yaml 的 digest，不合格就手工改成一句话导语（含关键词，≤120 字）

## 12. 其他小坑

- **标题/摘要带包裹引号直接进微信草稿（2026-10-29）**：article.yaml 行式解析 `title: "xxx"` 不去引号，昨天发布后草稿标题成了 `"xxx"`。修复：publish.py 加 `_unquote`（读 yaml 与 CLI 参数统一去一层成对引号，ASCII 单双引号与中文弯引号）；传参侧仍约定裸串
- `validate-plan.mjs --article-dir` 报 EISDIR（用法不匹配）——计划校验用 workflow 的 dry-run 步骤即可，别依赖该入口
- pm2 wechat-bot 服务数据目录=仓库 `.pi-wechat/`（chat-logs/tasks.jsonl/run-attempts.jsonl 都在这）
- 任务成功率统计：`dev-examples/wechat-stats/task_stats.py --data-dir .pi-wechat`（tasks.jsonl 同 taskBindingId 多行末行为准；原始行数≠任务数）
- 正文 md 命名=最终标题（含空格/中文标点都行，md 文件名不受 IMG_REF 限制）；article.yaml 的 title/digest 由 normalize 自动补（title=文件名去 .md，digest=首段 120 字内句读截断）
