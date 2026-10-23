# wx-article — 文章工作流微信接入（需求 1/2）

> 需求：《文章工作流接入需求.md》· 方案：《微信接入方案.md》
> 范围：需求相关两个流程（大纲 / 直发草稿）+ 自 ~/.claude/workflows 引入的插图元数据流程。

## 流程清单

| workflowId | 脚本 | 风险级 | 微信触发 |
|---|---|---|---|
| `obsidian-outline` | scripts/obsidian_outline.js（新写，编排 collect_images + 图片分析 + 目录分析 + 大纲） | read-only | 自动执行 |
| `wechat-md-to-draft` | scripts/wechat_md_to_draft.js（自脚本库复制，PUBLISH_SCRIPT 已改相对路径） | external-side-effect | 执行前授权（AM-P0 批准链） |
| `article-insert-images-meta` | scripts/article_insert_images_meta.js（自 ~/.claude/workflows 引入，插图脚本路径改仓库内绝对路径；默认追加去 AI 味） | write | 执行前授权（AM-P0 批准链）；微信必传 skip_confirm:true |
| `article-humanize` | scripts/article_humanize.js（自 ~/.claude/workflows 引入，独立去 AI 味，从 polish 的 humanizer 段抽离；前置检查 humanizer skill，缺失立即报错） | write | 执行前授权（AM-P0 批准链） |
| `wechat-article-publish` | scripts/wechat_article_publish.js（自 ~/.claude/workflows 引入，API 直连发布/入草稿箱；skill 路径改仓库内，配置改为从 article_dir 向上找工作区根） | external-side-effect | 执行前授权（AM-P0 批准链）；微信必传 skip_confirm:true |

子流程依赖：scripts/article_collect_images.js（被 outline 编排，自包含）。
发布脚本：scripts/references/wechat_md_to_draft/scripts/publish.py（已内嵌，Python 跨平台）。
插图脚本：scripts/references/article_insert_images_meta/scripts/insert_images.py（已内嵌，自检 test-fixture/run.py）。
去 AI 味依赖 humanizer skill：已复制到 ~/.pi/agent/skills/humanizer（换机器同步）；workflow 定位阶段有前置检查，缺失立即失败并给出安装指引（不静默降级）。
发布脚本：scripts/references/wechat_article_publish/（5 个 md 文档，API 直连发布用；凭证在工作区根 .aws-article/config.json + aws.env，如 E:/Obsidian/newsky/60_Workspace/写作/单篇）。
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
- 公众号凭证已集成到本仓：`dev-examples/wx-article/.aws-article/`（config.json + presets）+ `aws.env`（均已 .gitignore，换机器需手动同步两份）；两个发布类 workflow（wechat-md-to-draft / wechat-article-publish）默认读这里（`args.config_dir` 可覆盖），不再从文章目录向上找。publish.py 定位改为脚本位置优先、文章目录兼容回退。
- md_to_draft：发布脚本 publish.py 依赖上述凭证；草稿箱 URL token 会过期（见脚本注释）。
- article_publish：草稿/群发模式由 config 的 publish_method 决定（当前 draft）；force_publish=true 才提交群发。
- vaultDir 路径在微信消息里正反斜杠均可；含空格中文需完整传递（路由参数抽取依赖样例）。
- 发布类微信触发放开依赖 AM-P0 PendingAction（执行前授权协议）。
