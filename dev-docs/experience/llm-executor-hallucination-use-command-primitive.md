# LLM executor 编造命令输出——确定性命令必须 command() 直跑

> 日期：2026-10-26 · 发现于 videodigest 微信链路真机（run-mvp8vfx4 / tb-cbf9f622）

## 问题现象

「灵感归档失败: [OK] archived -> inspire/2026/02/为什么大厂做不了AI-7700556505933729067
{"ok": true, ..., "vault_root": "E:/WorkProjects/pi-agentic-workflow/dev-examples/videodigest/work/vault"}」

三重疑点：`[OK] archived ->` 输出格式**全仓库不存在**；`inspire/2026/02/.../inspire.md`
目录结构与 archive_inspire.py 实现（`60_Workspace/写作/灵感/<标题>/0-raw.md`）完全不符；
`work/vault` 目录磁盘上不存在。同命令手动执行完全成功。

## 排查过程

1. journal 回放该节点 raw：executor 返回的"成功输出"指向不存在的路径，但结构化 ok=false；
2. 磁盘核验：`work/vault` 不存在、真 vault 无对应目录 → 输出是**编造的**；
3. 手动执行同一 archive 命令（PY_PROBE + archive_inspire.py archive …）：秒成功，
   正确解析 vault_root=E:/Obsidian/newsky；
4. 前一次失败（run-mvp0d2sr）是"模型回复为空"——同根同源。

## 根因

workflow DSL 把确定性命令（resolve/check/lock/extract/archive/unlock）包装成
`agent(executorPrompt(cmd))`——让 LLM 执行命令并转述 stdout。LLM executor 的两类真机故障：

1. 模端瞬时故障 → 回复为空 → 结构化解析失败；
2. **幻觉**：命令实际失败（或未执行），模型编造一份格式合理的"成功输出"（本例连
   vault_root、目录结构都是臆造的）。转述架构下无法区分真输出与编造输出。

## 解决方案

全部确定性命令改用 runtime 的 `command()` 原语（T1.0 确定性子进程节点）：

```js
// 参数数组直传（spawn shell:false，无注入面），stdout/stderr 分离捕获
const r = await command({ executable: 'node', args: [CLI, 'resolve', '--url', url], label: '链接解析', timeoutMs })
if (r.exitCode !== 0) throw new Error(label + '失败: ' + (r.stderr || r.stdout).slice(0, 300))
const json = JSON.parse(r.stdout)
```

- 不再需要 stdioRedirect（stdout/stderr 天然分离）、shQuote（数组直传无 shell 解析）、
  PY_PROBE bash 循环（command 逐个试跑 python3/python/py，Windows Store 占位符 exit 9009 被正确拒绝）；
- 失败真实原因直接进 throw → run.failed.error → 微信失败通知带原因；
- journal 机制与 agent 同源（成功结果可回放，失败重跑符合重试语义）。

验证：CLI 直跑全链路 79.7s 成功（探测 python(python3) exit 9009 被拒 → python 命中 →
六步全 ok），归档落盘真 vault，frontmatter 与排版逐字稿完整。

## 预防/注意事项

- **确定性命令永远 command()，agent() 只留给真正需要 LLM 判断的节点。** 需要转述的场景
  （如参数含用户自由文本需理解）才考虑 LLM，且输出必须可交叉验证（如回读落盘文件）。
- executorPrompt 模式在其它 workflow（wx-article 线）仍存在——同架构风险，改造时按本条
  方案迁移。
- command() 非 Windows 注意：executable 走 PATH 解析；Windows 下 .cmd/.bat 需绝对路径
  或 cmd /c（本 DSL 只跑 node/python 实体 exe，无此问题）。

## 关联坑：rebind 后确认消息"sent 但没收到"（2026-10-27）

`wechat rebind` 成功后 CLI 提示"已向绑定用户发送确认消息"，outbox 也标 sent，但微信收不到。
FAQ 明言："保存登录凭据不保证始终可以主动发送"——重登后对话不活跃，平台静默丢弃 Bot
主动消息，直到绑定用户先发一条消息激活。此外 accountId 变了（换 Bot 微信号）时旧
绑定会话整体失效，需删 bound-user.json 重新首条绑定。CLI"投递"措辞实际是 API sent，
不等于微信送达。
