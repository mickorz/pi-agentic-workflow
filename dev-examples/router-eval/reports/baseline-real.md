# 路由评测报告：baseline-real

- 模式：real · Prompt：A · 模型：(default: ~/.pi/agent/settings.json)
- 样本 42（wechat 38 / cli 4）· 判定 42 · LLM 失败 0
- **准确率：97.6%（Gate ≥90%：PASS）**
- 耗时：mean 5220ms / p50 4334ms / p95 11301ms · tokens 173671

## 混淆（action）
- ask_clarification→ask_clarification: 7
- ask_clarification→chat_reply: 1
- chat_reply→chat_reply: 6
- perform_task_control→perform_task_control: 5
- refuse→refuse: 5
- start_execution→start_execution: 18

## 逐字段参数准确率
- repoUrl: 100%（6/6）
- text: 100%（4/4）
- targetLang: 100%（4/4）
- url: 100%（5/5）

## 跨 channel
- wechat: 97.4%（37/38）
- cli: 100.0%（4/4）

## 失败明细
- [判定失败] 帮我个忙好吗 → 期望 ask_clarification/-，实际 chat_reply/-（用户只是打招呼请求帮助，未提及任何具体任务，属于闲聊开场）