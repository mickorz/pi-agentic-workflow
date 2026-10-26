# 公众号 workflow 脚本运行模型查证

> 查证日期：2026-10-23
> 范围：`dev-examples/wx-article/` 下全部公众号相关 workflow 脚本

## 问题

wechat-md-to-draft 等公众号 workflow 脚本，运行时用的是什么模型？

## 结论

脚本本身**均未指定模型**，实际运行走 pi 全局默认配置 `~/.pi/agent/settings.json`：

```json
"defaultProvider": "cc-switch-zhipu-glm",
"defaultModel": "glm-5.3-flash"
```

即当前实际运行模型为 **cc-switch-zhipu-glm 提供的 glm-5.3-flash**。本仓库无项目级 `.pi/settings.json` 覆盖。

## 涉及脚本

`dev-examples/wx-article/scripts/` 下全部 workflow，脚本内所有 `agent()` 调用都只传 `label`/`agentType`/`schema`，没有任何一处带 `model` 参数：

| workflowId | 脚本 |
|------------|------|
| wechat-md-to-draft | `wechat_md_to_draft.js`（文章直发草稿箱） |
| obsidian-outline | `obsidian_outline.js` |
| article-collect-images | `article_collect_images.js` |
| article-humanize | `article_humanize.js` |
| article-insert-images-meta | `article_insert_images_meta.js` |
| wechat-article-publish | `wechat_article_publish.js` |

## 模型解析链路

```
脚本 agent() 未传 model
  → PiAgentAdapter 用 defaultModel
    （src/adapters/pi/pi-agent-adapter.ts: options.model ?? this.defaultModel）
  → CLI 未传 --model
  → 读 pi 全局设置 ~/.pi/agent/settings.json
    （defaultProvider + defaultModel）
```

## 换模型方式

- **常规**：改 `~/.pi/agent/settings.json` 的 `defaultModel`，不改测试命令
  （与 CLAUDE.md 手动测试约定一致：模型走本地 JSON 配置，不传 `--model`）
- **临时试验**：显式传 `--model provider/modelId`，仅单次生效
