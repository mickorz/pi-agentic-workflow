# 小绿书卡片嵌图形页三坑：图比例/well 超高/字体缓存（mcode-stack V2 重跑实战）

## 问题现象

2026-11-11 mcode-stack 小绿书 V2 重跑（页 3/4 改为 diagram-design 图形页：架构图 + 安装流程图，均为竖版 800×1064 SVG 转 PNG），渲染出的卡片连续三轮异常：内嵌图以原尺寸溢出被画板裁切、底部产出节点不可见、zai 判定出现"重复实例平铺"等互相矛盾的描述。

## 根因（三个独立坑叠加）

1. **图比例 ≠ 图框比例**：screenshot-with-caption 组件的 gz CSS 默认 `object-fit:cover`（横图假设），竖版 0.75 图放进横版假设的 well 会裁切；manual crop 的 inline style 在 playwright 环境生效（诊断证实 computed 正确），但 fit 语义在竖图上依然有坑。
2. **well 3x4（1205px 高）超出画板**：screenshot 页的 kicker + h1 占约 380px，well 1205 + caption 后总高超出 1440 画板，底部约 195px 被裁——竖版图底部的琥珀产出节点正好被裁掉。
3. **字体缓存缺失**：render.mjs 字体内嵌要从 raw.githubusercontent.com 下载 Noto Serif/Sans SC，国内直连超时（workflow 里 300s 强杀直接 fail，无降级捕获）。

## 解决方案

- **图比例 = 框比例（硬纪律）**：把图形页 SVG 重排为正方形 800×800（= well 1x1 比例）。比例相同时 contain/cover/fill 数学上等价（恰好满铺），免疫一切 fit 模式坑。截图输出 1600×1600（@2x）。
- **well_ratio 用 1x1**：904×904 的 well 放得下（kicker+h1+figure 总高 ≈1435 < 1440）。
- **字体预置**：9 个 TTF 走代理预下载到 `~/.cache/guizang-design/fonts/6157dfaa640c/ofl/...`（文件名规则：path 中 `[` `]` 替换为 `_`；gz-fonts.mjs 的 cachePath），并 mkdir `<skill>/fonts/`（fetchFont 首次要写 lock.json）。预置后 embed 全程离线秒过。

## 验证方法论教训

- **像素取证不要手写 PNG 解码器**：手写 zlib unfilter + 裁剪重编码链路产出了损坏文件（zai 看到尺寸错误+纯黑），此前"琥珀 0 像素"的扫描结论也不可信。**用 chrome canvas getImageData**（浏览器自身解码 100% 可靠）做像素统计。
- **zai 对"变形拉伸/重复实例"的判定不可靠**：同一张图在不同 prompt 下给出"平铺 4 实例"与"右裁下裁"两种矛盾描述。封闭式三问 + 同比例干净图 + 多数表决才可用；结构性保证（比例匹配）优于事后视觉验证。

## 预防/注意事项

- xiaolvshu 图形页资产一律先定 well 比例再按比例画图；现有组件表 well_ratio 枚举里 **1x1 是竖版图形页最稳的选择**
- 新环境首次跑卡片渲染前先预置字体缓存（或首次故意走 `--no-embed` 降级路径）
- publish draft_update 对 newspic 的真机语义已验证：media_id 失效 40007 → 自愈重置 → 重跑 draft_add 新建（本轮实战走通）
