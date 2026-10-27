# 失败通知只见截断头、真因在 stderr 末尾（错误可见性三层修复）

- 日期：2026-10-27
- 组件：`dev-examples/videodigest/scripts/videodigest_extract.js`（runJson 错误提取）、
  `dev-examples/wx-article/scripts/github_research.js`（kb() + 全局失败兜底）、`src/dispatch/run-monitor.ts`
- 关联：同日 `dev-docs/experience/2026-10-27-github-kb-fetch-image-budget.md`（真因本身）

## 问题现象

用户微信收到：

```
❌「videodigest-extract」失败（tb-91615326）： Error: 音频提取 失败(退出码 1):
[adapter] 链接解析：https://www.douyin.com/video/7701294949379796345…（截断）
```

真实原因完全看不到。服务侧两次失败（20:38/20:49），手动跑同样的 extract 却一次成功。

## 排查过程

1. run-monitor 机制本身正常：`src/dispatch/run-monitor.ts` eff=failed → outbox 推送
   `summarizeFailure(manifest.error)`（多行压单行、**300 字符截断**）。
2. 但喂给它的 `manifest.error` 已经是坏的：`videodigest_extract.js` 的 `runJson` 在 exitCode≠0 时取
   **stderr 首 300 字符** —— 而 adapter（`dev-examples/videodigest/adapter/`）的 `fail()` 把
   「失败 [step] message | details」打在 **stderr 末行**，stdout 同时输出结构化 `{ok:false,error:{message,step,details}}`。
3. 也就是说：adapter 已经把结构化错误准备好了，工作流却去截 stderr 的头部 → 全是链接解析/工作目录等无害前奏。
4. `github_research.js` 的 `kb()` 同病：只取 stderr 首 300 字符。

## 根因

「stderr 头部 300 字符」对「错误在末尾/在 stdout JSON」的命令是错误提取姿势；
run-monitor 的 300 字符截断是合理的展示层约束，问题在工作流层把信息弄丢之前。

## 解决方案

1. **stdout JSON 优先**：exitCode≠0 时先 `JSON.parse(r.stdout)` 取 `j.error`，拼 `'[step] message | details'`
   （details 截 200）；解析失败再兜底 stderr **首尾拼接**（前 150 + 后 250，单行化）。两处工作流同款。
2. **videodigest 音频提取自动重试一次**：CDP 方案 B 打开视频页是瞬时故障高发点（抖音风控/页面慢载），
   首败 log 原因 → 跨平台等待用 `commandSuccess(PY + ' -c "import time; time.sleep(10)"', 20_000)`
   （**沙箱 globals 无 sleep/setTimeout**）→ 二次 `runJson('音频提取(重试)', …, 40*60*1000)`。
3. **github_research 全局失败兜底**：主体包 `async function main()`，`const ctx = {pid, phase, notified}` +
   `ph(t)` 包装所有 phase() 调用；末尾 `try { return await main() } catch (e)` → 未通知过且非
   「拒绝/abort」（人工拒绝 checkpoint 抛 `checkpoint 被人工拒绝：…`）时 `notifyWechat('failed', 'GitHub 研究
   失败[阶段]（pid）: reason。多为网络受限或步骤超时…')` 再原样 throw。配置缺失分支自带指引 → `ctx.notified = true` 防双推。

## 验证

- 两文件 `pi-workflow validate` valid:true。
- github_research 复用路径真机 run-mvqrgtln-a666：`ok:true, reused:true`（重构未破坏主链路）。
- adapter 手动 extract 两视频均成功且预热了工作流缓存（transcript.json 就位，用户重发同链接缓存命中秒完成；
  注意 **--workdir 必须与工作流一致**：`dev-examples/videodigest/work/<source>`，cwd 默认的仓库根 `work/` 不互通）。
- 门禁：`run_github_kb_suite.py` 61/61 PASS（含新 2c/2d 用例）。

## 预防/注意事项

- 工作流包装子命令时：**先看子命令的错误输出契约**（stdout JSON？stderr 末行？），别默认截 stderr 头。
- 「首尾拼接 + 单行化」是通用兜底：`briefTail(stderr, 150, 250)`。
- DSL 沙箱没有 sleep/setTimeout（`src/runtime/workflow-runtime.ts:1387` globals 白名单），
  等待用 python time.sleep 的 commandSuccess；validate 查不出未定义符号（只查语法），要真跑。
- adapter 类瞬时故障（风控/慢载）值得在工作流层做一次自动重试 + 重试前 log 首败原因。
