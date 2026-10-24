# image_gen — 公众号批量生图执行器（Node）

需求来源：`dev-docs/planning/2026-10-23-公众号批量生图接入执行方案.md`（V1.1）。
语言例外已登记 CLAUDE.md「脚本语言约定」：本目录为 Node 例外区（依赖只在 Node 生态）。

## 组成

```
generate.mjs              主编排 CLI（校验→锁→reconcile→顺序生成→核验→汇总）
lib/validate.mjs          image-prompts.json 契约校验（D6）
lib/manifest.mjs          双状态机 manifest 引擎（D7：active + candidate 链）
lib/verify.mjs            文件核验 + Manifest↔文件双向核验（A13）
lib/lock.mjs              文章锁（与 Python draft_manager/article_lock.py 同协议，T0.7 5/5）
lib/providers/fake.mjs    零依赖确定性 PNG（cover 900×383 / body 1024×576）
lib/providers/pi-image-gen.mjs  真实轨：@amaster.ai/pi-image-gen（缺省智谱 cogview-3-flash）
lib/providers/pi-ai.mjs   实验轨：@earendil-works/pi-ai（openrouter，未真实调用）
test/executor.test.mjs    A01–A08/A11/A13/A14 + A09 前置（node --test）
test/test_a09_recovery.py SIGKILL/SIGINT 中断恢复套件（真进程）
test/helpers/test-provider.mjs  注错+计数测试 provider
```

## 用法

```bash
node image_gen/generate.mjs --article-dir <dir> --provider fake          # 测试
node image_gen/generate.mjs --article-dir <dir> --dry-run                # 计划
node image_gen/generate.mjs --article-dir <dir> --verify-only            # 双向核验
IMAGE_GEN_API_KEY=... node image_gen/generate.mjs --article-dir <dir>    # 真实（智谱）
```

输入：`<article_dir>/image-prompts.json`（唯一输入）：
`{version:1, article_id, style_prefix, items:[{id, kind:cover|body, heading, prompt, filename}]}`

输出：
- 封面 `<dir>/cover.<ext>`（实际扩展名由 provider 返回格式决定）
- 正文 `<dir>/imgs/<filename>`
- 状态 `<dir>/image-manifest.json`（双状态机，`--verify-only` 可终审）

stdout 契约：`[FAIL]`→exit 2；`[LOCKED]`→exit 3；`[IMG ok|fail] <id> attempts=<n>`；
`[PLAN] <json>`（dry-run）；`[RESULT] <json>`→exit 0|1；SIGINT→exit 130。

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
node --test test/executor.test.mjs        # 15 用例（~12s）
python3 test/test_a09_recovery.py         # SIGKILL/SIGINT 恢复（~2min；Windows SKIP）
```
