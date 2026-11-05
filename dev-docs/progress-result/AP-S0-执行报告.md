# AP-S0 执行报告：小绿书发布通道（贴图=newspic 入草稿箱）

- **阶段**：AP-S0（2026-11-05，单阶段）
- **需求**：为公众号贴图（术语定案：贴图=小绿书）补齐原生发布通道；原链路只支持文章（news + freepublish）
- **设计**：`dev-docs/design/2026-11-05-小绿书发布通道设计.md`

## 交付清单

1. `wechat_draft_api.py`：`image_post_add`（真实 + Mock，inject 语义与 draft_add 一致）
2. `publish.py`：`--xiaolvshu` 模式（imgs/ 自然序全量上传永久素材 → newspic 入箱；
   同 Hash 复用 / 变更 draft_update / pending 恢复全复用；kind 隔离防互踩；freepublish 显式拒绝）
3. `run_sticker_gate_suite.py`：小绿书 Gate 套件（新建）
4. `wechat_sticker.js`（planning 脚本）：新增"发布小绿书"阶段（publish_method=draft|none）
5. WX-MOCK：`mock-sticker-publish` fixture 工作流 + `sticker-publish.json` 场景（新建）

## 验收证据（Gate B，全绿）

| 套件 | 结果 |
|------|------|
| 小绿书 Gate（run_sticker_gate_suite.py：入箱/复用/更新/混型防护/freepublish 拒绝/超时恢复/明确失败/无图/标题截断/文章缺 cover 回归） | 33/33 PASS |
| P0 回归（文章草稿模式） | 46/46 PASS |
| P1 回归 | 33/33 PASS |
| P2 回归（freepublish 发表模式） | 29/29 PASS |
| WX-MOCK deterministic 全量（route-smoke/keyword-conflict/param-extraction/execution-success/execution-failure/checkpoint-resume） | 6 场景全 PASS |
| WX-MOCK 新增 sticker-publish 场景（真实网关链路 → publish.py --xiaolvshu --mock → ALL DONE） | S1 PASS |

关键证据：sticker-publish runDir `20261105-173741-sticker-publish`，
sticker-out.txt 含 `[sticker] 2 images` / `[2] IMG 1/2` / `[5] DRAFT OK media_id=mock-post-...`
/ `=== ALL DONE draft_media_id=... ===`。

## 遗留问题

1. **真机抽检（Gate C）未做**：真实账号 newspic 入箱、`draft/update` 对 newspic 的真实行为未实测
   （mock 已覆盖；线上 40007 走既有自愈重置分支）。
2. **freepublish 对 newspic 未验证**：通道刻意不提供自动发表，发表靠公众号后台手发；
   微信侧后续开放时按 AP-P2 同构补发表模式。
3. **wechat_sticker 工作流未注册**：仍在 planning 脚本目录，迁入 dev-examples 注册表另立任务
   （迁移时按验收门规则与场景同 PR）。
