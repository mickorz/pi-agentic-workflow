# CLAUDE.md

本仓库（pi-agentic-workflow）的开发过程文档管理规范。

## 开发文档目录：`dev-docs/`

`dev-docs/` 是本仓库专门保存开发过程文档的目录（随仓库提交同步，2026-10-26 起从 gitignore 移出）。

> 边界：仓库根 `docs/` 是**读者向**文档（随项目分发、README 链接引用）；
> `dev-docs/` 只服务开发过程，两者不混放。

### 规则

1. **所有开发过程文档必须放在 `dev-docs/` 目录下**，不要散落在仓库根目录或其他位置。
2. **新建文档时先判断类型**，放入对应类型的子文件夹；子文件夹不存在时按需创建。
3. 子文件夹按文档类型分类，命名使用小写英文和连字符（kebab-case），例如：

   | 类型 | 子文件夹 | 说明 |
   |------|----------|------|
   | 设计方案 | `dev-docs/design/` | 架构设计、技术方案、接口设计 |
   | 会议记录 | `dev-docs/meeting/` | 会议纪要、讨论记录 |
   | 问题排查 | `dev-docs/troubleshooting/` | Bug 分析、故障排查、复盘 |
   | 调研笔记 | `dev-docs/research/` | 技术调研、选型对比、学习笔记 |
   | 任务计划 | `dev-docs/planning/` | 任务拆解、进度计划、里程碑 |
   | 执行进度 | `dev-docs/progress/` | 阶段性进度总结、里程碑状态 |
   | 执行报告 | `dev-docs/progress-result/` | 阶段完整执行报告、验收结果（区别于 progress 的持续进度表） |
   | 使用指南 | `dev-docs/guides/` | 操作手册、环境搭建、工作流说明 |
   | 经验沉淀 | `dev-docs/experience/` | 踩坑记录、问题解决方案、经验教训 |

4. 若现有分类不适用，可新建类型子文件夹，但需保持命名风格一致，并在本文件表格中补充登记。
5. 文档统一使用 Markdown 格式，文件名应能体现内容，例如 `2026-10-03-workflow-design.md`。
6. **自动归类，无需询问**：发现 `dev-docs/` 根目录下有未归类的文档时，直接按内容判断类型并移动到对应子文件夹，不要向用户确认。

## 进度文件夹：`dev-docs/progress/` 与报告文件夹：`dev-docs/progress-result/`

`dev-docs/progress/` 专门用于记录项目阶段性执行进度；`dev-docs/progress-result/` 专门用于沉淀阶段完整执行报告（区别于 progress 的持续进度表：progress 是滚动维护的状态，progress-result 是一次成稿的阶段报告）。

### 规则

1. **阶段完成必须记录**：每完成一个阶段/里程碑，必须更新进度文档，不得只提交代码不更新进度。
2. **双文件夹同步更新**：每次执行完一个里程碑，除更新 `dev-docs/progress/` 外，还必须同步更新 `dev-docs/progress-result/` 中的对应阶段执行报告（新建或追加）。两个文件夹缺一不可。
3. **每阶段独立报告文件**：阶段报告按阶段命名（`P0-执行报告.md`、`P1-执行报告.md`、`P2-执行报告.md`...），**新阶段内容必须写入新文件，禁止向其他阶段的报告文件追加**（含 `cat >>`）。已完成阶段的报告视为只读；报告内引用其他阶段（如"P2 方向"）允许，但不承载其他阶段的执行记录。
4. **进度文档要求维护到位**：更新 `dev-docs/progress/执行进度.md`（持续维护的总进度文档）中的里程碑状态表，并视情况为该阶段新建独立进度/验收文档；记录内容包括：完成时间、交付清单、commit 记录、经验索引、遗留问题。
5. **进行中也要反映**：阶段启动、中途重要节点（如架构决策、验收通过/失败）都应同步到进度文档，保证文档与仓库实际状态一致。
6. 新的进度文档放入本文件夹，命名体现阶段或日期，例如 `P0-验收报告.md`、`2026-10-03-执行进度.md`。

## 经验文件夹：`dev-docs/experience/`

`dev-docs/experience/` 专门用于沉淀开发过程中遇到的坑点和解决方案。

### 规则

