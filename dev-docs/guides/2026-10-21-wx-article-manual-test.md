# wx-article 手动测试指南（Obsidian 大纲 / 文章直发草稿箱）

> 日期：2026-10-21 · 阶段：article 需求集成验收（commit b32c91e）
> 被测：`dev-examples/wx-article/` 两流程（obsidian-outline read-only / wechat-md-to-draft external）
> 约定（CLAUDE.md）：全局命令 `pi-workflow`；模型走 `~/.pi/agent/settings.json` 不传 `--model`；
> 每条用例给出**步骤 / 预期 / 证据**；结果记入文末记录表
> 前置：WX-PT Part B 已完成（同微信号服务互斥，article 测试须错开 wx-p2 服务窗口）

## 0. 环境准备

```bash
cd <仓库根>
npm ci && npm run build && npm link        # 已 link 过只需 rebuild
cd dev-examples/wx-article
pi-workflow validate scripts/obsidian_outline.js    # 预期 valid:true
pi-workflow validate scripts/wechat_md_to_draft.js  # 预期 valid:true
```

**构造 Obsidian 测试目录**（如 `E:/Obsidian/TestVault/A`，含以下内容）：

```text
A/
  01-笔记1.md     正文含 1 个远程图片引用 ![图1](https://pbs.twimg.com/media/xxx.jpg)
  02-笔记2.md     正文含 1 个远程图片引用 + 1 个失效 URL（验证失败容错）
  03-笔记3.md     纯文字笔记（3~5 段，有明确主题）
```

发布类（C 组）另需：`.aws-article/config.json` + `aws.env`（首次引导见脚本注释）、
一个已生成的文章目录（含 .md 写作稿 + cover.png）。

## 1. A 组：obsidian-outline CLI 冒烟（真实模型，无需微信）

**A1 全链执行**

```bash
cd dev-examples/wx-article
pi-workflow run scripts/obsidian_outline.js --args '{"vaultDir":"E:/Obsidian/TestVault/A"}'
```

预期（四阶段）：
- phase 图片收集：日志 `图片收集完成: 下载 N 张, 失败 M 张`（M≥1 允许，失效 URL 容错）
- phase 图片分析：`A/imgs/` 下有已下载图片；生成 `A/图片引用清单.md`（每图一节：文件名/来源/描述/插图建议）
- phase 目录分析：`目录分析完成: 3 篇文章`
- phase 大纲制作：生成 `A/大纲.md`（标题+章节+要点+插图标注）
- exit 0；result 含 `outline_path/image_list_path/downloaded_count/image_count/ok:true`

证据：`pi-workflow list` + 产物文件路径。

**A2 缺参校验**

```bash
pi-workflow run scripts/obsidian_outline.js --args '{}'
```

预期：执行失败 `缺少必填参数 vaultDir`；exit 1（不静默猜测路径）。

**A3 路径反斜杠兼容**

```bash
pi-workflow run scripts/obsidian_outline.js --args '{"vaultDir":"E:\\Obsidian\\TestVault\\A"}'
```

预期：与 A1 等价（脚本内统一转正斜杠）。

**A4 重复执行幂等语义**

A1 完成后再跑一次（imgs 已存在）。

预期：collect_images 去重/跳过已下载；清单与大纲被**重新生成**（内容可更新）；不报错。

## 2. B 组：obsidian-outline 微信端到端

启动（wx-article 目录）：

```bash
cd dev-examples/wx-article
pi-workflow wechat start --registry registry.json --scripts scripts \
  --allow-user o9cq80xRHbzE8CUrHdTyXhO_pdA4@im.wechat --rate-max 10
```

预期横幅：`wechat-dispatch 已启动（registry=2 个流程 …）`。

| # | 手机发送 | 预期 | 证据 |
|---|---|---|---|
| B1 | `帮我分析 E:/Obsidian/TestVault/A 这个目录做个大纲` | 受理回执（tb-）→ 完成通知含大纲/清单路径与下载图数 | tasks.jsonl 新增；产物文件生成 |
| B2 | `帮我分析一个 obsidian 目录` | 追问 vaultDir，**不启动** | conversation 待补记录 |
| B3 | （B2 后）`E:/Obsidian/TestVault/A` | 合并参数启动 | 同 B01 语义（CV-002） |
| B4 | `整理一下 E:/Obsidian/TestVault/A 的图片引用` | 命中同流程（关键词路由）；正常执行 | 意图日志 workflowId=obsidian-outline |
| B5 | 路径含空格中文：`分析 E:/Obsidian/我的 库/A 做大纲` | 参数完整抽取不截断 | 产物生成于正确目录 |

## 3. C 组：wechat-md-to-draft（发布类）

**C1 CLI 真实发布（需凭证）**

```bash
cd dev-examples/wx-article
pi-workflow run scripts/wechat_md_to_draft.js \
  --args '{"article_dir":"E:/Obsidian/TestVault/文章X","cover":"E:/Obsidian/TestVault/文章X/cover.png"}'
```

预期：md→HTML→图片上传→建草稿→打开草稿箱；result 含 `media_id, publish_completed:true`；
公众号后台草稿箱可见新草稿。

**C2 微信触发负向（external 拒绝）**

微信发：`把 E:/Obsidian/TestVault/文章X 这篇文章发布到草稿箱`

预期：**NOT_AUTHORIZED**（执行前授权未实现，明确"需授权"话术）；
**不是**"找不到流程"——路由命中 wechat-md-to-draft 后被风险校验拒绝。
证据：审计 intent.route 含 workflowId + rejected。

**C3 PUBLISH_SCRIPT 相对路径**

从 wx-article 以外目录跑 C1 命令（不带 args.publish_script）。

预期：agent 找不到 `scripts/references/.../publish.ps1` 而失败或提示路径——
**运行约定：必须从 wx-article 目录启动**（README 已注明；此用例固化该约定）。

## 4. D 组：边界与回归

| # | 场景 | 预期 |
|---|---|---|
| D1 | vaultDir 指向不存在目录 | collect_images 阶段失败可读错误；exit 1；不产生半成品清单 |
| D2 | 目录无任何图片引用 | downloaded_count=0；清单文件仍生成（含"无图"说明）；大纲正常 |
| D3 | wx-p2 服务回归 | article 服务停止后，wx-p2 按原指南启动，Part A 套件 11/11 不受影响 |
| D4 | 主项目回归 | `npm test` 全绿（本集成零 src 改动，理论无影响，留证） |

## 5. 测试记录表（执行时填写）

| 用例组 | 结果(P/F) | 证据摘要 | 备注 |
|---|---|---|---|
| A1~A4 | ☐ | | |
| B1~B5 | ☐ | | |
| C1~C3 | ☐ | | |
| D1~D4 | ☐ | | |

## 6. 常见问题

- **B5 路径截断**：路由 LLM 对含空格中文路径的抽取不稳 → 补 routing-samples 样例；
  或先用 B2/B3 两步式（追问后直接回路径）。
- **图片下载全失败**：检查网络（pbs.twimg.com 需可达）；failed_count 容错不算 F。
- **C1 凭证缺失**：`.aws-article/config.json`/`aws.env` 未配 → 脚本第一阶段检查即失败，按注释补。
- **微信服务冲突**：同一时间只能跑一个 wechat start（凭据轮询单连接）；
  article 与 wx-p2 测试错开窗口。
