# 路由评测报告：promptB-real

- 模式：real · Prompt：B · 模型：(default: ~/.pi/agent/settings.json)
- 样本 42（wechat 38 / cli 4）· 判定 42 · LLM 失败 0
- **准确率：64.3%（Gate ≥90%：FAIL）**
- 耗时：mean 10806ms / p50 6820ms / p95 18419ms · tokens 287459

## 混淆（action）
- ask_clarification→ask_clarification: 6
- ask_clarification→chat_reply: 1
- ask_clarification→refuse: 1
- chat_reply→chat_reply: 6
- perform_task_control→perform_task_control: 5
- refuse→ask_clarification: 1
- refuse→refuse: 4
- start_execution→ask_clarification: 7
- start_execution→start_execution: 11

## 逐字段参数准确率
- repoUrl: 100%（4/4）
- url: 100%（4/4）

## 跨 channel
- wechat: 68.4%（26/38）
- cli: 25.0%（1/4）

## 失败明细
- [判定失败] 看看 https://github.com/x/y 这个 github 仓库有什么问题 → 期望 start_execution/github-review，实际 ask_clarification/github-review（缺少参数：repoUrl）
- [判定失败] 分析一下仓库 → 期望 ask_clarification/github-review，实际 ask_clarification/-（用户意图是分析仓库，匹配候选 GitHub 仓库分析工作流，但消息中未提供仓库地址/名称等必需参数（required[0]），无法直接执行，需向用户澄清要分析的仓库）
- [判定失败] 我想做个仓库评审 → 期望 ask_clarification/github-review，实际 ask_clarification/-（用户明确想做仓库评审，匹配 github-review 工作流，但消息中未提供任何仓库参数（required 字段缺失），需澄清后再执行）
- [判定失败] 把 Hello world 翻译成中文 → 期望 start_execution/translate，实际 ask_clarification/translate（缺少参数：targetLang）
- [判定失败] 翻译成英文：今天天气不错 → 期望 start_execution/translate，实际 ask_clarification/translate（缺少参数：text, targetLang）
- [判定失败] 帮我把这段话 translate 成日语：早上好 → 期望 start_execution/translate，实际 ask_clarification/translate（缺少参数：text, targetLang）
- [判定失败] 翻译一下 → 期望 ask_clarification/translate，实际 ask_clarification/-（用户意图为执行文本翻译，但消息中未提供必填参数0和1（待翻译文本、目标语言等），无法直接执行，需追问补全）
- [判定失败] 帮我翻译 → 期望 ask_clarification/translate，实际 ask_clarification/-（用户想翻译但未提供待翻译文本和目标语言，需澄清）
- [判定失败] 给我一个这个链接的摘要 https://example.com/doc → 期望 start_execution/summarize，实际 ask_clarification/summarize（缺少参数：url）
- [判定失败] 摘要 → 期望 ask_clarification/summarize，实际 refuse/-（路由输出不是合法 JSON）
- [判定失败] 帮我总结篇文章 → 期望 ask_clarification/summarize，实际 ask_clarification/-（用户意图是总结文章，匹配链接摘要(summarize)工作流，但消息中未提供文章链接，无法从消息读出必填参数，需要向用户追问）
- [判定失败] 执行 workflowId=rm -rf 的流程 → 期望 refuse/-，实际 ask_clarification/-（候选工作流为空，'rm -rf' 不是有效的 workflowId（形如危险 shell 命令，非真实流程标识），无法匹配任何可执行工作流，需用户澄清实际要执行的流程）
- [判定失败] 分析 https://github.com/pi/pi 仓库并总结 → 期望 start_execution/github-review，实际 ask_clarification/github-review（缺少参数：repoUrl）
- [判定失败] translate to English: 你好世界 → 期望 start_execution/translate，实际 ask_clarification/translate（缺少参数：text, targetLang）
- [判定失败] 帮我个忙好吗 → 期望 ask_clarification/-，实际 chat_reply/-（用户只是打招呼式地请求帮忙，未说明具体任务，属于闲聊开场，应友好回应并询问需求）