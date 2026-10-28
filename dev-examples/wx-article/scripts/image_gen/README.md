# image_gen — 公众号两阶段生图执行器（Node）

需求来源：`dev-docs/planning/AI配图生成两阶段执行（article_image_generate）需求文档（V1.1）.md`（P1.5 已实现，见其第九节）。
语言例外已登记 CLAUDE.md「脚本语言约定」：本目录为 Node 例外区（依赖只在 Node 生态）。

## 两阶段模式（P1.5，缺省 require_style_approval 开启）

```
preview（试生成）              只跑 1 张代表图（首个 body；--preview-id 覆盖），
  └→ 固定单次请求不重试          成功后写入 style_approval 绑定指纹
--approve-style（风格确认）     preview_completed → approved（绑定校验；
  └→ 绑定: 风格+预览提示词+模型+参考图  输入一变自动失效回 pending）
batch（批量）                  需审批通过（否则 exit 2）；付费授权由上层 checkpoint/网关把守；
  └→ max_images_per_run 分批     受 max_images_per_run / budget 硬门约束
regenerate（单张重做）          需 --only-ids，走 candidate 链（原图隔离）
```

## 组成

```
generate.mjs              主编排 CLI（校验→风格门/预算门→锁→reconcile→顺序生成→核验→汇总）
lib/validate.mjs          image-prompts.json 契约校验（D6）
lib/manifest.mjs          双状态机 manifest 引擎（D7：active + candidate 链；P1.5：unknown 态 + style_approval 绑定）
lib/verify.mjs            文件核验 + Manifest↔文件双向核验（A13）
lib/lock.mjs              文章锁（与 Python draft_manager/article_lock.py 同协议，T0.7 5/5）
lib/providers/fake.mjs    零依赖确定性 PNG（cover 900×383 / body 1024×576）
lib/providers/pi-image-gen.mjs  真实轨：@amaster.ai/pi-image-gen（缺省智谱 cogview-3-flash）
lib/providers/image-use.mjs   订阅轨（P1.6）：ChatGPT web 后端（vendored thirdparties/image-use，零 API 计费；决策树分类/提交标记判据/路径契约，方案 V3）
lib/providers/pi-ai.mjs   实验轨：@earendil-works/pi-ai（openrouter，未真实调用）
test/executor.test.mjs    A01–A15 + P15-1~8 验收用例（node --test）
test/test_a09_recovery.py SIGKILL/SIGINT 中断恢复套件（真进程）
test/helpers/test-provider.mjs  注错+计数测试 provider
```

## 用法

```bash
node image_gen/export-review.mjs --article-dir <dir>                              # 审批文档（每张图完整提示词成稿+状态回填）
node image_gen/generate.mjs --article-dir <dir> --mode preview --provider fake    # 试生成 1 张
node image_gen/generate.mjs --article-dir <dir> --approve-style                   # 风格确认锁定
node image_gen/generate.mjs --article-dir <dir> --mode batch --provider fake      # 批量（需审批通过）
node image_gen/generate.mjs --article-dir <dir> --mode regenerate --only-ids term-03  # 单张重做
node image_gen/generate.mjs --article-dir <dir> --dry-run                         # 计划（含风格门/估算）
node image_gen/generate.mjs --article-dir <dir> --verify-only                     # 双向核验
IMAGE_GEN_API_KEY=... node image_gen/generate.mjs --article-dir <dir>             # 真实（智谱）
```

输入：`<article_dir>/image-prompts.json`（唯一输入）：
`{version:1, article_id, style_prefix, items:[{id, kind:cover|body, heading, prompt, filename}]}`

输出：
- 封面 `<dir>/cover.<ext>`（实际扩展名由 provider 返回格式决定）
- 正文 `<dir>/imgs/<filename>`
- 状态 `<dir>/image-manifest.json`（双状态机，`--verify-only` 可终审）

stdout 契约：`[FAIL]`→exit 2（含风格门/预算拦截）；`[LOCKED]`→exit 3；
`[IMG ok|fail] <id> attempts=<n>`（fail 含 `uncertain:扣费不确定` 标记）；
`[PLAN] <json>`（dry-run，含 mode/style_gate/cost）；`[RESULT] <json>`→exit 0|1；SIGINT→exit 130。

