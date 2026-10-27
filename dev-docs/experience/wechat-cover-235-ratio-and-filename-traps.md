# 公众号准备流程三连坑：封面 2.35:1 严格校验、文件名括号截断、封面优先级

**日期**：2026-10-27
**场景**：「准备文章」（article-prepare 手动插图模式）处理《未来的软件公司，可能不再招前端和后端了》

## 问题一：封面图片尺寸不合法（errcode 53401）

### 现象

`publish.py` 走到 `draft_add` 报错：

```
[FAIL] draft_add errcode=53401: draft_add errcode=53401 errmsg=封面图片尺寸不合法 hint: [JLavja001158-]
```

thumb 素材上传（add_material_image）本身成功，draft_add 才失败。

### 排查过程

- 失败封面：1922×818，比例 2.3496（与 2.35 只差 0.0004）。
- 唯一成功先例（《用Manus改造Manus》）封面 1672×941（16:9，10-26 经同一代理通道成功）。

### 根因

微信草稿接口对封面尺寸做**严格 2.35:1 校验**（或按当日实际校验口径收紧），"接近 2.35" 不等于 "等于 2.35"。
1922/818=2.34963 被判不合法。

### 解决方案

等比微缩到精确 2.35:1 整数尺寸（sips，macOS 自带，原文件先备份）：

```bash
cp imgs/cover-X.png _prev-round-*/cover-manual-original-1922x818.png
sips --resampleWidth 1880 imgs/cover-X.png   # -> 1880×800, 1880/800 = 2.35 精确
```

选 1880×800：一、宽高比精确 2.35；二、远高于 900×383 下限；三、与原尺寸差异最小。
重跑 publish.py 即成功。

### 预防/注意

- 手动插图前把封面统一处理成精确 2.35:1（推荐 1880×800 或 940×400）；
- 若 53401 复现而封面已是 2.35:1，再排查宽高上下限与代理通道（WECHAT_N_API_BASE）校验口径；
- 失败重试会在账号留下孤儿永久素材（每轮 thumb+正文图），无害但可择期清理。

## 问题二：图片文件名带空格/括号，IMG_REF 正则截断

### 现象

正文 wiki 内嵌 `![[03-AI时代程序员转型之路 (1).png]]`（浏览器重复下载的 "(1)" 后缀文件）。

### 根因

draft_manager 全链（check_state.py / content_hash.py / publish_html.py）统一使用
`IMG_REF = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")`，`[^)]+` 在第一个 `)` 处停止：
`![](imgs/03-xxx (1).png)` 会被解析成路径 `imgs/03-xxx (1`，上传必然找不到文件。

### 解决方案

规范化之前先把正文引用与 imgs 文件名里的空格/括号清干净（改引用指向同内容的干净文件名）。

### 预防/注意

- 手动插图命名规范：`01-主题.png`、`02-主题.png`、`cover-主题.png`，禁用空格、`(`、`)`；
- 可考虑在 normalize_manual_images.py 里加文件名校验（含空格/括号直接 [FAIL] 提示），本坑暴露的是缺失该预检。

## 问题三：根目录 cover.png 优先级高于 imgs/cover-*，手动换封面会被旧图顶掉

### 现象

`check_state.py cover_state()` 先查根目录 `cover.png/jpg/jpeg/webp`，再回落 `imgs/cover-*`。
本文目录残留旧一轮生成的根 cover.png，会把用户后来手动放的 `imgs/cover-未来软件公司的AI工作流.png` 顶掉，导致发错封面。

### 解决方案

换封面时把根 cover.* 一并移走（本文移入 `_prev-round-20261027/cover-gen-round2.png`），保证 imgs/cover-* 生效。

### 预防/注意

- 手动插图流程约定：目录根不放 cover.*，封面统一 `imgs/cover-主题.png`；
- 旧一轮生成产物（图/manifest）整体挪 `_prev-round-日期/`，imgs/ 只留正文实际引用的图。

## 附：本次执行链（成功路径）

1. 正文 wiki 内嵌与 imgs 对齐（4 图：cover/01/02/03，无多余无缺失）
2. `normalize_manual_images.py` → 标准 `![](imgs/…)` 引用 + 补 article.yaml（title=文件名）
3. `check_state.py` → prepare_ready=true，cover state=imgs
4. 封面 sips 缩到 1880×800（精确 2.35:1）
5. `publish.py --cover imgs/cover-….png --account-slot 1 --md-file … --title … --digest … --author AI奇点` → DRAFT OK

## 管线修复落地（2026-10-27 晚间，当日闭环）

三坑当晚已从“人工处理”升级为“管线自动保障”，Gate 套件全绿（P0 46 / P1 31 / P2 24）：

1. **封面自动缩放**：新增 `draft_manager/cover_resize.py`（纯标准库 PNG 盒式滤波缩放器）。
   `publish.py` 上传前调用 `ensure_cover_235()`：比例接近 2.35（±1%）→ 自动缩到精确 47k×20k
   （1880×800 属典型落点）并备份原图到 `_cover-original/`；明显偏离（如 16:9）→ 不动图仅 `[WARN]`（自动裁剪会破坏构图，且历史 16:9 曾通过）；非 PNG → 提示按原样上传。
2. **文件名预检**：`normalize_manual_images.py` 新增第 0 步——正文引用（标准 + wiki）文件名
   含空格/括号/全角括号 → `[FAIL]` 中断并列出名单，提示重命名。
3. **封面优先级提示 + 尺寸探针**：`check_state.py` 封面输出新增 `size` / `exact_235` 字段
   （只读 PNG IHDR）；根 cover.* 与 imgs/cover-* 并存时 issues 给出优先级提示；
   非精确 2.35:1 时给出“接近→publish 将自动缩放 / 偏离→53401 风险”分级提示。
