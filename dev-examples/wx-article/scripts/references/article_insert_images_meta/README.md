# article_insert_images_meta（文章配图插入与元数据）

给文章 `.md` 按章节批量插入 `imgs/` 配图，并生成/更新 `article.yaml` 元数据的 workflow。
自 `~/.claude/workflows` 同名脚本库引入本仓库（2026-10-22），脚本逻辑与原库一致，
仅插入脚本路径改为仓库内绝对路径（可用 `args.insert_script` 覆盖）。

## 用途

适用于「每章一个术语 + 每章末尾一句"一句话记住"」这类系列文章（如「从零学AI」名词解释系列）。
一次执行完成两件事：
1. 把 `imgs/` 里的图片按**图名与章节标题的语义**匹配，插到对应章节的「一句话记住」行前（无该行则插到章节末尾）。
2. 写/更新 `article.yaml` 的 `title / author / digest / content_source / image_medium`，并把 `publish_completed` 置 false。

## 输入 args

| 参数 | 必填 | 说明 |
|---|---|---|
| `article_dir` | 是 | 文章目录绝对路径，含 1 个 `.md` 源文件 + `imgs/` |
| `md_file` | 否 | 指定 `.md` 绝对路径；不传则自动找（排除 article/draft/review/审稿/pre-humanize，取最长名） |
| `title` | 否 | 覆盖 article.yaml 标题 |
| `digest` | 否 | 覆盖 article.yaml 摘要 |
| `author` | 否 | 覆盖 article.yaml 作者（不传保留原值） |
| `skip_confirm` | 否 | 跳过插图前人工确认，默认 false。**微信链路必传 true**（见下） |
| `skip_humanize` | 否 | 跳过插图后的去 AI 味改写，默认 false（默认会调 article_humanize） |
| `humanize_voice` | 否 | 去 AI 味 voice：casual/professional/technical/warm/blunt（默认 professional） |
| `humanize_aggressive` | 否 | 去 AI 味重度改写，默认 false |
| `humanize_iterate` | 否 | 去 AI 味 detect-rewrite-detect 迭代次数 1-3，默认 2 |
| `insert_script` | 否 | 插图脚本路径覆盖（换机器时用，默认仓库内 insert_images.py） |

## CLI 直跑

```bash
cd /e/WorkProjects/pi-agentic-workflow
pi-workflow run dev-examples/wx-article/scripts/article_insert_images_meta.js \
  --args '{"article_dir":"E:/Obsidian/newsky/60_Workspace/写作/单篇/AI名词解释/从零学AI- 9 个常见 AI 术语，不懂技术也能看懂 3","skip_confirm":true}'
```

## 流程

1. **扫描与匹配**：读 `.md` 章节标题 + 列 `imgs/` 文件名，按语义匹配，返回 `images[{image,heading,alt}]` 与 title/digest 建议。
2. **确认**（可跳过）：checkpoint 展示「图 -> 章节」映射。
3. **插入**：把映射写成临时 JSON，调 `scripts/insert_images.py` 在每章「一句话记住」前插图。
4. **更新元数据**：写回 `article.yaml`。
5. **去 AI 味**（`skip_humanize: true` 跳过）：嵌套调 `article_humanize.js`（同目录，humanizer skill），改写评分与问题清单回填到输出的 `humanize{}`。
6. **检查**：核对图标记数、路径存在、章节覆盖、yaml 关键字段。

## 脚本

`scripts/insert_images.py`（参数化，Python 3 标准库，跨平台）：

```
python3 insert_images.py --article-dir <dir> [--md-file <md>] --mapping-path <json> [--cover-image <cover>]
```

Mapping JSON 格式：

```json
[{ "image": "imgs/xxx.png", "heading": "## 01. RAG（检索增强生成）：让 AI 学会开卷考试", "alt": "术语插画：..." }]
```

脚本按 `heading` 精确定位章节（先全等匹配，再前缀匹配），在该章节内第一个 `**一句话记住` 行前插入三行（空行 + 图片 + 空行）；章节无该行则插到章节末尾。未找到章节的项会在 `[FAIL]` 中列出并以退出码 2 结束。

### 自检

```bash
python3 dev-examples/wx-article/scripts/references/article_insert_images_meta/test-fixture/run.py
```

覆盖：一句话记住前插入 / 无记住行插章节末尾 / 未匹配章节 FAIL 路径（退出码 2）/ 未匹配图不写入。

## 微信测试（agent 模式）

已注册进聚合注册表 `dev-examples/am-p0/registry.json`（workflowId `article-insert-images-meta`，riskLevel `write`）：

```bash
cd /e/WorkProjects/pi-agentic-workflow
pi-workflow wechat start --routing-mode agent
```

微信发（article_dir 换成真实文章目录）：

> 给 E:/Obsidian/newsky/60_Workspace/写作/单篇/AI名词解释/从零学AI- 9 个常见 AI 术语，不懂技术也能看懂 3 这个目录插入配图并更新元数据，跳过确认

链路：write 级 → Agent 返回「需批准」→ 微信回「批准」→ 执行 → 完成通知含插入数与检查结论。

**微信链路必传 `skip_confirm: true`**：wechat 链路没有 checkpoint Provider，
workflow 内的 `checkpoint()` 会把 run 置为 `waiting_checkpoint` 挂起（只能终端 `pi-workflow resume` 恢复）；
微信侧的人工授权由外层 write 级 PendingAction 批准链承担，语义已覆盖。
默认会接着走去 AI 味（多两轮 LLM 改写，耗时长）；只要配图时传 `skip_humanize: true`，
或事后单独发「把 xxx 目录的文章去一下 AI 味」（workflowId `article-humanize`）。

前置：`article_humanize` 依赖 `humanizer` skill——已复制到 `~/.pi/agent/skills/humanizer`（来自
`~/.claude/skill-vault/humanizer`，换机器需同步复制，否则改写退化为仅靠 prompt 内嵌的 ZH 规则）。

## 注意

- 仅在 `.md` 中插图，不改正文；`.md` 会以 UTF-8 BOM 写回。
- 图名与章节主题对不上时，agent 会把图放进 `unmatched`，不强行插入。
- 若 `article.yaml` 原本 title/digest 与本文不符（例如复用了上一期），agent 会用根据正文生成的建议值覆盖。
- 风险级 `write`（改 md + yaml）：微信触发走执行前授权；CLI 直跑无授权环节，注意 article_dir 指向。
