---
name: mp-article-collect
description: 采集微信公众号文章全文与图片，落盘为 xiaolvshu 设计参照素材（templates/xiaolvshu/<标题>/：frontmatter md + imgs/ 组图）。Use when 用户给微信文章链接（mp.weixin.qq.com）要"采集/抓取/存到 xiaolvshu 素材库/做设计参照"，或要把公众号贴图文章作为小绿书版式对标。
---

# mp-article-collect：微信文章采集入库（xiaolvshu 素材）

## Capability

输入一条微信公众号文章链接，采集**正文文字 + 全部图片**，落盘为标准素材目录；供 xiaolvshu 做版式对标与小绿书选题素材。

## 边界

- **只采集与落盘**：不做视觉分析（图片分析用 zai 视觉模型另行逐张分析，参考 `templates/xiaolvshu/一行JSON动态架构图/图片分析.md` 的六维度口径）、不改正文、不直接进 xiaolvshu 制作流程
- 输入必须是 mp.weixin.qq.com 文章链接；搜狗搜索**发现**文章走 `dev-examples/content-intelligence/collectors/mp_collect.py search`（content-intelligence 管辖），本 skill 不重复
- 产物目录 `templates/` 已 gitignore（第三方素材，仅本地参照），**不提交仓库**

## 用法

```bash
python .pi/skills/mp-article-collect/scripts/collect_mp_article.py \
  --url "https://mp.weixin.qq.com/s/xxxx"
# 可选：--out-root templates/xiaolvshu（缺省）--slug 自定义目录名（缺省标题前 24 字）
```

成功：stdout JSON `{ok, out_dir, md_file, images_total, images_downloaded, warnings}`，exit 0。
产物：

```
templates/xiaolvshu/<标题>/
├── <标题>.md      # frontmatter(title/source/author/collected) + 正文段落 + ![NN](imgs/NN.png)
└── imgs/01..NN.png # 组图按出现顺序编号（扩展名按 Content-Type）
```

## 实现要点

- 链路复用 `dev-examples/content-intelligence/collectors/collect_common.py`（chrome-use 驱动真实 Chrome + 全局浏览器锁，与生图/其他采集互斥）
- 正文取 `#js_content` innerHTML，本地 HTMLParser 解析（标准库零依赖）：块级文本段 + `<img data-src>` 懒加载优先，script/style/svg 内容跳过
- 图片下载带 `Referer: https://mp.weixin.qq.com/`；单张失败不中断整组（warnings 列出，md 内标注"下载失败"）
- 离线自检：`python scripts/collect_mp_article_Example.py`（13 项断言，无网络依赖）

## 能力边界（2026-11-13 实测）

- **贴图页（newspic）**：正文=描述段+组图 img 直出，全组采集无压力；但组图集合以服务端当前渲染为准（boss-agent-cli 同期的「一行JSON」篇 DOM 仅直出 7/9 页，无轮播组件可程序化滑动）——采完后人工比对原文页数，缺页另存
- **常规图文页**：#js_content 全文解析，文字段落+文内图片按文档顺序
- 产物不含视觉分析：需要版式拆解用 zai 视觉逐张分析（六维度口径见 templates/xiaolvshu/一行JSON动态架构图/图片分析.md）

## 常见失败与处置

| 症状 | 处置 |
|------|------|
| chrome-use 未找到 / open 失败 | 正常打开日常 Chrome（扩展随浏览器上线），**不杀 Chrome**；见 `dev-docs/experience/chrome-use-relay-not-connected-upgrade-1-5.md` |
| 浏览器锁占用（lock age 报错） | 等其他采集/生图任务结束；锁超 30min 自动接管 |
| 文章页字段为空 | 链接失效或未登录态被拦截——真实 Chrome 打开该链接人工确认后重跑 |
| 单图下载失败（warnings） | md 已标注占位，人工补图或忽略 |