1. **遇到坑必须记录**：开发中碰到坑（如环境问题、依赖冲突、隐蔽 Bug、反直觉行为等）并解决后，将问题现象、原因分析、解决步骤记录到 `dev-docs/experience/` 下，一篇文档记录一个问题。
2. **解决问题前先查经验**：每次遇到问题时，必须先到 `dev-docs/experience/` 下查找是否之前碰到过类似问题：
   - 若有记录，优先按已有经验尝试解决，解决后视情况补充更新原记录（如新的解决方法、适用版本变化）。
   - 若无记录，解决完成后再将完整过程沉淀为新文档。
3. 经验文档建议结构：**问题现象 → 排查过程 → 根因 → 解决方案 → 预防/注意事项**，文件名体现问题关键词，例如 `node-version-conflict.md`。

## 示例目录：`dev-examples/` —— 开发期沙盒

1. 开发中的脚本试验、联调配置与临时输出一律放 `dev-examples/`（一主题一子目录，kebab-case），
   **不对读者负责**，内容可随时失效或删除，不进 README 宣传、不被其他文档引用。
2. 运行产物一律 gitignore 不提交；详细约定见 `dev-examples/README.md`。
3. 毕业路径：`dev-examples/` 里验证通过 → 合入正式代码 → 必要时在 `docs/` 落地读者向文档 → 删除沙盒里对应目录。

## 脚本语言约定：一律 Python（跨平台）

工程内的可执行脚本（门禁、冒烟、演示、故障注入、文章处理工具等）**一律用 Python 编写**，
不再新增 sh/bash/PowerShell（.sh/.ps1）脚本。

1. **理由**：Mac 与 Windows 双环境运行（文章线脚本历史上因 Windows pwsh 在 Mac 不可用而阻塞），
   Python 3 跨平台一致，且两侧都开箱即用（macOS 自带 `/usr/bin/python3`，Windows 装 Python 即有）。
2. **只用标准库**：不引入第三方依赖（用 `urllib`/`re`/`subprocess`/`pathlib`/`json` 等）。
3. **shebang 与调用**：脚本首行 `#!/usr/bin/env python3`；workflow（js DSL）里调用统一用
   `python3 <脚本>.py`，参数用命名式（`--article-dir ...`）而非位置参数。
4. **输出契约**：脚本与人/Agent 的协议靠 stdout 文本（如 `[OK]`/`[SKIP]`/`[FAIL]`/`=== ALL DONE ===`），
   改写时必须保持既有输出契约不变，下游 prompt/断言依赖这些字面量。
5. **存量迁移**：历史上遗留的 .sh/.ps1 已全部改写为同名 .py；发现漏网的直接改写，不再修旧脚本。
6. **平台差异注意**：信号/进程组语义在 Windows 受限（见 `dev-docs/experience/windows-signal-semantics-stop.md`），
   需要真进程信号的用例在脚本内显式跳过不适用平台并输出 SKIP，不要静默假 PASS。

### 例外登记：image_gen 执行器用 Node（2026-10-24，公众号批量生图 P0 定案）

`image_gen/`（通用层批量生图执行器）用 Node（.mjs）而非 Python，理由与边界：
1. **依赖只在 Node 生态存在**：Provider 库 `@amaster.ai/pi-image-gen`（5 种 wire format、非破坏落盘、
   参考图/尺寸/批量参数面）与 `@earendil-works/pi-ai` 均为 npm 包，无 Python 等价物（P0 双轨验证定案）。
2. **仅限执行器本体**：输入/输出契约仍走文件（image-prompts.json / image-manifest.json / 图片文件），
   stdout 维持 `[OK]/[FAIL]/[SKIP]` 文本契约不变；与 Python 侧（文章锁、insert_images.py）通过
   **同协议锁文件**互操作（`image_gen/lib` 的 Node 锁与 `draft_manager/article_lock.py` 互拍，P0 T0.7 5/5 验证）。
3. Python 3.9 兼容注意：本仓脚本仍需兼容 `/usr/bin/python3` 3.9（不用 `dict | None` 语法，用 `typing.Optional`）。
4. 方案背景：`dev-docs/planning/2026-10-23-公众号批量生图接入执行方案.md` D1；验证证据：
   `dev-docs/progress-result/P0-执行报告.md`。

