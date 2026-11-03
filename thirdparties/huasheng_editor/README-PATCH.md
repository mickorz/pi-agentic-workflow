# GZH 排版工作台补丁登记(README-PATCH)

本目录是 `https://github.com/mickorz/huasheng_editor` 的**快照**(upstream base commit `433819c`,
2026-11-03 clone),为接入 pi-agentic-workflow 的 GZH Article Preview & Layout Studio 打了**最小补丁**。
按 thirdparties/VideoDigest 惯例以普通文件入库(不带 .git,防 gitlink 断链;bridge.js 与补丁必须版本化)。

**upstream 升级步骤**:`git clone https://github.com/mickorz/huasheng_editor` 到临时目录 → 覆盖本目录
(保留 bridge.js 与 README-PATCH.md)→ 按下表重打补丁 → 跑 `node dev-examples/gzh-preview/check_t01.mjs` 回归。

| # | 文件 | 改动 | 目的 |
|---|------|------|------|
| 1 | `app.js` 末行 | `editorApp.mount('#app');` 改为 `window.editorVm = editorApp.mount('#app');` | 暴露**组件代理**(App 实例不携带 data),供 bridge.js 读写 `markdownInput`/`currentStyle` 并复用 Vue 响应式刷新 |
| 2 | `index.html` | 在 `<script src="app.js?v=2" defer>` **之前**插入 `<script src="bridge.js" defer></script>` | bridge 必须先于 app.js 运行:`loadUserPreferences` 在 app.js 同步执行链内即读 localStorage,晚了拦截不到首次读取 |
| 3 | `bridge.js`(新增,非补丁) | 宿主桥接协议(8 消息:load/get/style/dirty/ready/export) + hostedMode 存储隔离 | 协议与设计见 `../../dev-docs/planning/2026-11-03-GZH排版工作台执行方案.md` D1/D1.6 |

## 验收

T0.1 验收脚本:`python -m http.server` + `dev-examples/gzh-preview/check_t01.mjs`(Playwright)。
覆盖:独立模式零回归、hosted 四消息(load/get/style change/dirty)、独立草稿零污染。
