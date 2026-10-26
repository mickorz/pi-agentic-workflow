# Windows 下 Node spawn 调用 .cmd/.bat 工具的三层陷阱（cdp-cli 为例）

> 日期：2026-10-26 · 发现于 videodigest Windows 真机冒烟（抖音 CDP 通道）

## 问题现象

adapter 在 Windows 上调 `cdp-cli` 报 `退出码 -1`（spawn 直接失败）；
换成 `cmd /d /s /c` 包装后又变成 yargs 报"缺 expression 参数"（参数被拆碎）。

## 排查过程

1. `where cdp-cli` 返回两行：`D:\DevTools\npm-global\cdp-cli`（npm 生成的无扩展名 sh 脚本）
   和 `cdp-cli.cmd`。`where` 把无扩展名行排在前面，adapter 取了第一个 → Windows spawn
   跑不了 sh 脚本 → 退出码 -1。
2. 修成 `.cmd` 后，Node 对 `.cmd` 必须走 shell 包装（Node 18+ 禁止直跑，EINVAL）。
   cookies.ts 已有 `wrap()` 用 `cmd /d /s /c [file,...args].join(' ')`，但同步调用点
   （eval/close 等）没走它，于是给 proc.ts `runSyncArgs` 加统一包装。
3. 包装后 yargs 又收不到参数：用 `node -e 'console.log(process.argv)'` 裸实验发现
   Node spawnSync 会**自动转义参数里的内嵌引号**（`"` → `\"`），`cmd /s` 剥外层引号后
   `\"` 被 CRT 当字面引号+空格边界，把 `(() => { return 1+1; })()` 拆成 8 个碎片。

## 根因

三层叠加：

1. `where` 探测结果里无扩展名 sh 脚本排在 `.cmd` 前，被误选；
2. Windows 不允许 spawn 直跑 `.cmd`，必须 `cmd /d /s /c` 包装；
3. Node spawn 默认对参数做 Windows 引号转义，与 cmd 包装叠加时**双重转义**破坏参数，
   必须加 `windowsVerbatimArguments: true` 让引号完全由调用方自管。

## 解决方案（proc.ts + tools.ts）

- `tools.ts probePath`：win32 下 `where` 结果优先选 `/\.(exe|cmd|bat)$/i` 的行；
- `proc.ts runSyncArgs`：win32 且目标是 `.cmd/.bat` 时统一包装
  `cmd /d /s /c` + `windowsVerbatimArguments: true`，参数经 `cmdQuote()`（含空白或
  cmd 元字符才套双引号）；
- **调用方契约**：经此包装的参数内不得含双引号（JS eval 脚本选择器等改用反引号+单引号，
  见 cdp-grab.ts GRAB_JS）。

## 预防/注意事项

- Windows 上 spawn npm 全局命令前先想这三层；照抄本条 proc.ts 实现即可。
- `cmdQuote` 的元字符集（空格 | & ^ % < > ( ) = ! ; , + "）是 cmd 的解析元字符，
  不在其内的参数裸传，避免引号滥用引发新问题。
- 相关：`windows-python-subprocess-gbk-and-python3-alias.md`（同为 Windows 子进程坑）。
