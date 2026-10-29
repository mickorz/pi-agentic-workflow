# 微信草稿 draft_update 必报 40007：内容更新即新建草稿

## 问题现象

同一篇文章第二次及以后调用 `publish.py`（dev-examples/wx-article/scripts/draft_manager/）时，脚本检测到 `publish-state.json` 里有 `draftMediaId` 便走 `draft_update` 分支，微信侧必返回：

```
draft_update errcode=40007: invalid media_id
```

脚本随后自动重置账号态为 not_drafted 并提示"重跑即新建"；重跑后走 `draft_add` 一定成功。2026-10-29《Goal 实现》一文复现 2 次（一天内 3 次发布，2 次撞上）。

## 排查过程

1. 确认传入 media_id 与上一次 `[5] DRAFT OK` 输出一致，非手误；
2. 确认 token/thumb 正常（[1][2] 步全过），仅 draft_update 这一步 40007；
3. 两次发布内容不同（第一次补图、第二次 humanizer 改文），与内容无关；
4. 未抓包深查代理层透传，根因停留在"media_id 对 update 语义不可复用"的结论上。

## 根因（待验证的结论）

经代理 `wechat.aiworkskills.cn` 走的公众号草稿链路里，`draft_add` 返回的 media_id 无法用于 `draft_edit`（可能代理侧未实现 update 语义，或草稿对象本身不可编辑）。**未验证**：直接调公众平台官方 draft_edit 是否同样 40007。

## 解决方案

采用脚本内建兜底：撞 40007 → 状态自动重置 → 重跑 publish 走 `draft_add` 新建。内容更新 = 新草稿，旧草稿在公众号后台草稿箱手动删除。

## 预防 / 注意事项

1. **发布前定稿**：入箱前先过 F3（humanizer 去 AI 味）并确认标题/digest，避免反复重发产生多个草稿；
2. **重发后清箱**：每次"重跑即新建"后，去草稿箱按时间删旧版，只留最新 media_id；
3. **待办**：若确需"原地更新草稿"，要排查代理层对 draft_edit 的支持（对照官方 openapi 的 draft_edit 语义），或在 publish.py 增加跳过 update 直接 add 的显式开关；
4. publish.py 的自动重置兜底已验证可靠，撞 40007 时照提示重跑即可，不要手动改 publish-state.json。
