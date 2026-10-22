# 全局 pi-workflow 的 wechat 命令族在非仓库目录下 tsx 解析失败

> 日期：2026-10-22 · 关键词：npm link、tsx reexec、ERR_MODULE_NOT_FOUND、cwd 包解析

## 问题现象

全局 `pi-workflow`（npm link 指向本仓库 `dist/`）在**其他项目目录**（如 `E:\WorkProjects\xc-flow`）执行
`pi-workflow wechat login` 报错：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from E:\WorkProjects\xc-flow\
```

更早的旧构建下则表现为另一个假象：旧版 `wechat` 不认识 `login` 子命令，落到 `start` 装配逻辑，
报"注册表为空：.pi-wechat\workflows.json"——与登录毫无关系，极具误导性。

## 排查过程

1. `wechat` 命令族因 thirdparties/pi-wechat-assistant 是纯 TS 源码（内部 `.js` 后缀互相 import，
   只有 tsx 能解析），plain-node 下 `reexecUnderTsx` 会用 `node --import tsx <仓库>/src/cli/index.ts wechat …` 重执行。
2. 重执行的 `--import tsx` 写的是**相对包名**，Node 按 **cwd**（调用目录）向上找 node_modules；
   在其他项目目录下自然找不到（tsx 只装在本仓库 devDependencies）。
3. 在仓库根内跑则一切正常——这正是"我这里好的、用户那里报错"的根因差异。

## 根因

`spawnSync(process.execPath, ["--import", "tsx", …], { cwd: process.cwd() })` 中两处目录语义错位：
入口脚本固定为仓库根的 `src/cli/index.ts`，但依赖解析却跟着 `cwd` 走。

## 解决方案

`src/cli/commands/wechat.ts` 的 `reexecUnderTsx`：用 `createRequire(<仓库根>/package.json).resolve("tsx")`
把 tsx 解析成**仓库内绝对路径**，再 `pathToFileURL(...).href` 传给 `--import`；
仓库未安装 tsx 时给出明确报错（"需先 npm install"）。`cwd` 保持调用目录不变
（`--registry`/`--data` 等缺省路径都是相对 cwd 的，语义不能动）。

## 预防/注意事项

- npm link 的全局 bin 在任意目录可用，但 `--import <包名>` 这类**运行时依赖解析永远跟着 cwd 走**；
  跨目录可用的 CLI 若要引仓库内依赖，必须先解析成绝对路径（file URL）。
- 子命令不存在时不要静默落进另一条命令的装配逻辑——旧版把未知子命令当 start 跑，
  报出的"注册表为空"掩盖了真实问题（新版本已改为打印用法 `<login|start>`）。
- 复现/回归：任意非仓库目录执行 `pi-workflow wechat login`，期望输出凭据信息或出扫码二维码，exit=0。
