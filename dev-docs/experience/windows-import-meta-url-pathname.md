# Windows 下 import.meta.url.pathname 导致双盘符路径（ENOENT）

> 日期：2026-10-21 · 发现于 WX-PT Part D 冒烟（router-eval 评测器）

## 问题现象

`npx tsx dev-examples/router-eval/evaluate.ts --mode fake` 在 Windows 报：

```
ENOENT: no such file or directory, open 'E:\E:\WorkProjects\...\routing-samples.json'
```

路径出现**双盘符** `E:\E:\...`。同样代码在 macOS/Linux 正常（外部会话开发时未暴露）。

## 排查过程

错误路径由 `path.join(here, "..", "wx-p1", ...)` 产生，`here` 来自：

```ts
const here = path.dirname(new URL(import.meta.url).pathname);
```

Windows 下 `import.meta.url` 为 `file:///E:/Work/.../evaluate.ts`，
`.pathname` 得 `/E:/Work/...`（**前导斜杠 + 盘符**）；`path.join` 将其按"以斜杠开头的路径"
处理，fs 读取时再相对当前盘符解析，拼出 `E:\E:\...`。

## 根因

`URL.pathname` 未做 Windows 路径转换；ESM 下取脚本目录的标准做法是
`fileURLToPath(import.meta.url)`（Node 官方 API，处理盘符/百分号编码/反斜杠）。

## 解决方案

```ts
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
```

同根因一次修完三处：`dev-examples/router-eval/evaluate.ts`、`router-eval/scale-experiment.ts`、
`wx-p1/evaluate.ts`（`src/` 无此模式，产品代码干净）。

## 预防/注意事项

- ESM 脚本取自身目录一律用 `fileURLToPath`，禁止直接用 `.pathname`（macOS/Linux 能跑，
  Windows 必坏——跨平台代码在单平台开发时此坑不可见）。
- 项目后续在 Windows 上做真机验收，正好兜住这类跨平台问题；评测器修复后 fake 模式
  90.5%（38/42）gate=PASS，报告正常落盘。
