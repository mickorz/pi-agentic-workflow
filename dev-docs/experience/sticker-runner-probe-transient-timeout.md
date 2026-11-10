# sticker RUNNER 子进程瞬超时——resume 回放免重跑 LLM 直接续跑

## 问题现象

2026-11-10 首跑 `wechat_sticker_cards.js`（真实素材）：规划 agent 正常完成（pages.json 落盘、截图复制齐），紧接着的 `validate_pages` command 节点 180s 超时（无任何 partial 输出），run 失败。同样命令手动跑、node 精确复刻 RUNNER（含 agent→node -e→spawnSync 探测序列）全部 150ms 级秒过。

## 排查过程

- 手动 `python validate_pages.py`（同参数）：124ms 通过
- `node -e` 复刻工作流 RUNNER_SRC（探测 python3/python/py + spawnSync）：124ms 通过
- `.cjs` 精确复刻 runtime 的 async spawn（windowsHide + shell:false + 管道捕获）：149ms 通过
- 最小对照 workflow（agent → command python）：通过；1:1 复刻（agent → node -e RUNNER → validate_pages）：602ms 通过
- 所有复现全部通过，原始失败无法稳定复现

## 根因（未定案，诚实存疑）

唯一无法复现的差异是失败现场的进程环境。主要嫌疑：RUNNER 探测序列第一个打 `python3`——Windows 上命中 WindowsApps 商店占位符（App Execution Alias reparse point），首次触发在某种进程状态下可能弹 Store 交互而挂起（后续触发因缓存快速返回 9009），导致 RUNNER 卡在探测步、零输出直至 180s 超时。未能定案，不做断言。

## 解决方案

不改代码，直接利用状态机断点续跑：`pi-workflow resume <runId> --non-interactive`——journal 回放已完成的规划 agent（免重跑 LLM），validate_pages 重跑即过，走到规划审批 checkpoint 正常进入等待态。全程零损失。

## 预防/注意事项

- 真实素材全链跑 sticker 工作流遇 command 节点"无输出超时"时：先手动复跑同一命令，秒过即按瞬超时处理，直接 `resume`（journal 回放已提交节点），不要盲目加超时
- 想根治可给 RUNNER_SRC 探测加 Windows 分支（跳过 python3 或 spawnSync 加 windowsHide/超时），属工作流代码改动，须过 Gate B——目前证据不足，不值得动
- 相关：`dev-docs/experience/pi-workflow-non-tty-checkpoint-pipe.md`（resume 管道喂 y 的标准姿势）
