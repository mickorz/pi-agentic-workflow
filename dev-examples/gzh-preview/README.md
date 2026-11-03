# gzh-preview(GZH 排版工作台开发沙盒)

一主题一子目录约定(dev-examples README):本目录是 GZH Article Preview & Layout Studio 的
开发期沙盒,验收脚本与 fixture 都在这里;方案与报告见
`dev-docs/planning/2026-11-03-GZH排版工作台执行方案.md` 与 `dev-docs/progress-result/GZH-P*.md`。

## 验收脚本(全部可重复执行,仓库根目录)

```bash
# T0.1 编辑器桥接(独立模式零回归 + hosted 协议 + 草稿零污染)
cd dev-examples/gzh-preview && npm install && node check_t01.mjs

# P0 API 套件(鉴权/列表/加载重写/签名图片/保存往返/锁/hash/路径逃逸/check_state 兼容)
# 前提:仓库根已 npm run build
python dev-examples/gzh-preview/run_p0_suite.py

# P0 浏览器全栈 E2E(React 页 + iframe + 保存落盘 + 重开一致 + 导出 layout.html)
node dev-examples/gzh-preview/check_e2e.mjs

# P2 layout-html 模式(publish --html-file,mock 零触网)
python dev-examples/gzh-preview/run_p2_layout_test.py
```

输出契约均为 `[OK]/[FAIL]` + 结尾 `=== ... PASS=n FAIL=m ===`。

## 目录内容

- `test-host.html`:T0.1 手测宿主页(带按钮,可直接起 http 服务人工点)
- `fixture-vault/`:验收夹具,DeepSeek 已入箱文章的拷贝(2 GIF + 5 图 + 中文文件名);
  原库未动,套件自动备份/还原 md
- `package.json`:仅 playwright-core(浏览器复用本机 ms-playwright 缓存),node_modules 已 gitignore

## 手动使用(真实文章)

1. `pi-workflow web`(仓库根)→ 取横幅 URL + token
2. 浏览器开 `<URL>/gzh-preview`,粘贴 token,从列表选文章(或 `?dir=<文章目录绝对路径>`)
3. 左侧改正文、切主题、看图;点"保存"写回文章目录;点"导出渲染 HTML"产 `layout.html`(P2)
4. 发布仍走原链路;P2 所见即所得用 `publish.py --html-file layout.html`(真机验证结论前视为实验特性)
