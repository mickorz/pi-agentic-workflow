# WT-P1 执行报告 —— 写作模板库·模板写作接入

> 阶段：WT-P1（方案 V1.2 第四节 P1）
> 完成：2026-10-28
> 结论：**确定性验收全绿**（Example 25 PASS + 工作流门禁 10 PASS + WX-MOCK 8 场景回归 + 主工程测试零失败）；真机 Gate C（微信完整跑一篇 + 中断恢复 + 内容对照）待用户配合执行。

## 一、交付清单

| 产物 | 路径 | 说明 |
|------|------|------|
| 模板读写器 | `dev-examples/wx-article/scripts/template_store.py` | 五子命令：allocate-id（versions 目录 O_EXCL 原子 mkdir）/ resolve（含"模板"后缀归一化）/ read-active（指针→版本两段读+哈希校验）/ snapshot（不可变+幂等 SKIP）/ restore（expect 哈希校验）；root 解析链 --root > WT_TEMPLATES_ROOT env > 配置 writing_templates_root |
| 自检脚本 | `dev-examples/wx-article/scripts/template_store_Example.py` | 25 断言全过（1 SKIP：symlink 本机无权限显式跳过），含恢复契约返回码映射与 idea_files YAML 往返 |
| 状态双白名单 | `draft_manager/idea_files.py` | STATE_SETTABLE 三键 + YAML_KEYS 顶层键（坑点已沉淀 experience） |
| 写作链接入 | `dev-examples/wx-article/scripts/idea_article_write.js` | template 可选参数；绑定/恢复统一入口（方案 §3.5/3.6.1 全部规则）；大纲/正文 prompt 注入；审稿 templateCheck/factCheck 独立字段；终态对齐现状闸门 |
| 工作流门禁 | `dev-examples/wx-article/scripts/run_wt_p1_gate.py` | W0-W9 十用例全过（零 LLM，早退分支+确定性 CHECK 停点手法） |
| registry | wx-article 源 + am-p0 聚合 | template 参数（提取语义 description）+ 实测稳定 examples；双源同步 |
| 经验沉淀 | `dev-docs/experience/idea-files-state-double-whitelist.md` | 双重白名单静默丢数据坑 + js 侧顶层键缩进坑 |
| 配置 | `.aws-article/config.json`（本地不入库） | writing_templates_root 指向 vault 模板库 |

## 二、验收结果对照（方案 §5.1 十项场景）

| # | 场景 | 载体 | 结果 |
|---|------|------|------|
| 1 | 不传 template 行为不变 | 门禁 W0（短 Brief 停点与改动前一致）+ 代码路径隔离（全部模板逻辑在 `args.template‖boundT` 条件内）| PASS |
| 2 | 有效 active 模板完成全链 | 门禁 W8 验证绑定前缀副作用；生成质量部分属 Gate C | 前半 PASS，后半待 Gate C |
| 3 | draft/retired/未知拒绝 | 门禁 W1/W2 + Example read.* 系列 | PASS |
| 4 | 中断期间模板升级仍用原版 | 门禁 W9（续写 restore 通过才进 agent）+ Example restore.expect-match；"升级 v2"真实变体待 Gate C | PASS |
| 5 | 越界/符号链接/损坏拒绝 | Example restore.outside / read.tampered / symlink(SKIP) | PASS |
| 6 | 模板与选题不适配可解释 | templateCheck 结构化 issues 进修复循环/报告；语义质量待 Gate C | 机制就绪，待 Gate C |
| 7 | YAML 落盘往返 | Example yaml.roundtrip-persisted | PASS |
| 8 | 修改文章模板继承 | 门禁 W5（不同 ID 拒绝）；modifyM 沿用快照属 LLM 路径待 Gate C | 前半 PASS |
| 9 | 首次绑定中途崩溃 | 恢复契约四象限实现（js 分派 + Example 断言返回码）；真实崩溃注入待 Gate C | 机制 PASS |
| 10 | 普通大纲后传模板拒绝 | 门禁 W4（template_late_bind 防混版） | PASS |

## 三、执行中的关键事件与裁定

1. **`--max-agents 0` 不设上限**（0=未设置语义）：门禁首版依赖它拦 agent 导致 W5 超时（300s 门禁纪律触发，停下排查）。修正手法：W8/W0 用短 Brief 让确定性 CHECK 在 agent 前停；W9 用 `--timeout 2000 --retries 0` 让审稿 agent 2 秒超时。门禁全程零 LLM。
2. **boundT 正则缩进坑**：顶层键 `writingTemplate:` 顶格、子键两空格；首版正则要求两空格缩进导致绑定检测恒 null，W5 走首次绑定路径真跑 LLM。已修（坑点入 experience）。
3. **路由提取抖动，消费端根治**：真实路由 dry-run 发现 LLM 提取不稳定（"变局应对认知长文模板"带后缀、后置词序漏提取）。裁定：不追路由 LLM 的一致性，`resolve` 做确定性归一化（剥尾部"模板"后缀重试一次，无模糊匹配）；registry examples 固化实测稳定话术形态；提取失败用户收到候选清单可重发（js 确定性拒绝兜底）。
4. **WX-MOCK 不新增场景的裁定**：deterministic 引擎只执行 fixtures 目录工作流（mock-echo 等），无法真实运行 idea_article_write；template 语义全在真实工作流与 Python 层。已交付物为：WX-MOCK 既有 8 场景全 PASS（registry/协议回归）+ 真实 registry 路由 dry-run（提取验证）+ 工作流门禁。Gate B 精神（注册项启用/关键词/参数提取/确定性拒绝）已由上述组合覆盖；完整语义路由与生成质量归 Gate C。
5. **清理**：超时事故遗留的根目录 4-outline.md/5-article.md 与两个 interrupted 测试 run 已删除；vault 灵感根无污染；thirdparties 子模块测试失败为 Windows 环境既有问题（基线同样失败，与本次改动无关），主工程 tests/ 零失败。
6. **并行会话协作**：本阶段工作曾被并行会话收进 commit 27438de（含 boundT 修复）；后续归一化与 registry 强化为本次收口提交。

## 四、Gate C 清单（待用户配合，真机微信）

1. 新建任务走完 idea-article-start/turn 到 brief_confirmed，消息「用变局应对认知长文模板写文章 <标题>」→ 验证路由提取 template + 首次绑定 + 快照。
2. outlineApproval 开启时大纲后中断，人工把 t-001 升级 v2（或不动），次日「确认大纲」→ 恢复用 v1 快照（sha 一致），全链完成 draft_ready。
3. 审稿报告含模板符合性/事实核查两节；如有待人工核实项，播报显式列出。
4. 内容对照（方案 §5.2）：同选题原链 vs 模板链各一篇，四项人工评估（结构/重复度/事实/修改耗时）——P2 启动门槛依据。

## 五、遗留与下一步

- Gate C 四项待用户真机执行（上节清单）。
- P2（article-template-extract 自动提取）维持条件启动：Gate C 内容对照达标（2-3 选题）才开发。
- 服务侧生效：微信 bot 生产服务用 am-p0 聚合 registry，需 `pm2 restart` 后新参数才生效（用户执行 Gate C 前重启）。
