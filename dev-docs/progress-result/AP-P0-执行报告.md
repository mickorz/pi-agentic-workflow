# AP-P0 执行报告：公众号草稿管理组件（draft_manager）

> 阶段：article_pipeline P0（发布正确性修复）
> 日期：2026-10-23
> 需求依据：`dev-docs/planning/公众号文章统一处理流水线（article_pipeline）需求文档（V1.2）.md` 第七节 P0 清单
> 状态：**已关闭：Mock 侧 Gate 46/46 + 真实公众号验证通过（建草稿 + 同内容复用）**

## 交付清单

新增 `dev-examples/wx-article/scripts/draft_manager/`（纯 Python 标准库，跨平台）：

| 文件 | 职责 | 契约来源 |
|------|------|---------|
| `article_lock.py` | 原子锁：`os.open(O_CREAT\|O_EXCL)` 排他创建；锁内记 pid/runId/粒度；pid 存活核验接管残留锁；禁超时自动删锁（Windows 下 `os.kill(pid,0)` 会误杀进程，用 ctypes OpenProcess 探活） | V1.2 4.2 |
| `article_state.py` | `publish-state.json` 状态管理：顶层 `accounts` 按账号隔离；共享状态文件读改写经独立 RMW 锁串行化；tmp+`os.replace` 原子落盘；状态损坏显性报错不静默重建 | V1.2 4.3/6.2 + P0 评审补充 |
| `content_hash.py` | contentHash（正文+引用图按序+封面+元数据+HTML 规则版本 v2+appid，NUL 分隔稳定序列化）；`.publish_snapshot/` 内容快照；提交前快照与磁盘一致性核对 | V1.2 4.4 |
| `wechat_draft_api.py` | 草稿 API 层：真实 `WechatClient`（token/add_material/uploadimg/draft add-update-get，urllib）+ `MockWechatClient`（跨子进程共享 JSON store，自身 RMW 串行化）；故障注入 add-timeout/add-errcode/crash-after-add/update-timeout/crash-after-update；失败三分类 `WechatAPIError`（明确）/`WechatNetworkError`（不确定） | V1.2 4.5 |
| `publish_html.py` | md→微信 HTML 转换（自旧 `publish.py` 原样提取，规则未变） | 输出契约保持 |
| `publish.py` | v2 主脚本（重构自 `references/wechat_md_to_draft/scripts/publish.py`）：状态机 + 双锁 + 快照 + 账号槽位透传 + 同内容复用 + draft/update | V1.2 全部 P0 修复项 |
| `run_p0_gate_suite.py` | P0 Gate 测试套件（Mock 故障注入），`--keep` 保留现场排查 | 仓库测试约定 |

## P0 修复项对照

| 需求修复项 | 实现 | 验证 |
|-----------|------|------|
| YAML 不再被覆盖 | 发布脚本对 `article.yaml` **零读写**（title/digest/author 显式参数或 frontmatter，5.2） | T7 字节级不变 |
| publish_completed 语义废弃 | 独立 `publish-state.json` 状态机（not_drafted/drafted/published + pendingOperation） | T1~T4 |
| 账号透传 | `--account-slot N` → `WECHAT_N_APPID/SECRET`，缺失显性 [FAIL]；Hash 绑定 appid | T6/T8 |
| 重复建草稿 | drafted+Hash 同 → draft/get 核对后复用；Hash 变 → draft/update(index=0)；远端被删/发表移除 → 降级重建 | T1/T2/T4/T10 |
| 崩溃不盲目重试 | 写前 pendingOperation(running) → 网络类失败置 unknown（退出码 2）；crash 残留 running 视为 unknown；仅 `--resolve-media-id` 人工核对后可清除 | T4/T10 |
| 原子锁 | 文章锁（本地阶段）+ (articleId, account) 锁（远程阶段），O_EXCL + pid 探活接管 | T5/T6 |
| 输出契约 | `[OK]/[FAIL]`、`[5] DRAFT OK media_id=`、`=== ALL DONE draft_media_id= ===` 字面量保持；新增 `[UNKNOWN]`(码 2)/`[LOCKED]`(码 3) | 套件全量断言 |

## Gate 结果（run_p0_gate_suite.py，Mock）

```
===== SUITE SUMMARY: PASS 46 / FAIL 0 =====
=== ALL DONE ===
```

| Gate 条目 | 场景 | 结果 |
|-----------|------|------|
| 同文章同账号重复 3 次仅一份草稿 | T1（3 次运行 1 份草稿，后两次走复用） | PASS |
| 内容变更更新原草稿 | T2（draft/update index=0，同 media_id，无第二份） | PASS |
| 明确失败保留旧态可重试 | T3（add-errcode → not_drafted 不动，重试成功） | PASS |
| 进程中断不盲目重提 | T4（crash-after-add → unknown → 人工 resolve 采纳）/ T10（crash-after-update → unknown → resolve 保留旧 Hash） | PASS |
| 并发不重复建稿 | T5（双进程同账号：一方 [LOCKED] 退出 3 或复用，草稿恒 1 份） | PASS |
| 多账号状态隔离 | T6（wxaaa/wxbbb 各一份草稿，状态互不覆盖） | PASS |
| yaml 不丢字段 | T7（字节级不变，自定义字段保留） | PASS |
| 账号选择真实生效 | T8（mock 调用记录 appid=集合正确，state keys 正确） | PASS |
| 多 md 歧义停止 | T9（两份正文 → [FAIL] 要求 --md-file；显式指定可用） | PASS |

## 真实公众号验证（2026-10-23）

对《AI提问第一篇》目录实测（config-dir 指向 dev-examples/wx-article，账号槽位 1）：

1. 首次运行：TOKEN/封面/6 张正文图上传全 OK，`draft/add` 建草稿，`media_id=RzpZ...QjI9`，状态落盘 `drafted`；
2. 二次运行：Hash 相同 → `draft/get` 核对远端存在 → **复用同一份草稿，未建新稿**（stdout 含 `(reuse, verified by draft/get)`）；
3. 草稿箱遗留：本次验证产生 1 份新草稿；历史验证的旧草稿（无图版/带图版各一）需人工清理。

## 已知边界与遗留

1. ~~真实公众号验证未做~~ 已完成（见上节）。真实改稿更新（draft/update）链路已由 Mock 故障注入覆盖，真实改动后重跑即可验证；
2. `wechat_md_to_draft.js` 仍调用旧 `references/.../publish.py`——**工作流重接到 draft_manager/publish.py 属 P1**（含 prompt 更新传 `--account-slot/--title/--digest`）。旧脚本本阶段未动，线上流程不受影响。
3. publish.log 仍按次追加（记录用途），状态以 publish-state.json 唯一为准。
4. 单机锁实现（pid 探活接管），跨机共享目录场景不在 P0 范围。

## 经验索引

- Windows 下 `os.kill(pid, 0)` 是 TerminateProcess 语义，探活必须 ctypes OpenProcess——实现于 `article_lock.pid_alive`，与 `dev-docs/experience/windows-signal-semantics-stop.md` 同族问题。
