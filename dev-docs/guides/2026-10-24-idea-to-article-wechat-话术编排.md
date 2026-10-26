# idea_to_article 微信话术编排（V1.0）

> 配套：`dev-docs/design/2026-10-24-idea-to-article-v1-执行方案.md`（D8）
> 生效 registry：`dev-examples/am-p0/registry.json`（22 条，PM2 wechat-bot 托管）
> 话术原则：用户不需要记忆内部命令，不需要输入 articleId；标题即锚点。

## 一、能力总表（idea-article-* 五流程）

| workflow | 话术（主话术加粗） | 参数 | 审批 |
|---|---|---|---|
| idea-article-start | **「<内容> 做成文章」** / 「帮我记录一个灵感 <内容>」 | content=灵感原文；title 缺省由 LLM 提取 | 免审批（auto-approve 白名单） |
| idea-article-turn | **「选 B」** / 「换三个方向」 / 「目标读者改成普通人」 / 「确认方向」 / 「先暂停」 | title=任务标题；message=原话 | 免审批（白名单） |
| idea-article-write | **「继续写文章」** / 「确认大纲」 / 「修改文章: <意见>」 | title；message=原话 | 免审批（白名单） |
| idea-article-status | **「这篇文章进展怎么样」** / 「<标题> 写到哪了」 / 「灵感任务列表」 | title 可空（空=列表） | 只读免审批 |
| idea-article-handoff | **「交接文章 <标题>」** / 「准备发布 <标题>」 | title | ⚠️ 走审批卡（关键节点，不在白名单） |

下游衔接（现有流程，非本模块）：

| 触发 | 流程 | 说明 |
|---|---|---|
| 「准备文章 <标题>」 | article-prepare（现有） | 配图/草稿箱，external-side-effect 独立审批 |
| 发布 | article-publish（现有） | 只经现有发布审批，idea-article-* 无任何发布通道 |

## 二、状态机与话术对应（需求 §4 / §8.1）

```
idea_captured → waiting_topic_confirmation → brief_confirmed → outline_generated*
  → reviewing → draft_ready → handed_off        （*outlineApproval=true 时暂停）
```

| 用户输入 | 系统操作 | 状态变化 |
|---|---|---|
| 帮我记录一个灵感 …… | start 创建灵感任务 | → waiting_topic_confirmation（三候选） |
| 把这个想法做成公众号文章 | start 创建并分析 | 同上 |
| 选 B | turn 确认选题→生成 Brief | → brief_confirmed |
| 换三个方向 | turn 重新生成三候选 | 保持 waiting_topic_confirmation |
| 目标读者改成普通人 | turn 修改讨论（默认分支） | 状态不变，讨论记录追加 |
| 确认大纲 | write 审批大纲后继续 | outline_generated → reviewing |
| 继续写文章 | write 生成链（断点续写） | → draft_ready |
| 修改第三阶段 / 修改文章: <意见> | write Brief 修订全链重生成 | → brief_confirmed → … → draft_ready |
| 这篇文章进展怎么样 | status 详情/列表 | 只读 |
| 先暂停 | turn 暂停 | → paused（回来「继续写文章 <标题>」） |
| 交接文章 <标题> | handoff 三件套落 单篇/<标题>/ | → handed_off |

## 三、边界与治理

- **多任务歧义**：标题部分匹配多任务 → 回复编号清单，用户回「2 <内容>」消歧或用完整标题。
- **零命中**：引导用完整标题或先「做成文章」建任务。
- **同标题重复**：init 冲突 → 引导换标题（灵感目录目录名唯一）。
- **交接冲突**：单篇/<标题> 已被占 → 自动落 `<标题>-YYYYMMDD-<id4>`。
- **交接后改稿**：handoffId 不一致 → unknown 拒绝自动重试，播报人工核对。
- **审批语义**：白名单只覆盖讨论体验（start/turn/write 落盘全在灵感工作目录内）；handoff 与下游 prepare/publish 均保留审批。

## 四、主话术示例（可直接真机照抄）

1. 「为什么你学了那么多 AI 框架，还是做不出产品？做成文章」
2. （收到三候选后）「选 B」
3. 「继续写文章」
4. 「这篇文章进展怎么样」
5. 「交接文章 框架收藏家的困境」→ 批准
6. 「准备文章 框架收藏家的困境」→ 进入现有配图/草稿链
