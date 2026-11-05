# pi-browser-use 报 ENOENT：nvm symlink 迁移导致运行中的 pi 持有死 execPath

日期：2026-10-30

## 问题现象

pi 启动时扩展报错：

```
Extension "C:\Users\zhangqi95\.pi\agent\npm\node_modules\pi-browser-use\dist\index.js" error:
Browser connection failed. MCP subprocess failed (ENOENT).
   at DevToolsClient.openConnection (...pi-browser-use\dist\client.js:120:19)
   ...
```

浏览器工具（browser_*）全部不可用。同时会话内 bash 的 `node -v`、`where node` 也找不到 node，
但 pi 本体和其他功能看起来正常。

## 排查过程

1. 读 `pi-browser-use/dist/client.js`：连接方式是 stdio spawn
   `[process.execPath, chrome-devtools-mcp入口, ...args]`（第 74-76 行）。
   `chrome-devtools-mcp@1.10.1` 包与入口文件都完整存在，手动用 bun/别的 node 跑 `--version` 正常。
2. `PI_BROWSER_USE_NODE` 环境变量未设置，排除自定义 node 路径。
3. `summarizeFailure` 表明 ENOENT 是 spawn 层失败（找不到可执行文件）。
4. `Get-CimInstance Win32_Process` 查看运行中的 pi 进程：命令行是
   `"C:\Program Files\nodejs\node.exe" D:\DevTools\npm-global/...cli.js`。
5. 但 `C:\Program Files\nodejs` 目录在磁盘上**已不存在**。
6. 查 nvm-windows 配置：`NVM_HOME=C:\Users\zhangqi95\AppData\Local\nvm`，
   `NVM_SYMLINK=C:\nvm4w\nodejs`（存在、有效，node v24.18.0，npm 齐全）。

## 根因

nvm-windows 通过 symlink 暴露当前版本：历史上 `NVM_SYMLINK=C:\Program Files\nodejs`，
pi 当时从该路径启动，`process.execPath` 被固化为这个绝对路径。之后 nvm 重装/重配，
symlink 迁移到 `C:\nvm4w\nodejs`，旧路径被移除。

运行中的 pi 进程还握着真实镜像文件的打开句柄（Windows 允许已打开的镜像继续运行），
所以 pi 本体不崩；但任何**新建 node 子进程**都走 `process.execPath` 这个死路径 →
CreateProcess 找不到 exe → ENOENT。pi-browser-use 是最直接的受害者（每次 connect 都要 spawn
chrome-devtools-mcp），会话内其他 node 子进程调用同样会受影响。

一句话：**注册表里的环境配置已经是好的，坏的是运行中的 pi 进程持有启动时固化的死 execPath。**

## 解决方案

1. 从新终端重启 pi（pi.cmd → PATH 查找 `node` → `%NVM_SYMLINK%`=`C:\nvm4w\nodejs` → v24.18.0）。
   新进程的 `process.execPath` 指向有效文件，pi-browser-use 连接恢复。
2. 无需改任何 PATH/注册表——机器当前配置本身已正确。
3. 验证：新终端 `node -v` 输出 v24.18.0；pi 启动无扩展报错；`/browser-setup` 能连上。

## 预防/注意事项

- 排查 ENOENT 类 spawn 失败时，先核对**正在运行的进程**实际用的可执行路径
  （`Get-CimInstance Win32_Process`），再核对磁盘上该路径是否存在，两者经常不一致。
- nvm-windows 机器上切换/重装 node 后，所有**运行中**的 node 进程（含 pi、pm2 托管服务）
  的 `process.execPath` 都可能变成死路径，需要重启才恢复。
- pi-browser-use 提供 `PI_BROWSER_USE_NODE` 环境变量可显式指定子进程 node，
  但只是绕过单点，execPath 失效影响面是全进程，根治靠重启 pi。
