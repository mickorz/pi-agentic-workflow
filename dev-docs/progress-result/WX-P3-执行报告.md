# WX-P3 执行报告 — article-prepare 配图序号预检 + 免后缀话术

> 日期：2026-10-26 · 阶段：WX-P3（微信「准备/处理文章」指令体验调整，用户 m00105 两项需求）
> 改动面：check_state.py / article_prepare.js / 两份 registry / P1 门禁
> 结论：**两项调整全部交付并真机验证**；P1 门禁 24/24 PASS（含新增 I3 三用例）；CLI 冒烟确认序号中断在授权前生效；PM2 服务已重启加载新 registry（sha 8b4c6bcb）。

## 1. 需求与方案

用户两项调整（2026-10-26）：
1. 「准备文章/处理文章」流程**最先**检查配图序号缺失（如 01-06、08、09 缺 07），发现即**中断并告知缺失序号**；
2. 指令**免后缀**：「准备文章 <标题>」「处理文章 <标题>」即可，默认必须走到草稿箱，无需「插图后放到草稿箱/入草稿箱」尾缀。

## 2. 交付明细

### 2.1 配图序号预检（缺号/越界 → 授权前中断）

- `dev-examples/wx-article/scripts/draft_manager/check_state.py`：
  - 新增 `numbering_precheck(img_files, md_text)` 与 `number_of()`；`NUM_RE`/`IMG_EXTS` 与 insert_images.py 同源（`^(?:图\s*)?(\d{1,3})(?=[-_.\s]|$)` 作用于 stem）。
  - 输出新增 `imgs_numbering: {applicable, missing[], out_of_range[], sections}`（sections=正文 `##` 计数）。
  - 仅当全部正文图（cover 前缀排除）带**唯一序号**时 applicable（混入无序号图/重复序号→不适用，走语义匹配不检）。
  - issues 追加 `配图序号缺失: 07` / `配图序号越界: 9 超出章节数 8`。
- `dev-examples/wx-article/scripts/article_prepare.js`：状态检查后、**授权 checkpoint 前**，从 `raw`（确定性 JSON.parse，不信 LLM 转述）提取 `imgs_numbering`；`needs_insert && applicable && (missing || out_of_range)` → notify failed + return（report 含缺失/越界序号，不消耗审批与后续步骤）。

### 2.2 免后缀话术 + article_name 通道 vault 回落

- 两份 registry（`dev-examples/wx-article/registry.json` 源 + `dev-examples/am-p0/registry.json` PM2 聚合）article-prepare 条目：
  - description 改为「默认必须走到草稿箱:话术「准备文章 <标题>」「处理文章 <标题>」即完成插图+入草稿箱,无需附加…」；
  - examples 新增免后缀样例「准备文章 01｜一家轻食店的四个 AI 改造场景」「处理文章《AI提问技巧》」；
  - `article_name` 参数描述改为「优先 Obsidian vault 确定性解析(文章名),未命中再按 article_workspace 一级子目录」。
- `article_prepare.js` 新增 article_name 通道 **vault 确定性回落**：路由 dry-run 实测免后缀话术稳定提取为 `article_name`（confidence 0.95），而本机未配 `article_workspace`（文章在 vault 深层，裸 `--locate` 必败）——回落 `vaultResolve(article_name, want=article)`，命中即定位（`vault_ref_pinned_rel` 审批锚点校验同样生效），未命中保持原 workspace 行为。

## 3. 验证记录

| 项 | 结果 |
|---|---|
| P1 门禁 `run_p1_gate_suite.py`（含新增 I3 三用例） | **24/24 PASS**：I3.numbering-gap-and-oor / I3.numbering-not-applicable-mixed / I3.numbering-clean-pass |
| `pi-workflow validate article_prepare.js` | valid:true（改动前后各一次） |
| 路由 dry-run（免后缀两种话术） | 均 article-prepare / confidence 0.95 |
| vault_resolver 实测 | ref「01｜一家轻食店的四个 AI 改造场景」exact_name 命中（want=article） |
| CLI 真机冒烟 `run-mvpdibdp-j7ym` | 1 agent/13.2s：vault 回落定位 → 序号预检**授权前中断**，ok:false，report「配图序号检查未通过（序号越界: 9 超出章节数 8）」→ 微信收到失败通知 |
| PM2 服务 | `wechat service restart` ×2，healthy，registry 22 条 sha 8b4c6bcb |

冒烟时序说明：首次 check_state 实测该文章 missing=[7]/out_of_range=[9]（sections=8）；期间用户经坚果云补入 07 图（06/07 同名不同序号，内容疑似重复），冒烟时预检如实报「越界 9 超出章节数 8」——预检行为随 vault 实时状态正确变化。

## 4. 遗留

- 目标文章 09-轻食店AI改造全景图.png 序号越界（>8 章节）：需用户重命名序号或补第 9 章，否则该文章指令将持续按设计中断并提示。
- 06/07-企业AI改造六步法：从痛点到落地.png 文件名仅差序号，疑似同图两份，建议人工确认。
- article-publish 工作流的 article_name 通道未加 vault 回落（registry 描述未动，避免误导）；如需同样体验可后续按 prepare 同款补。
