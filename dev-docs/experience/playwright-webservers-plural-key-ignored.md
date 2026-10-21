# Playwright webServers 复数键被静默忽略（1.64）

## 问题现象

`web/playwright.config.ts` 里写 `webServers: [...]`（复数键，TypeScript 类型检查通过、`defineConfig` 不报错），`playwright test` 正常发现并运行测试，但 **webServer 一个都不启动**：无等待、无报错、无 DEBUG 输出，测试直接 `net::ERR_CONNECTION_REFUSED` 失败。且行为跨版本稳定复现（1.49/1.55/1.63/1.64 全部忽略）。

## 排查过程

1. 手动逐个起 4 个进程（2 API Server + 2 vite）全部 200 → 排除进程本身问题。
2. 怀疑并发双 vite 冷缓存冲突 → `rm -rf node_modules/.vite` 后并发起两个 vite 均 200 → 排除。
3. `DEBUG=pw:webserver npm run mock` 无任何 webserver 日志 → webServer 逻辑根本没执行。
4. 在 config 模块顶层加 `console.error` → config 确实被加载（主进程 1 次 + 每个 worker 进程各 1 次）。
5. 建 /tmp 最小探针（裸 npm init + 单 webServer + request fixture）→ 同样跳过 → 排除项目配置，锁定库级行为。
6. 装回 1.64.1，patch `node_modules/playwright/lib/runner/index.js` 在 `webServerPluginsForConfig` 入口打日志 → **运行时 `config.webServers === []`（空数组）**：加载器把我的 webServers 丢了。
7. 读 `node_modules/playwright/lib/common/index.js`（FullConfig 构造）：
   ```js
   const webServers = takeFirst(userConfig.webServer, null);
   if (Array.isArray(webServers)) { this.webServers = webServers; }
   else if (webServers) { this.webServers = [webServers]; }
   else { this.webServers = []; }
   ```
   运行时**只读 `userConfig.webServer`（单数键）**：值是数组就当多 server 列表，是对象就包成单元素数组；`webServers`（复数）键被静默丢弃。

## 根因

Playwright 1.64 运行时多 web server 的写法是 **`webServer: [{...}, {...}]`（单数键、数组值）**，不是 `webServers:`。TS 类型层同时放行两种键（defineConfig 类型宽），运行时只认单数键，复数键零告警丢弃——没有任何 warning/error，是典型的"类型宽、运行时窄"陷阱。

## 解决方案

`web/playwright.config.ts` 改用 `webServer: [...]`（单数键数组）。改完立即生效：4 个 webServer 全部启动并被等待。

## 预防/注意事项

1. 写 playwright 多 server 配置用 `webServer:` 数组；不要写 `webServers:`（至少 1.64 如此，升级后可查 changelog）。
2. 此类"配置被静默忽略"问题最快的定位手段：patch `webServerPluginsForConfig` 入口打印 `config.webServers`，一击定位是"没读到"还是"起了没等"。
3. 最小探针（裸目录+单 server+request fixture，无需浏览器安装）是区分"环境问题 vs 项目配置问题"的最快路径，5 分钟可建。
4. 相关配套坑（同一次排查顺带确认）：`--config` 期望**目录**（读 `<dir>/pi-workflow.config.json`），传文件路径等于没传；TokenGate 的连接按钮是 `onClick` 不是 form submit，Enter 不触发，e2e 要点 button。
