# 路由评测报告：glm53flash-real

- 模式：real · Prompt：A · 模型：cc-switch-zhipu-glm/glm-5.3-flash
- 样本 42（wechat 38 / cli 4）· 判定 42 · LLM 失败 0
- **准确率：97.6%（Gate ≥90%：PASS）**
- 耗时：mean 7148ms / p50 6630ms / p95 11049ms · tokens 174049

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
- [判定失败] 帮我个忙好吗 → 期望 ask_clarification/-，实际 chat_reply/-（用户只是泛泛请求帮忙，未提及任何具体任务，且无候选工作流可匹配）