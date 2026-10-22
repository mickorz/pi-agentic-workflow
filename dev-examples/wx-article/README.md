# wx-article — 文章工作流微信接入（需求 1/2）

> 需求：《文章工作流接入需求.md》· 方案：《微信接入方案.md》
> 范围：需求相关两个流程（大纲 / 直发草稿）+ 自 ~/.claude/workflows 引入的插图元数据流程。

## 流程清单

| workflowId | 脚本 | 风险级 | 微信触发 |
|---|---|---|---|
| `obsidian-outline` | scripts/obsidian_outline.js（新写，编排 collect_images + 图片分析 + 目录分析 + 大纲） | read-only | 自动执行 |
| `wechat-md-to-draft` | scripts/wechat_md_to_draft.js（自脚本库复制，PUBLISH_SCRIPT 已改相对路径） | external-side-effect | 执行前授权（AM-P0 批准链） |
| `article-insert-images-meta` | scripts/article_insert_images_meta.js（自 ~/.claude/workflows 引入，插图脚本路径改仓库内绝对路径；默认追加去 AI 味） | write | 执行前授权（AM-P0 批准链）；微信必传 skip_confirm:true |
| `article-humanize` | scripts/article_humanize.js（自 ~/.claude/workflows 引入，独立去 AI 味，从 polish 的 humanizer 段抽离） | write | 执行前授权（AM-P0 批准链） |

子流程依赖：scripts/article_collect_images.js（被 outline 编排，自包含）。
发布脚本：scripts/references/wechat_md_to_draft/scripts/publish.ps1（已内嵌）。
插图脚本：scripts/references/article_insert_images_meta/scripts/insert_images.ps1（已内嵌，自检 test-fixture/run.sh）。
去 AI 味依赖 humanizer skill：已复制到 ~/.pi/agent/skills/humanizer（换机器同步）。
注意：本目录 registry.json 未含 article-insert-images-meta 与 article-humanize——微信测试用仓库根聚合表（`pi-workflow wechat start --routing-mode agent` 缺省即 am-p0/registry.json + --scripts dev-examples），详见 scripts/references/article_insert_images_meta/README.md。

## 启动（从本目录启动，cwd 即数据目录）

```bash
cd dev-examples/wx-article
pi-workflow wechat start --registry registry.json --scripts scripts \
  --allow-user <你的wxid> --rate-max 10
```

微信发：`帮我分析 E:/Obsidian/MyVault/知识库 这个目录做个大纲` → 受理 → 完成通知含
大纲/清单路径。

## CLI 直跑（发布类当前走这里）

```bash
cd dev-examples/wx-article
pi-workflow run scripts/wechat_md_to_draft.js --args '{"article_dir":"E:/Obsidian/文章A","cover":"E:/Obsidian/文章A/cover.png"}'
```

## 依赖与注意

- outline 类：无外部配置依赖（collect_images 自包含）。
- md_to_draft：需要 `.aws-article/config.json` + `aws.env`（首次引导见脚本内注释）；
  publish.ps1 依赖公众号 API 凭证；草稿箱 URL token 会过期（见脚本注释）。
- vaultDir 路径在微信消息里正反斜杠均可；含空格中文需完整传递（路由参数抽取依赖样例）。
- 发布类微信触发放开依赖 AM-P0 PendingAction（执行前授权协议）。
