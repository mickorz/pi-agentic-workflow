import io

# 1) kb 种子词表同步加 AI绘图工具（新知识库根的缺省值与用户 vault 保持一致）
P = 'dev-examples/wx-article/scripts/github_kb.py'
s = io.open(P, encoding='utf-8').read()
old = '    seed = ["游戏UI工作流", "Agent框架", "AI自动化测试"]'
assert old in s, 'seed line missing'
s = s.replace(old, '    seed = ["游戏UI工作流", "Agent框架", "AI自动化测试", "AI绘图工具"]', 1)
io.open(P, 'w', encoding='utf-8', newline='\n').write(s)

# 2) 进度日志
Q = 'dev-docs/progress/执行进度.md'
t = io.open(Q, encoding='utf-8').read()
t += ("- 2026-10-26（续六）词表扩充与改派（用户确认）：vault categories.json 增加「AI绘图工具」"
      "（gpt-image-2-client 从未分类改派至 AI绘图工具/gpt-image-2-client，旧未分类空目录已清理）；"
      "kb 种子词表同步四类。知识库现况：游戏UI工作流/game-ui-design-workflow、Agent框架/agent-orchestrator、AI绘图工具/gpt-image-2-client。\n")
io.open(Q, 'w', encoding='utf-8', newline='\n').write(t)
print('[OK] seed + progress updated')
