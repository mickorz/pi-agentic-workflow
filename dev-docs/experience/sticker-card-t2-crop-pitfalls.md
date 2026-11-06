# 小绿书卡片化 T2：截图裁切几何与转义字面量三个坑

- 日期：2026-11-06
- 场景：`dev-examples/wx-article/scripts/sticker_cards/`（V1.1 方案 T2：
  prep_screenshots.py / image_dims.py / screenshot 组件 manual-crop）

## 坑 1：NL 常量写成字面 "\\n"，页面上渲染出 "\n" 文本

**现象**：卡片图注/引言附近出现字面 `\N`、`\n` 文本。

**根因**：`components.py` 里 `NL = "\\n"`——Python 源码双反斜杠的值是"反斜杠+n"两个字符，
不是换行符。这个字面量被注入 HTML 文本节点，浏览器原样显示。

**解决**：`NL = "\n"`（真实换行符），并加断言 `assert NL == chr(10)` 式自检。

**预防**：转义类常量写完后立即 `repr()` 检查值；write 工具生成代码时对 `\` 序列保持警惕
（双层转义是重写文件的高频事故）。

## 坑 2：manual-crop 几何语义三轮才收敛——CSS 百分比心算不可靠

**演进过程（都是视觉抽检抓出来的）**：
1. v1 cover 基底 + transform scale/translate：宽横图（GitHub 截图 2.33:1）放 4:3 框时，
   cover 水平溢出 1.75 倍，居中裁切把代码**每行行首**裁掉（"exp/ort async"）。
2. v2 contain 全宽：地址栏只裁掉一半（宽限制下图满宽显示，R 上方内容仍在窗口内）。
3. v3（定案）：显式两层几何——R 归一化窗口 + img 缩放定位：
   - `s = min/max(wu/(w*dw), hu/(h*dh))`（contain/cover）
   - cover：R 左上对齐图框左上（`left=-x*w_pct, top=-y*h_pct`，溢出裁 R 外围）
   - contain：R 居中（加 `(100-w_pct)/2` 留白项）
   - 单位向量 `(wu,hu)=(A_well,1)` 即可，公式对整体缩放不变

**预防**：
- 视觉几何**禁止心算 CSS 百分比**，必须：渲染 → 看图断言（fixture 截图要带可辨文字和
  标志性元素如地址栏/圆点，才能断言"裁没裁对"）；数值断言用可手算的简单 case（正方形图）。
- 裁切框比例与图框比例不一致时 contain/cover 必有取舍（留白或丢外围），这是**用户决策**：
  `crop.fit` 字段暴露给页表，prep 报告 recommendation 给建议，不要替用户默默选。

## 坑 3：fixture 截图必须"可断言"

早期 fixture 用纯色 PNG，无法判断裁切对错。定案：截图类 fixture 用渲染生成的带文字页面
（模拟 GitHub 页：地址栏 + 代码高亮），裁切正确性可由视觉模型断言（地址栏是否消失、
行首关键字是否完整）。

## 坑 4：Windows 下 Path.rename 覆盖已存在目标会抛 FileExistsError

**现象**：UNKNOWN 恢复路径（产物已在位，校验后回写状态）在 Windows 上崩。

**根因**：`tmp.rename(real)` 当 real 已存在时 Windows 抛 FileExistsError（POSIX 语义是静默覆盖）。

**解决**：`os.replace(str(tmp), str(real))`（原子且跨平台语义一致）。

**预防**：涉及“写产物可能覆盖旧文件”的场景一律 os.replace；与本仓 article_state 的 os.replace
约定一致。

## 相关文件

- `dev-examples/wx-article/scripts/sticker_cards/components.py`（WELL_RATIOS + manual 几何）
- `dev-examples/wx-article/scripts/sticker_cards/prep_screenshots.py`（EXIF/分类/重复检测）
- 方案：`dev-docs/planning/2026-11-05-小绿书卡片化接入执行方案.md`（V1.1 D8 + T2 评审 4 项锁定）
