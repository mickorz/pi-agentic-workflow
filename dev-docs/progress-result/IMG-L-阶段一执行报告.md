# IMG-L 阶段一执行报告（T6 修复 + T0 取证 + T1 验证）

> 日期：2026-10-28
> 依据：《生图链路遗留需求执行方案》V2（阶段一：先验证与小修，不扩大功能）
> 结论：阶段一三项全部完成。T2 依 T1 实测裁定缓行；阶段二入口为 T4（文字验收闭环）。

## 一、交付清单

| 任务 | 性质 | 交付物 | 状态 |
|---|---|---|---|
| T6 backend 校验与模型指纹修复 | 开发（1h 级） | `image-use.mjs` buildSettings 死代码修复 + `effectiveModel` 进指纹；`generate.mjs` 主链/候选链成功路径回写 `model_fingerprint/model/provider`；IU-14 新增；测试 44/44 绿 | ✅ commit 6b53b20 |
| T0 生图质量全链路取证 | 验证（零开发） | 三张样例五级链对照 + 根因模式 + 改进指向回填 | ✅ `dev-docs/troubleshooting/2026-10-28-T0生图质量全链路取证报告.md` |
| T1 会话复用四维验证 | 验证（真机 6 张） | 基线 vs keep-tab 四维对照报告 + T2 裁定 | ✅ `dev-docs/research/2026-10-28-T1会话复用四维验证报告.md` |

## 二、T6 修复内容（超出登记范围的一个连带 bug）

1. **登记内**：`buildSettings()` 校验移到 return 前（原不可达死代码且引用未定义 `cfg`）；settings 携带 `effectiveModel: backend`，模型指纹消费（切 `IMAGE_USE_BACKEND=codex` 后指纹 `image-use:codex` ≠ 旧 `image-use:web` → reconcile 判 stale 不复用）。
2. **连带发现并修复**：`entry.model_fingerprint` 此前**只在条目创建时写入，任何成功路径都不回写**——模型变更 → stale → 重生成成功 → 指纹停留旧值 → 下次 batch 再判 stale → **永久重复生成（重复计费）循环**（与 IU-13 修的 prompt_hash 同形态）。现主链与候选链成功路径均回写指纹及 model/provider。
3. **测试基建修复**：fake CLI normal 模式出图 64×48 → 1024×576（原尺寸压缩后 592-857B，在 verify 的 1024B 阈值边缘随 seed 波动，成功路径用例 flaky）。
4. 回归：`node --test test/executor.test.mjs` 44 pass / 0 fail（1 skip 为既有）。

## 三、T0 取证核心结论（阶段二 T4 的需求依据）——【2026-10-28 归属修正】

> **修正**：用户澄清取证样本为其手动生成，非执行器产物。初版"零字约束系统性失效 3/3"与
> "构图劫持 3/3"两条根因结论**作废**（prompt 对照无效）；T0 报告已修订（见 troubleshooting 同名文件修正版）。
> 仍成立：manifest 与文件系统 5/5 脱钩（根因修正为手动替换后陈旧）；日报卡点 2 为用户第一手经验。
> 模型真实遵循度待执行器真机跑批重取（已列入遗留）。
> T4 机制（expected_text + content_review 闭环）不依赖该根因结论，实现保留。

1. **零文字约束系统性失效（3/3）**：style_prefix 明确"不出现任何文字"，三张图分别出现 28/25/8 处文字且语义与 prompt 相关——模型主动把抽象卡片具体化为带标签信息图，负向约束在 web 后端基本无效。
2. **构图被"信息图模板"劫持（3/3）**：稳定输出"标题横幅+双面板+标签"结构，空间叙事要素（拆墙/递卡/中轴）全部缺失；风格层（机器人/配色/质感/比例）遵循良好。
3. **manifest 与文件系统证据链断裂（5/5 missing）**：下游发布管线重命名文件后 manifest 未同步——T3 需一并处理重命名解绑，否则 content_review 的 image_sha256 绑定同样会被破坏。
4. **封面叠字路线实证**：样例封面主标题为后期合成的干净排版（非生成）——"无字底图+确定性叠字"已是现网实践。
5. 样例量边界：3 张确认模式，不统计违规率。

## 四、T1 四维验证结论（T2 裁定依据）

| 维度 | 结论 |
|---|---|
| 标签页 | keep-tab 只改结束行为（不关 tab）；接管前段两组无差异 |
| 对话上下文 | **不复用**：两组每张都走完整新建对话流程（评审 P0-1 证实） |
| 耗时 | 均值 76s→57s 但差异由离群值驱动，不可归因；确定性收益仅省删会话 1-2s/张 |
| 稳定性 | 基线 1/3 删会话 CDP 超时（会话意外残留）；keep-tab 0/3 |

**T2 裁定：缓行**。判据"可量化缩短"不成立；日报卡点 3 的开关体感源自上游每张固定的 opening ChatGPT 动作，keep-tab 不解决。env 开关设计保留为 5 分钟级预备改造。

## 五、遗留与下一步

1. **阶段二（质量）**：T4 文字验收闭环——T0 已给出关键翻转依据：`expected_text` 应从"验证无字"翻转为"验证指定字"（接受"有字但须正确"），或走叠字路线；契约源头在 `image-design-plan.json`。
2. **阶段三（可观测）**：T3 证据链（含重命名解绑语义，T0 断裂实证）+ T5 度量口径。
3. 环境注记：workspace 分支（mickorz/image-use）无 thirdparties submodule 检出，T1 真机验证使用 E 盘 master 同一 pin 脚本。
4. 测试图 6 张与全量 stderr 时间线在 `/tmp/t1-verify/`（临时目录，不归档）。

## 六、commit 记录

- 6b53b20 fix(image-gen): T6 backend 校验死代码修复 + 模型指纹含 backend + 回写修复 + fake CLI 尺寸修复 + IU-14
- ac5978d docs(troubleshooting): T0 取证报告 + progress 登记
- （本次）docs: T1 报告 + T2 裁定回填 + 阶段一执行报告