## 预算与扣费不确定（P1.5-C/D）

| 参数/机制 | 语义 |
|---|---|
| `--max-images-per-run <n>` | 单次运行张数硬上限，超出留 pending 分批再跑 |
| `--max-attempts-per-image <n>` | 单张请求次数上限含首次（默认 3；`--max-retries` 为废弃别名） |
| `--price-cny` / `IMAGE_GEN_PRICE_PER_IMAGE` | 单张单价（估算展示用） |
| `--budget-cny <x>` | 预算硬门：最坏估算（张数×单价×尝试上限）超预算 → exit 2 零请求 |
| 超时/连接中断（`E_TIMEOUT`/`ETIMEDOUT`/`ECONNRESET`…） | 扣费不确定：单次尝试即停、整跑暂停转人工，条目置 `unknown` 禁自动重试；人工核对后 `--retry-unknown` 显式解冻（文件恰好有效则自动恢复 succeeded） |

只自动重试「明确可恢复且明确未计费」的错误（429/限流/连接拒绝/5xx）；
超时类一律不重发（与文章流水线 P0 unknown 同思想）。

## 风格审批状态机（manifest.style_approval）

```
none → preview_completed（--mode preview 成功后写入绑定指纹） → approved（--approve-style）
任何输入因子变化（style_prefix / 预览条目 prompt / 模型指纹 / 参考图哈希）→ 自动失效回 pending
batch 门（require_style_approval 默认开）: 非 approved 或指纹不匹配 → exit 2
逃生口: --no-require-style-approval（测试/运维；微信链路不走此口）
```

## 文字验收状态机（manifest.entries[].content_review，IMG-L T4）

条目声明 `expected_text`（image-design-plan.json → compile.mjs 透传，纯验收元数据**不进 prompt**）
且生成成功 → content_review 置 pending，绑定图片 sha256 + 要求哈希：

```
生成成功 → pending（绑定 image_sha256 + requirements_hash）
--approve-text <id> / --reject-text <id> → approved / rejected（锁内 RMW，零请求）
失效（均回 pending，不自动重发请求）：图片重生成提升 / 文件 sha 变化 / expected_text 变化
纯改 expected_text 不触发重新付费生图（它不进 prompt_hash，审核失效 ≠ 生成失效）
```

质量门在消费侧：`draft_manager/check_state.py` 对 pending/rejected/sha 不符的条目阻断 prepare_ready
（路径断裂仅提示不阻断，T0 取证：下游重命名是现网常态）；summary 输出 `text_pending_review` 与
`text_rejected_ids` 供发布流程阻断。

背景：T0 初版曾将某文章目录的手动生成图误判为执行器产物并据此判定"零字约束失效"（已修正作废）。
文字策略采用"指定字 + 人工审核"方向，依据是日报卡点 2（用户手动使用经验：要求带字缺字）
与负向约束遵循度不稳定的业界常识；模型真实遵循度待执行器真机跑批重取证据。

## 证据链与度量（IMG-L T3/T5）

manifest 条目证据字段（全 optional，五类事件一致：主链成功/候选生成/候选提升/失败/unknown 恢复）：

| 字段 | 写入时机 | 说明 |
|---|---|---|
| `duration_ms` | 成功（provider 口径）/ 失败（尝试累计） | 单图耗时证据 |
| `error_code` | 失败/unknown | 统一错误属性（即失败分类，provider code 透传） |
| `evidence_log` | 失败 | 受限日志引用 `.image-gen-logs/<runId>-<id>-a<n>.log`，含完整 message 与 provider 诊断尾部（image-use 的 stderr 尾部含会话 URL，供 unknown 人工 recover；**不进 manifest 正文**） |
| `provider`/`model` | 成功/提升/导入 | `--resolve-unknown` 导入记 `manual`/`manual-import` |

