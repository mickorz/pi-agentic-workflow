# P0-D 执行报告：双平台与真实业务验收

> 日期：2026-10-23 · 依据：dev-docs/design/2026-10-22-wechat-persistent-service.md §7.1 P0-D
> 提交：bfbe860 · a3a8d7e · 48053e1 · 验证脚本：dev-examples/wechat-service/verify-p0d.py
> 结论：**Windows 侧全量完成；macOS 侧代码层 CI 实跑全绿，服务层（真机 PM2/真 Bot）待用户按手动指南执行**（指南：guides/2026-10-23-wechat-p0d-dual-platform-manual-test.md）

## 程序化验收（Windows，全 PASS，单用例 3 分钟预算内）

| 门禁场景 | 结果 | 证据 |
|---|---|---|
| 长任务中断恢复（§5 兼容/§7 长任务门禁） | PASS | verify-p0d 用例1：long-demo running → 直杀 manifest pid（run-mvkgkhsk-xy6g）→ status 识别 interrupted（journal 3 步完整）→ `resume --yes --non-interactive` 退出码 0 → 终态 completed |
| 服务链冒烟 | PASS | 用例2：service start → 轮询至综合 healthy（进程+Bot+心跳）→ stop → 综合 stopped，清理干净 |
| 崩溃拉起 / 优雅停止 / 失败上限 / 混跑互斥 | PASS | P0-B verify 四用例（8ab8064） |
| 健康双维度 / 日志滚动 | PASS | P0-C verify 四用例（bfbe860） |

进程模型依据（run-service.ts 头注释）：workflow 为宿主进程内执行（Bot 与 CLI 同一 RunApplicationService/引擎），
故用 CLI 进程忠实模拟「服务进程死亡中断运行中任务」——中断分类、journal、resume 走同一代码路径。

## 真实业务证据（引用）

| 场景 | 证据 |
|---|---|
| 公众号文章 Workflow 实测 | 2026-10-22 wechat_md_to_draft 真链路：9 图全传、草稿创建成功 media_id=RzpZN4Rc…aruuJNml、publish_completed=true（CLI 直跑）；同日微信批准链（PendingAction 批准→执行）真机验证通过 |
| 微信持续收发 | 服务 healthy 期间（11:30-11:36 等）Bot connected 心跳刷新；真机消息级持续收发为用户观测项（服务现已可常驻，日常使用即持续验证） |

## macOS 侧验证（分层结论）

| 层 | 结果 | 证据 |
|---|---|---|
| 代码层（build/typecheck/300 单测含 P0-B/C 全部 23 项新用例 + web-smoke） | **CI 实跑全绿** | run 39904499744（a3a8d7e 后）：macos-latest ✓ 57s；run 39904125312 macos ✓（含此前两次 macos 偶发 flake 修复） |
| 服务层（真机 PM2/真 Bot/微信收发/长任务恢复） | 待用户执行 | 手动指南 §1-§5（~40 分钟，一键 verify 脚本 + 真机项记录表）；本机无远程通道（ssh known_hosts 仅 github/git.bianfeng） |

CI 修复附带产物（真健壮性修复非掩盖）：①macOS runner 慢 IPC 下 run.completed 事件落盘与断言时机解耦（a3a8d7e）；
②Windows CI 实踩 rename EPERM/EBUSY → run-store 原子写短退避重试（48053e1）。

### macOS 服务层 runbook（待用户执行，指南内有完整版）

```bash
# 前置：npm i -g pm2；bun 存在或 brew install bun；双机互踢——先在 Windows 侧 wechat service stop
python3 dev-examples/wechat-service/setup-logrotate.py          # F3
python3 dev-examples/wechat-service/verify-p0b.py               # F1/F2/F4（真机用例需凭证）
python3 dev-examples/wechat-service/verify-p0c.py               # F11/F3
python3 dev-examples/wechat-service/verify-p0d.py               # 中断恢复+服务冒烟
```

差异注意（相对 Windows）：
- taskkill/tasklist → pkill/`kill -0`（脚本内 sys.platform 分支已处理）
- pm2 模块安装无 bun.exe 垫片问题（macOS spawn 走 shebang）
- 优雅停止路径相同（shutdown message 与平台无关，设计 §5 裁决）

## 遗留与后续

- macOS 复跑（上表 runbook，预计半天内一次过——除 bun/installer 差异外无平台分支）
- 开机自启 F6（P2，平台差异已在设计记录）、停机消息补拉 F9（P2，iLink cursor 能力单独立项）
- 服务日常常驻使用即持续验收（阶段 2：公众号业务闭环回归，设计 §8）
