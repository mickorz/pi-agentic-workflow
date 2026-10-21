# wechat-article-skills workflows

微信公众号一条龙运营的 workflow js 工作流脚本目录。由 `skill-to-workflow` 把 `skills/` 下的 9 个 Agent Skill 转换而来，纯 agent 实现、自包含、不引用外部 skill。

## 脚本清单

| workflow js | meta.name | 对应 skill | 能力 |
|---|---|---|---|
| wechat_article_pipeline.js | wechat_article_pipeline | aws-wechat-article-main | 父编排:选题->写稿->审稿->排版->配图->终审->发布 |
| wechat_article_topics.js | wechat_article_topics | aws-wechat-article-topics | 选题与标题:热点调研、选题策划、起标题、写摘要 |
| wechat_article_writing.js | wechat_article_writing | aws-wechat-article-writing | 长文写作:从提纲或话题生成初稿,支持改写/续写/润色 |
| wechat_article_review.js | wechat_article_review | aws-wechat-article-review | 审稿与合规:敏感词、错别字、平台规范、AI味诊断 |
| wechat_article_formatting.js | wechat_article_formatting | aws-wechat-article-formatting | 排版:Markdown 转微信后台可粘贴 HTML,多主题多配色 |
| wechat_article_images.js | wechat_article_images | aws-wechat-article-images | 封面与正文配图:按内容匹配画风,生成 prompt 并调生图 API |
| wechat_article_publish.js | wechat_article_publish | aws-wechat-article-publish | 发布:图文入草稿箱或群发,素材上传与发布前检查 |
| wechat_article_assets.js | wechat_article_assets | aws-wechat-article-assets | 业务资料库与预设包:业务介绍入库、业务图入库、.aws 导入 |
| wechat_sticker.js | wechat_sticker | aws-wechat-sticker | 贴图与多图推送:构思、规划图序、生图到整组图审核 |

## 目录结构

```
workflows/
├── README.md                          (本文件)
├── wechat_article_pipeline.js         (main 父编排,零 agent 纯编排)
├── wechat_article_topics.js
├── wechat_article_writing.js
├── wechat_article_review.js
├── wechat_article_formatting.js
├── wechat_article_images.js
├── wechat_article_publish.js
├── wechat_article_assets.js
├── wechat_sticker.js
├── scripts/                           (py 执行脚本,6 个 skill)
│   ├── wechat_article_assets/scripts/*.py
│   ├── wechat_article_formatting/scripts/*.py
│   ├── wechat_article_images/scripts/*.py
│   ├── wechat_article_main/scripts/*.py
│   ├── wechat_article_publish/scripts/*.py
│   └── wechat_article_writing/scripts/*.py
└── references/                        (md 参考文档,9 个 skill)
    ├── wechat_article_assets/*.md
    ├── wechat_article_formatting/*.md + components/
    ├── wechat_article_images/*.md + cover-styles/ + image-styles/
    ├── wechat_article_main/*.md
    ├── wechat_article_publish/*.md
    ├── wechat_article_review/*.md
    ├── wechat_article_topics/*.md
    ├── wechat_article_writing/*.md
    └── wechat_sticker/*.md
```

## 使用方式

### 一条龙(前台交互,checkpoint 弹窗)

```javascript
workflow('wechat_article_pipeline', {
  hint: 'AI Agent 选题',
  publish_method: 'draft',
}, { background: false })
```

### 单步运行

```javascript
// 只写稿
workflow('wechat_article_writing', { article_dir: 'drafts/20260101-xxx', mode: 'draft' })

// 只排版
workflow('wechat_article_formatting', { article_dir: 'drafts/20260101-xxx', theme: '亲和' })

// 只发布
workflow('wechat_article_publish', { article_dir: 'drafts/20260101-xxx', account: 1 })
```

### 定时执行(后台 headless)

```javascript
schedule_create({
  workflowId: 'wechat_article_pipeline',
  cron: '0 9 * * *',
  args: { hint: '每日热点', publish_method: 'draft' },
})
```

## 设计约定

1. **纯 agent 实现**：不调原 skill 的 py 执行;agent 读 `references/<name>/*.md` 作为指引,执行层(写文件、调 API、bash)由 agent 自主完成
2. **不引用外部 skill**：语法规范自带(skill-to-workflow 的 `references/workflow-syntax.md`),不让 agent 调 workflow-authoring
3. **不保留原 SKILL.md**：原 skill 的 SKILL.md 不复制到 references/、不引用;其工作流规则已内联进 agent prompt,workflow js 自身就是工作流定义
4. **依赖文件分类存放**：
   - py 执行脚本 -> `scripts/<meta.name>/scripts/*.py`
   - md 参考文档 -> `references/<meta.name>/*.md`(直接放目录下,无中间 references/ 层)
   - 目录名用 workflow js 的 `meta.name`,不用原 skill 名
5. **全部用 checkpoint**：所有人工确认点(选题落盘、稿件确认、配图方案、定稿、账号选择、发布前)用 `checkpoint()`,多选决策作为 `args` 输入
6. **父编排串联**：`wechat_article_pipeline` 零 agent,用 `workflow()` 原语串联 6 个子流程,父可零 agent
7. **顶层 return**：每个 js 返回结构化结果(路径、状态、计数)

## 注意事项

- 后台运行时 checkpoint 走 headless 默认值(无人工弹窗),需要交互确认时传 `background: false` 前台运行
- 子脚本用注册名(`meta.name`)引用,如 `workflow('wechat_article_topics', {...})`
- 涉及微信 API 的发布与生图,agent 用 bash + curl 调用,需 `aws.env` 配齐凭证
- 原始 skill 源码在项目根 `skills/` 目录,本目录是转换后的自包含产物

## 相关

- 转换工具 skill: `skill-to-workflow`(全局,`C:\Users\zhangqi95\.claude\skills\skill-to-workflow`)
- workflow 语法规范: skill-to-workflow 的 `references/workflow-syntax.md`
- 原始 skill 源码: `skills/aws-wechat-article-*`
