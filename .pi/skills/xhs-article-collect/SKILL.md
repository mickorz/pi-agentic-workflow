---
name: xhs-article-collect
description: 采集小红书笔记标题/正文/作者/标签/互动数+图片，落盘为设计参照素材（templates/xiaohongshu/<标题>/：frontmatter md + imgs/ 组图）。Use when 用户给小红书笔记链接（xiaohongshu.com/explore/<id> 或 search_result/<id>）要"采集/抓取/存到小红书素材库/做设计参照"。
---

# xhs-article-collect：小红书笔记采集入库（设计参照素材）

## Capability

输入一条小红书笔记链接，采集**标题/正文/作者/发布日期/标签/互动数 + 全部图片**，落盘为标准素材目录；供小绿书做版式对标与选题素材。

## 边界

- **只采集与落盘**：不做视觉分析、不直接进 xiaolvshu 制作流程
- **需要用户 Chrome 开着且小红书登录态有效**（登录墙在采集时显式报错，不静默降级）
- 视频笔记暂不支持（只采图文）；产物目录 `templates/` 已 gitignore（第三方素材仅本地参照），**不提交仓库**
- 搜索发现笔记走 `dev-examples/content-intelligence/collectors/xhs_collect.py search`（content-intelligence 管辖），本 skill 只收单篇详情

## 用法

```bash
python .pi/skills/xhs-article-collect/scripts/collect_xhs_note.py \
  --url "https://www.xiaohongshu.com/explore/<id>"
# 可选：--out-root templates/xiaohongshu（缺省）--slug 自定义目录名
```

成功：stdout JSON `{ok, out_dir, md_file, images_total, images_downloaded, warnings}`，exit 0。
产物：

```
templates/xiaohongshu/<标题>/
├── <标题>.md      # frontmatter(title/source/author/collected/publish_date/tags/metrics) + 正文 + ![NN](imgs/NN.png)
└── imgs/01..NN.png
```

## 实现要点

- 链路复用 `collect_common`（chrome-use + 全局浏览器锁，与生图/微信采集互斥）；采集前逐屏滚动 4 屏触发轮播懒加载（微信采集同款教训：滚到底不够）
- 图片：页面级 `<img>` naturalWidth ≥400、去头像/图标、URL 去重保序；下载带 `Referer: https://www.xiaohongshu.com/`；单张失败不中断（md 内标注占位）
- 离线自检：`python scripts/collect_xhs_note_Example.py`（13 项断言，无网络依赖）

## 常见失败与处置

| 症状 | 处置 |
|------|------|
| 登录墙 / 无头像无卡片 | 用户 Chrome 登录小红书后重跑；**不杀 Chrome** |
| 未采集到图片 | 视频笔记不支持；或图片懒加载未渲染——重跑一次（滚动时序偶发） |
| 单图下载失败（warnings） | md 已标注占位，人工补图或忽略 |
| 标题选择器未命中（小红书改版） | 用 chrome-use 手查 DOM 后更新 NOTE_JS 选择器（多版 DOM 兼容写法已有） |
