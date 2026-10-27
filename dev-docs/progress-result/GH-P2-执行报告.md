# GH-P2 执行报告：GitHub fetch 图片本地化拖死根治 + 失败消息错误可见性

- 日期：2026-10-27
- 范围：`dev-examples/wx-article/scripts/github_kb.py`、`dev-examples/wx-article/scripts/github_research.js`、`dev-examples/videodigest/scripts/videodigest_extract.js`、`dev-examples/wx-article/scripts/run_github_kb_suite.py`
- 触发：用户微信报「分析 GitHub 仓库 cathrynlavery/diagram-design」两次失败 + videodigest-extract 失败通知看不到原因（m01122/m01242）

## 一、问题与根因

### 1. github_kb fetch 无限挂死（diagram-design）
- README 54 个图片引用；相对路径图走 raw.githubusercontent.com，本网络限速 ~3KB/s。
- `urlopen(timeout=30)` 只限单次阻塞读 → 持续慢滴流可无限拖长；54 图总时 >> 工作流 180s 命令超时被杀。
- manifest 循环后才落盘 → 被杀零进度 → 重发从头再挂（死循环放大器）。
- 既有 MAX_IMAGES/单图 8MB/总量 50MB 上限均不约束总时间。

### 2. 失败通知无真因
- adapter fail() 把「失败 [step] message | details」打在 stderr 末行、stdout 有结构化 {ok:false,error}；工作流 runJson/kb 却取 stderr 首 300 字符 → 全是链接解析等无害前奏。
- run-monitor（src/dispatch/run-monitor.ts）300 字符截断是合理展示层约束，信息在工作流层已丢。

### 3. videodigest CDP 抓取瞬时故障
- 20:38/20:49 两次失败均为 CDP 方案 B 打开视频页阶段瞬时故障（风控/慢载）；手动复现一次成功（31.6s）。

## 二、交付

| # | 变更 | 说明 |
|---|------|------|
| 1 | github_kb.py 图片阶段总预算 | `budget_deadline=time.monotonic()+_image_budget_s()`，图与图之间检查，超预算 skipped 保留远程 URL；默认 60s，env `GITHUB_KB_IMG_BUDGET_S` 现读 |
| 2 | github_kb.py 单图墙钟 | `_http_download` 改分块读（64KB）逐块查墙钟；默认 30s，env `GITHUB_KB_IMG_PER_IMAGE_S`；错误「单图下载超时（墙钟 Ns，疑似限速慢滴流）」 |
| 3 | github_research.js fetch 超时 | `kb(action, flagArgs, timeoutMs=180_000)` 第三参；fetch 传 300_000（最坏 ≈40+60+30=130s，余量充足） |
| 4 | kb() 错误提取 | stdout JSON {ok:false,issues:[]} 优先 → stderr 首尾拼接（150+250 单行化）兜底 |
| 5 | videodigest runJson 错误提取 | stdout `j.error` → `'[step] message \| details'`（details 截 200）；兜底 briefTail |
| 6 | videodigest 音频提取重试一次 | 首败 log 原因 → `commandSuccess(PY+' -c "import time; time.sleep(10)"', 20_000)`（沙箱无 sleep）→ 二次尝试 40min 超时 |
| 7 | github_research 全局失败兜底 | main() 包裹 + `ctx={pid,phase,notified}` + `ph()` 包装 phase()；catch → 非拒绝/abort 且未通知过 → `notifyWechat('failed', 'GitHub 研究失败[阶段]（pid）: reason。…重试/force 指引')` 再 rethrow |
| 8 | 门禁 2c/2d | 预算（monkeypatch 慢下载 2.5s×4、预算 1s → downloaded=1/skipped=3）+ 单图墙钟（monkeypatch urlopen 永不 EOF 慢滴流 → failed=1、1.2s 截止） |

## 三、验证

- 门禁 `run_github_kb_suite.py` **61/61 PASS**（含真实网络冒烟）。
- diagram-design `--force` 真机：**无限挂死 → 1m10s 收敛**（24 下载/28 预算跳过/2 墙钟失败，manifest complete:true 落盘于 .incoming/diagram-design）。
- github_research 复用路径真机回归：run-mvqrgtln-a666 `ok:true, reused:true`（main/ph/kb 重构未破坏主链路）。
- videodigest 缓存预热：7701294949379796345（工作流 workdir 已有 transcript.json）+ 7701316170171859443（手动 extract --workdir 到 `dev-examples/videodigest/work/douyin_7701316170171859443/`，cached:true）——用户重发两链接均缓存命中秒完成。
- 两 DSL `pi-workflow validate` valid:true。运行时现读（DSL/py），**无需重启 PM2**（adapter dist 未改）。

## 四、遗留

- outbox.jsonl 重复条目观察（201 条中 67 组 pending+sent 双份、3 条 failed）——疑似 flush 回写方式问题，待独立核查。
- m01004 文章《未来的软件公司，可能不再招前端和后端了》生图+prepare 挂起：等用户选定生图凭据解锁方式（本机 codex login / Windows 侧跑 / 装 chrome-use / 智谱 key）。
- 单图墙钟默认 30s 在极端限速下会把大图标 failed（budget 优先跳过不标错）；可用 env 放宽，不影响档案完整性（README 保留远程 URL，download-images 可补）。

## 五、经验沉淀

- `dev-docs/experience/2026-10-27-github-kb-fetch-image-budget.md`（慢滴流三层防御）
- `dev-docs/experience/2026-10-27-workflow-error-visibility-stderr-tail.md`（错误提取姿势 + 沙箱无 sleep）
