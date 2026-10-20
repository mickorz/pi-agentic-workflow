# 路由评测报告：baseline-fake

- 模式：fake · Prompt：A · 模型：(default: ~/.pi/agent/settings.json)
- 样本 42（wechat 38 / cli 4）· 判定 42 · LLM 失败 0
- **准确率：90.5%（Gate ≥90%：PASS）**
- 耗时：mean 0ms / p50 0ms / p95 0ms · tokens 0

## 混淆（action）
- ask_clarification→ask_clarification: 7
- ask_clarification→refuse: 1
- chat_reply→chat_reply: 5
- chat_reply→refuse: 1
- perform_task_control→perform_task_control: 5
- refuse→refuse: 5
- start_execution→ask_clarification: 1
- start_execution→start_execution: 17

## 逐字段参数准确率
- repoUrl: 80%（4/5）
- text: 100%（3/3）
- targetLang: 100%（3/3）
- url: 100%（5/5）

## 跨 channel
- wechat: 94.7%（36/38）
- cli: 50.0%（2/4）

## 失败明细
- [判定失败] 把 Hello world 翻译成中文 → 期望 start_execution/translate，实际 ask_clarification/translate（缺少参数：text）
- [判定失败] 帮我写一首诗 → 期望 chat_reply/-，实际 refuse/-（无匹配）
- [判定失败] 分析 https://github.com/pi/pi 仓库并总结 → 期望 start_execution/github-review，实际 start_execution/summarize（）
- [判定失败] 帮我个忙好吗 → 期望 ask_clarification/-，实际 refuse/-（无匹配）