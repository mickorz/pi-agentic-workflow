# 插图重复插入与序号确定性重锚定

## 问题现象

用户反馈文章插图逻辑三类问题（2026-10-24，四象限文章 prepare 链路实测）：

1. **重复插入**：重跑 `article-prepare` / `article-insert-images-meta` 后，同一章节出现多张相同图片标记——脚本对同一 heading 每次调用都无条件再插一次，没有幂等检查。
2. **错图不纠正**：章节里已有配图但插错了位置/版本时，再跑只会在旁边叠加新图，不会替换旧图。
3. **序号图也要 LLM 语义匹配**：生图产物文件名本就带序号（`01-xxx.png`），但流程仍靠 LLM 逐张语义匹配章节（慢、会漂移、还会去读图片内容）。

## 排查过程

- `dev-examples/wx-article/scripts/references/article_insert_images_meta/scripts/insert_images.py` 旧逻辑：每项 mapping `定位 heading → insert_point 前盲插`，无「章节内已有图」检查（唯一幂等点是封面）。
- 匹配层在 `article_insert_images_meta.js` 的「扫描与匹配」agent：纯 LLM 语义匹配，heading 写错脚本就插错章节或报 heading not found。

## 根因

- 插入端无状态对比（不读当前章节已有标记）；
- 确定性信息（文件名序号）没有进入服务端决策链，全押在 LLM 输出上。

## 解决方案（commit 25a32bc）

`insert_images.py` 重构（输出契约向后兼容，统计行扩展）：

1. **幂等**：插入前扫描章节范围（heading 行 → 下一个 `##`）内的本地图片标记；已存在相同 image → `[SKIP]`，重跑零重复。
2. **错图替换**：章节内已有其它 `imgs/` 标记 → `[REPLACE]` 首个标记位置替换为新图，其余多余标记行删除（每章收敛到恰一张）。
3. **序号确定性映射**：文件名带序号（`01-x.png`/`1_x.png`/`图1-x.png`，正则 `^(?:图\s*)?(\d{1,3})(?=[-_.\s]|$)`）且唯一时——
   - mapping 模式：服务端按「序号 N → 第 N 个 ## 章节」重锚定，覆盖 LLM 给的 heading（防漂移），日志 `[NUMBER]`；
   - `--mode numbered`：无需 mapping，直接扫 imgs/ 生成映射；
   - `--mode auto`（默认）：有 mapping 用 mapping（序号覆盖仍生效），无 mapping 尝试 numbered。
4. **封面替换**：已存在 `![文章封面](其它路径)` 时原位替换为新封面（原来只会叠加第二张封面）。

配套：
- `article_insert_images_meta.js` 扫描 prompt 改为「序号优先：带序号图直接按第 N 章映射，禁止读图片内容；无序号图才语义匹配」；插入 prompt 同步新行为与统计行格式。
- `article_prepare.js` 检查点文案同步。
- P1 门禁 +4 条回归（`I2.rerun-idempotent` / `I2.wrong-img-replaced` / `I2.numbered-mapping` / `I2.numbered-override-bogus-heading`），全绿 46+21+24。

## 预防/注意事项

- 插入类脚本必须「读当前状态 → 对比 → 幂等/替换决策」，不能假设自己是首次执行；重跑收敛性应进门禁。
- 文件名/参数里已有确定性信息（序号、锚点）时，服务端必须重锚定，不能信任 LLM 转述——与 vault_ref_pinned_rel、canonicalize 同一设计原则。
- 输出契约行（`[OK]/[SKIP]/[FAIL]/=== ALL DONE ===`）扩展字段要加在中间（`skipped/replaced` 插在 `cover:` 前），末尾字面量保持不变，避免破坏下游正则。
- workflow 脚本（.js DSL）与 python 脚本均为运行时现读，改完**不需要**重启 PM2 服务；只有 registry/TS 源码变更才要 restart。
