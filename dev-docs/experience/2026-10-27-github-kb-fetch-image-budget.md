# github_kb fetch 被 README 图片本地化拖死（限速慢滴流 + 零落盘死循环）

- 日期：2026-10-27
- 组件：`dev-examples/wx-article/scripts/github_kb.py`（fetch 图片本地化）、`dev-examples/wx-article/scripts/github_research.js`
- 关联：`dev-docs/experience/` 错误可见性修复（同日另一篇：失败消息只带 300 字符截断头，真因在 stderr 末尾）

## 问题现象

微信发「分析 GitHub 仓库 cathrynlavery/diagram-design」两次均失败：

```
run.failed error='command "github_kb fetch" 超时 (180000ms)，已 SIGTERM/SIGKILL 终止'
```

手动复现 `python3 github_kb.py fetch --root <KB> --url github.com/cathrynlavery/diagram-design` 挂 240s+ 不返回。
但四个 API 源（repos/readme/languages/git-trees）单独实测全部 0.7–4s 正常 → 挂点不在 API 抓取。

## 排查过程

1. `fetch_real` 之后 `cmd_fetch`（github_kb.py:535）做 README 图片本地化 `download_readme_images`（:445）。
2. diagram-design 的 README 有 **54 个图片引用**（img.shields.io/skills.sh 徽章 + docs/ 相对路径截图）。
3. 相对路径图走 raw.githubusercontent.com —— 本网络该域被限速 **~3KB/s**（实测 54KB README.md 下载 16.5s）。
4. `_http_download` 原实现 `resp.read(cap+1)`：`urlopen(timeout=30)` 的 timeout **只限单次阻塞读**，
   持续慢滴流（每块都在到达、永不超 30s 间隔）可以无限拖长一次下载。
5. 54 图 × (30s+) 总耗时 >> `github_research.js` 里所有 github_kb 命令共用的 `timeoutMs=180_000` → 工作流杀进程。
6. **致命放大器**：fetch-manifest 在图片循环结束后才写盘 → 被杀 = 零进度落盘 → 用户重发 → 从头再挂 → 死循环。
7. `MAX_IMAGES=60 / PER_IMAGE_CAP=8MB / TOTAL_CAP=50MB` 三个既有上限都不约束总时间。

## 根因

慢滴流下载 + 只有「图与图之间」的总量上限缺失 + manifest 循环后才落盘，三者叠加。

## 解决方案（三层防御，均已落地）

1. **图片阶段总预算**（`download_readme_images`）：`budget_deadline = time.monotonic() + _image_budget_s()`，
   每张图处理前检查，超预算 `stats["skipped"] += 1` 保留远程 URL。默认 **60s**，env `GITHUB_KB_IMG_BUDGET_S` 现读可调。
2. **单图墙钟上限**（`_http_download` 重写）：分块读 `resp.read(65536)` 循环，每块后查
   `time.monotonic() > deadline` →「单图下载超时（墙钟 Ns，疑似限速慢滴流）」。默认 **30s**，
   env `GITHUB_KB_IMG_PER_IMAGE_S`。这层挡住「最后一图在预算检查之后开始、自己拖几分钟」的漏网情况。
3. **fetch 命令超时独立放宽**：`github_research.js` 的 `kb(action, flagArgs, timeoutMs = 180_000)` 支持第三参，
   `kb('fetch', fetchFlags, 300_000)`。最坏路径 ≈ API 40s + 预算 60s + 末图 30s ≈ 140s，余量充足。

缺图不影响档案完整性：README 保留远程 URL 可读，事后 `download-images` 子命令可补图。

## 验证

- 门禁 `run_github_kb_suite.py` 新增 2c（预算：monkeypatch `_http_download` 慢 2.5s×4 图、预算 1s → downloaded=1/skipped=3）
  与 2d（单图墙钟：monkeypatch `urlopen` 返回永不 EOF 的慢滴流流 → failed=1、1.2s 截止）。全套 **61/61 PASS**。
- 真机收敛：diagram-design `--force` 重抓从无限挂死 → **1m10s 收敛**（24 图下载/28 预算跳过/2 墙钟失败，
  manifest 落盘 complete:true）。

## 预防/注意事项

- 任何「循环里做网络 IO + 结束才落盘」的结构都要给循环加墙钟预算 + 尽量增量落盘。
- `urlopen(timeout=)` 是 socket 级超时，不是总时长上限；要总时长必须自己分块 + 查 monotonic 时钟。
- 工作流 `command()` 的 timeoutMs 报错信息会进 run.failed → 用户可见，配合「stdout JSON 优先、stderr 兜底」的
  错误提取（见 github_research.js `kb()` 注释）可以给出人话原因。