度量（summary）：`exec_duration_ms`（锁前→summary，评估链路优化收益，不含审批等待）与
`wall_duration_ms`（进程→退出）分列；`human_action_required`（unknown/budget 停转/文字待审/已拒/预览待确认
计数和）与 `human_actions_completed_total`（manifest.actions_log 台账长度；approve-style/approve-text/
reject-text/resolve-unknown/promote 均登记）分列。风格审批门提前退出时也输出带度量的 RESULT（计数缺口修复）。

## Provider 配置

| 轨道 | 环境变量 | 说明 |
|---|---|---|
| 真实 provider（缺省） | `IMAGE_GEN_API_KEY`（必填）、`IMAGE_GEN_BASE_URL`、`IMAGE_GEN_MODEL` | **任何 OpenAI API 格式端点即插即用**（三件套配置，无需改代码）；智谱缺省 cogview-3-flash，智谱兼容层自动去掉固定 `n:1`（仅智谱域名生效） |
| image-use（P1.6，ChatGPT 订阅 web 后端，零 API 计费） | `IMAGE_USE_PYTHON`（缺省 win32 用 python 否则 python3）、`IMAGE_USE_SCRIPT`（缺省 thirdparties/image-use/image-use，**git submodule pin 7f97846=上游 v0.34.5**，检出 SHA256 a2ed5279；升级=重新 pin+四件套重登记+IU 回归）、`IMAGE_USE_TIMEOUT_MS`（缺省 330000）；`IMAGE_GEN_SIZE`/`IMAGE_GEN_INTER_DELAY_MS`（建议 30000）共用 | 前置：chrome-use + 登录 chatgpt.com 的 Chrome（长驻进程需在 chrome-use 安装后重启）；错误分类见方案 V3 决策树；**unknown 恢复红线：导入一律走 `--resolve-unknown`，禁止 `--retry-unknown`（那是放弃原图重新发请求）** |
| fake | 无 | 确定性 PNG，零费用 |
| pi-ai | `OPENROUTER_API_KEY` | EXPERIMENTAL（未真实调用） |
| 自定义 | `--provider <module.mjs>` | 须导出 `generate()`（测试注入用） |

## unknown 条目的受控导入（P1.6）

image-use 的 web 后端存在"已提交未确认出图"（含提交后中断）：条目进 unknown 后，人工用
`image-use recover <会话URL> -o <tmp>.png` 从原会话补捞图，再受控导入：

```bash
node image_gen/generate.mjs --article-dir <dir> --resolve-unknown <id> --from <tmp>.png
```

顺序：锁 → 条目/目标校验 → 同目录临时文件 → 核验 → 幂等快路径或 bak+原子替换 → manifest 落盘（失败保留证据，重入幂等收敛）。
**红线：`--retry-unknown` 语义是放弃原图重新发请求，禁止用于导入恢复。**

## 锁与互斥矩阵（D5/T1.7）

锁文件 `<article_dir>/.publish.article.lock`，协议与 Python 侧一致
（O_EXCL 排他 + 死进程接管 + 活锁拒绝；T0.7 跨语言 5/5 验证）。锁内 PID = 长存活执行进程本身。

| 操作 | 生图 generate.mjs | 插图 insert_images.py | 发布 publish.py |
|---|---|---|---|
| 生图 | 互斥 | 互斥 | 互斥 |
| 插图 | 互斥（T1.7 补） | 互斥 | 互斥 |
| 发布 | 互斥 | 互斥 | 互斥 |

`article_humanize`/`article_collect` 等纯读/独立产物操作不在矩阵内（沿现状）。

## 测试

```bash
cd dev-examples/wx-article/scripts/image_gen
node --test test/executor.test.mjs        # 43 用例（A01–A15 + P15 系列 + IU 系列，~2min Windows；IU-7c 真进程 SIGINT 用例 POSIX only，Windows 显式 SKIP）
python3 test/test_a09_recovery.py         # SIGKILL/SIGINT 恢复（~2min；Windows SKIP）
PI_WORKFLOW_INTEGRATION=1 npx tsx --test tests/integration/article-image-wechat-e2e.test.ts  # 微信链路两阶段仿真（仓根执行）
```
