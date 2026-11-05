# 小绿书卡片化 T0：guizang 渲染冒烟两个坑（浏览器版本错位 / 分数坐标差 1px）

- 日期：2026-11-05
- 场景：`dev-examples/wx-article/scripts/sticker_cards/render_smoke.py`（方案
  `dev-docs/planning/2026-11-05-小绿书卡片化接入执行方案.md` V1.1 T0）
- 结论：smoke 7/7 全绿前踩了两个坑，都影响后续 build_html 注入器与 Gate B，必须记住。

## 坑 1：playwright 包版本与缓存浏览器 revision 错位

**现象**：skill 内 `npm install` 成功、`require('playwright')` 正常，但 `chromium.launch()` 报
`Executable doesn't exist ... chromium_headless_shell-1223`，而 ms-playwright 缓存里只有
`chromium-1248`（来自 web/ 线的 @playwright/test 1.64.1）。

**根因**：skill `package.json` 声明 `playwright: ^1.60.0`，npm 实装 1.60.0，其期望浏览器
revision 是 1223；缓存里的 1248 属于 1.64.x。playwright 各小版本绑死各自 revision，不能混用。

**解决**：submodule 内 `npx playwright install chromium`（一次性下载 112MB 的
headless-shell-1223）。不改 submodule 的 package.json（避免弄脏 submodule 指针）。

**预防**：预检（D2 三级预检）不能只查 node_modules 存在，**必须实际 probe
`chromium.launch()` 或用 render.mjs 冒烟**；换机器/换 playwright 版本时 revision 会再错位。
smoke 链固定走 `--no-embed` + 本 smoke 脚本，把这类错位在最前面拦住。

## 坑 2：内容默认 margin 导致元素截图多 1px

**现象**：画板 CSS 明确 `height: 1440px`，render.mjs 的 boundingBox 校验也过（1080×1440），
但产物 PNG 实际是 **1080×1441**。

**根因**：`h1` 默认 margin（21.4375px）margin-collapse 穿透 section，画板落在分数坐标
`y=21.4375`。playwright 元素截图按分数 origin 取整，1440 + 尾数 → 1441。
boundingBox 的 width/height 本身是整数，所以 render.mjs 自带的尺寸核对发现不了。

**解决**：画板及内容 margin 清零（`h1, p { margin: 0 }`），保证画板从整数 0,0 开始。
实测修后产物精确 1080×1440。

**预防（重要，T1 build_html 注入器必须遵守）**：
- 注入器生成的每个画板片段必须自带 margin 清零（组件片段顶层不依赖默认 margin）；
- verify_render 断言 PNG IHDR 精确 1080×1440（本坑证明 render.mjs 的 boundingBox 校验不够）；
- 适配种子模板时先确认其已有 reset（种子模板有完整排版体系，大概率已处理；但组件片段
  是我们自写的，不能想当然）。

## 相关文件

- 冒烟脚本：`dev-examples/wx-article/scripts/sticker_cards/render_smoke.py`
- 执行方案：`dev-docs/planning/2026-11-05-小绿书卡片化接入执行方案.md`（V1.1 D2/D7）