## 手动测试约定：全局命令与默认模型

后续所有手动测试（文档与实际执行）统一遵循以下方式，方案详情见
`dev-docs/design/2026-10-20-manual-test-global-cmd-model-config.md`：

1. **命令一律用全局指令 `pi-workflow`**：仓库根执行一次
   `npm ci && npm run build && npm link`（bin 符号链接指向仓库 `dist/`，rebuild 后自动生效，无需重复 link）。
   禁止再写 `WF="node ../../dist/cli/index.js"` 这类相对路径变量。
2. **模型一律走本地 JSON 配置，不传 `--model`**：默认模型读取
   `~/.pi/agent/settings.json` 的 `defaultProvider` + `defaultModel`
   （项目级 `.pi/settings.json` 可覆盖，需 project trust）。
   换默认模型直接改该文件，不改测试命令；仅临时试验才显式 `--model provider/modelId`。
3. **link 前必须先 build**：bin 指向 `dist/cli/index.js`，未构建直接 link 会报找不到模块。
4. **时序类/难手动的用例程序化为 Python 脚本**：涉及信号、强杀时机、跨进程 stop、等待窗口等
   不好手动控时序的用例，参照 `dev-examples/manual-test/run-resume-suite.py` 与
   `run-stop-signal-suite.py` 写成可重复执行的 Python 脚本（逐断言输出 PASS/FAIL，结尾汇总 PASS/FAIL 计数），
   由 agent 直接执行验证，不依赖人工盯梢。平台语义差异（如 Windows 下 SIGINT/stop 行为、
   MSYS kill 限制）见 `dev-docs/experience/windows-signal-semantics-stop.md`。
5. 新增手动测试文档/脚本沿用同样写法，参考 `dev-docs/guides/2026-10-19-v1-v2-manual-test.md`。
6. **微信工作流验收门（WX-MOCK，2026-10-27）**：新工作流或涉及 Router/Registry/授权/执行器的改动，
   必须先过 mock 验收（Gate B）再考虑真机抽检（Gate C）：
   ① 场景文件 `dev-examples/manual-test/wechat-mock/scenarios/<workflowId>.json` 与工作流同 PR 提交；
   ② registry 注册项必须 enabled 且 keywords 含 ≥2 个短词（检索语义为 query-contains-keyword，
      P1.6 教训：长词/未启用会静默拦空）；
   ③ 运行 `python3 dev-examples/manual-test/wechat-mock/engine.py --scenario <场景文件>`
      全 PASS 才算 Gate B 过；失败时先读 report.json（caseId/expected/actual/stage）再动手；
   ④ 超时纪律：单步 180s 硬上限，特殊步骤 ≤300s 且须在场景声明 special+理由；
      超时是诊断信号不是重试信号——先看转储的 bot 最后回复与 pending 清单；
   ⑤ deterministic 模式（Stub 路由，零 LLM）做高频回归；integration 模式（真实 LLM）
      只用于语义路由/真实 Agent 链路验收；
   ⑥ mock 实例用独立 `--data` 目录，与 pm2 生产服务并存互不触碰。
   设计与场景规范见 `dev-docs/design/2026-10-27-wechat-mock-标准化验收流程设计.md`
   与 `dev-examples/manual-test/wechat-mock/README.md`。

<!-- 本项目为工作流研发项目（参考 opencode-dynamicworkflows），opencode run 联调约定适用；
     当前处于研究初期，暂以注释保留，待实际引入 opencode run 联调时启用。

## opencode run 测试约定

1. **并发上限：最多同时运行 2 个 `opencode run` 用例**。需要更多用例时排队分批跑。
2. 验收类长任务前先预热检查模型可用：`opencode run --model <model> "只回复 ok"`。
3. 每个 run 必须配看门狗：记录直连 PID，超时 `pkill -P $pid` + `kill $pid`；agent 链（feature-development 等）预算 ≥20 分钟，短 flow 5–8 分钟。
4. 证据优先级：journal + traceDir 文件 > stdout（stdout 可能截断或乱码，验收以落盘证据为准）。
5. 完整配方见 `dev-docs/experience/opencode-run-hang-watchdog.md`。

-->
