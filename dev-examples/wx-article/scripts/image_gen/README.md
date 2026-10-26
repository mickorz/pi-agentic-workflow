# image_gen — 公众号两阶段生图执行器（Node）

需求来源：`dev-docs/planning/AI配图生成两阶段执行（article_image_generate）需求文档（V1.0）.md`（P1.5 已实现，见其第九节）。
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
lib/providers/pi-ai.mjs   实验轨：@earendil-works/pi-ai（openrouter，未真实调用）
test/executor.test.mjs    A01–A15 + P15-1~8 验收用例（node --test）
test/test_a09_recovery.py SIGKILL/SIGINT 中断恢复套件（真进程）
test/helpers/test-provider.mjs  注错+计数测试 provider
```

## 用法

```bash
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

## Provider 配置

| 轨道 | 环境变量 | 说明 |
|---|---|---|
| pi-image-gen（缺省） | `IMAGE_GEN_API_KEY`（必填）、`IMAGE_GEN_BASE_URL`、`IMAGE_GEN_MODEL` | 智谱兼容层自动去掉固定 `n:1`（P0 坑） |
| fake | 无 | 确定性 PNG，零费用 |
| pi-ai | `OPENROUTER_API_KEY` | EXPERIMENTAL（未真实调用） |
| 自定义 | `--provider <module.mjs>` | 须导出 `generate()`（测试注入用） |

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
node --test test/executor.test.mjs        # 23 用例（A01–A15 + P15-1~8，~2min Windows）
python3 test/test_a09_recovery.py         # SIGKILL/SIGINT 恢复（~2min；Windows SKIP）
PI_WORKFLOW_INTEGRATION=1 npx tsx --test tests/integration/article-image-wechat-e2e.test.ts  # 微信链路两阶段仿真（仓根执行）
```
