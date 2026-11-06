# 小绿书卡片化 T1：注入器两个坑（模板示例画板残留 / 3:4 图框裁掉图注）

- 日期：2026-11-05
- 场景：`dev-examples/wx-article/scripts/sticker_cards/build_html.py`（V1.1 方案 T1，
  guizang 种子模板确定性注入器）

## 坑 1：只替换注入标记会把模板示例画板留在产物里

**现象**：构建"成功"且尺寸校验全过，但视觉抽检发现封面显示的是模板占位文案
（`[标题占位]`/`A working subtitle`/破图占位），不是注入的真实内容。

**根因**：种子模板结构是 `<!-- POSTERS_HERE -->` 标记 + **自带示例画板**（M01 placeholder，
id 也是 `xhs-01`）+ `</main>`。只把标记行替换成注入画板，示例画板仍在 DOM 里且排最后——
render.mjs 按 DOM 顺序逐个截图写 `${id}.png`，同 id 的示例画板后写，**覆盖了真实画板产物**。
两个 id 都合规、尺寸都对，纯靠尺寸/存在性断言发现不了。

**解决**：注入器改为**整段替换**：从标记起点截到 `</main>`，之间的示例画板连同注释一并移除，
再填入注入画板。配套测试：产物画板数 == 页数、产物不含 `[标题占位]`/`Placeholder: M01`。

**预防**：对"模板/脚手架带示例内容"的注入场景，替换范围必须覆盖示例块；
交付前至少跑一次**视觉抽检**（analyze 渲染产物），尺寸断言抓不到这类 bug。

## 坑 2：3:4 图框 + 标题 + 图注超出 1440 画板，图注被静默裁掉

**现象**：截图证据卡渲染"成功"，图框正常，但图注（Fig.N + caption）完全不可见。

**根因**：`.poster { overflow: hidden }` + `.content` 垂直 padding 192px + kicker/标题
~150px + gz-figure 3:4 图框（904px 宽 → 高约 1205px）≈ 1547px > 1440px。栈底元素
（图注）被 overflow 裁掉，无任何报错。

**解决**：screenshot-with-caption 组件图框固定 **4:3**（横版 UI 截图为主场景），
总高约 1100px，标题图注完整；竖版证据图（如 3:4 手机截图证据）列 P1 增强再设计版式。

**预防**：往固定画板里堆垂直内容时必须算高度账（padding+各级块+gap）；
组件视觉验收要覆盖"栈底元素是否可见"。

## 相关文件

- `dev-examples/wx-article/scripts/sticker_cards/components.py`（组件表，唯一事实来源）
- `dev-examples/wx-article/scripts/sticker_cards/build_html.py`（注入器）
- 方案：`dev-docs/planning/2026-11-05-小绿书卡片化接入执行方案.md`（V1.1 D5/D7）
