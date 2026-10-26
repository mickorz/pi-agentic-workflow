# P0-A 执行文档：启动入口整理与单实例锁（F12 + F5）

> 日期：2026-10-22 · 依据：`dev-docs/design/2026-10-22-wechat-persistent-service.md`（已冻结）§7.1 P0-A
> 阶段目标：解决运行基础——Node 启动、路径解析、前后台互斥可靠
> 完成标准：服务形态单进程可脱离终端运行；同机同 data 目录前后台混跑被锁拦截；陈旧锁可安全接管

## 0. 实现约束（来自第三轮评审，验收时逐条核对）

1. **PM2/服务形态托管的是实际 Bot 进程**，不经过 `spawnSync` 重执行包装（避免父子进程生命周期耦合）
2. **锁获取原子**：openSync `wx` 竞争安全；崩溃后可恢复陈旧锁；接管前验证持有者存活，不误删活跃实例的锁
3. 前台 `wechat start` 与后台 `service start` **必须过同一把锁**（锁在共享 Bot 启动层，不在 PM2 层）

## 1. 现状与问题

### 1.1 启动链路（F12 对象）

```
pi-workflow（bin = dist/cli/index.js，plain node）
  └─ wechatCommand(rest, { reexecTsx: true })
       └─ reexecUnderTsx(): spawnSync(node --import tsx src/cli/index.ts wechat …)
            └─ tsx 进程内执行 wechat start（实际 Bot 进程）
```

问题：若 PM2 托管 bin 进程，则得到「wrapper（spawnSync 阻塞等待）+ 实际 Bot」两层进程；wrapper 死了 Bot 成孤儿、kill 语义混乱、PM2 重启策略作用在错误的进程上。

### 1.2 无单实例锁（F5 对象）

`wechat start` 无任何互斥：同 data 目录可起多个实例（互踢/抢消息）；`service start` 后再跑前台 `start` 同样冲突。

## 2. 设计

### 2.1 F12：服务启动形态定型

**定型为单进程形态**：服务/后台场景直接以 loader 方式启动入口，绕过 reexec：

```
node --import tsx <仓库根>/src/cli/index.ts wechat start [--flags…]
```

- `tsx` 为 loader（`--import`），无重执行、无 wrapper——PM2 托管的就是 Bot 进程本身
- 前台调试模式 `pi-workflow wechat start` 行为不变（内部仍走 reexec，用户无感）
- 路径固定：ecosystem/启动命令中以 `cwd` + `--registry` + `--data` 显式锚定，不依赖调用时的相对路径缺省
- tsx 仍在 devDependencies（仓库内运行）；**thirdparties 预编译去 tsx 化列为后续优化**，不在 P0-A 范围（当前机器 tsx 可用，不阻塞）

交付物：`dev-examples/wechat-service/ecosystem.config.cjs`（P0-B 直接使用），关键项按需求 §7.2 预置：

```js
module.exports = {
  apps: [{
    name: "wechat-bot",
    script: "node",
    args: "--import tsx src/cli/index.ts wechat start",
    cwd: "<仓库根>",           // 启动时锚定
    exec_mode: "fork",
    instances: 1,
    shutdown_with_message: true,
    kill_timeout: 10000,
    exp_backoff_restart_delay: 1000,
    min_uptime: "30s",
    max_restarts: 10,
  }],
};
```

### 2.2 F5：单实例锁

**位置**：共享 Bot 启动层——`wechat start` 装配早段（`WechatApp` 构造之前），前台与后台路径都经过。

**参考实现**：`src/persistence/run-store.ts` 的 `withManifestLock`（openSync `wx` 原子获锁 / 等待 / 陈锁自愈，commit ed0c059 已验证的同款模式）。

锁协议（锁文件 `<data>/service.lock`）：

1. **规范化**：data 目录用 `path.resolve` + `fs.realpathSync.native`（存在时）归一，Windows 大小写/短路径不产生第二把锁
2. **原子获取**：`openSync(lockPath, "wx")` 创建成功 → 写入 `{ pid, startedAt, cwd }` → 持有
3. **竞争处理**：`EEXIST` → 读锁内容：
   - 持有者 pid 存活（`process.kill(pid, 0)`，Windows 上用 `tasklist /FI` 或 PowerShell `Get-Process -Id` 兜底）→ **报错退出**：`服务已在运行（pid=N，data=<dir>），如需重启先 wechat service stop`
   - pid 不存在 → **陈旧锁**：原子接管（`rename` 锁文件为 `.stale` 后重新 `wx` 创建；rename 失败说明另一进程先接管，退出）
4. **误删防护**：接管前必须完成 pid 存活校验；禁止「锁文件存在即删除重试」
5. **释放**：`app.stop()` 完成 / 进程正常退出路径删除锁文件；异常退出依赖陈旧锁恢复（下次启动自愈）

**任务清单**：

| # | 任务 | 验收 |
|---|------|------|
| T1 | 新建 `src/gateway/service-lock.ts`：acquire（原子+存活校验+陈旧接管）/ release | 单测：并发竞争只有一方获锁；杀持有者后可接管；接管不误删活跃锁 |
| T2 | `wechat.ts` start 装配段接入锁（SIGINT/stop 路径释放） | 前台二次 start 被拦，报错信息含 pid 与 data 路径 |
| T3 | ecosystem.config.cjs 模板 + 单进程形态验证脚本（dev-examples/wechat-service/） | detached 启动后关终端进程仍在；进程树单层（无 wrapper） |
| T4 | 手动验收记录（本文档 §4 表格）+ git commit | 全部 PASS |

## 3. 测试计划

自动化（node:test，Fake 注入风格与现有单测一致）：

- `tests/unit/service-lock.test.ts`：
  - 并发 10 进程/协程竞争 `acquire`，恰 1 个成功
  - 持有者 kill -9 后 `acquire` 接管成功，锁内容更新
  - 持有者存活时 `acquire` 失败且**不破坏**原锁文件
  - Windows 大小写不同写法的 data 路径识别为同一把锁（CI 三平台跑）
- 回归：现有 `tests/unit/` 全绿（npm test）

手动（记录到 §4）：

1. `wechat start`（前台）→ 另开终端再 `wechat start` → 被拦
2. service 形态启动（node --import tsx …）→ 关闭启动终端 → 进程仍在、能收发
3. 强杀 Bot 进程 → 锁文件残留 → 重新启动 → 陈旧锁自愈成功

## 4. 手动验收记录

| 用例 | 日期 | 结果 | 证据 |
|------|------|------|------|
| 前台二次启动被拦（混跑互斥） | 2026-10-22 | PASS（Windows） | verify-p0a.sh 第 4/5 项：退出码 2，报错含持有者 pid/startedAt/cwd 与 data 路径 |
| 单进程形态、脱离终端存活 | 2026-10-22 | PASS（Windows，程序化） | verify-p0a.sh 第 1/2 项：nohup 后台启动存活至锁获取点，进程命令行单层 node --import tsx 无 wrapper |
| 陈旧锁自愈 | 2026-10-22 | PASS（Windows） | verify-p0a.sh 第 5–7 项：强杀后锁残留 → 新进程接管（锁内容 pid 更新） |
| 单元测试 | 2026-10-22 | PASS 9/9 | tests/unit/service-lock.test.ts（并发唯一获锁/存活不破坏原锁/陈锁接管/损坏锁/防误删/大小写同锁） |
| Windows / macOS 双平台 | 2026-10-22 | Windows PASS；**macOS 待测** | verify-p0a.sh 在 macOS 机器执行同脚本（预计 P0-D 一并验收） |

验证脚本调试中踩掉的坑（记录备查）：

- bash `check` 语义：shell 命令退出码 0=成功，与自定义 1/0 约定相反，导致断言结果全部反向（新增 `check_cmd`）
- bash 双引号外壳内 PowerShell 的 `$_` 会被 bash 展开，PowerShell 查询命令须用单引号外壳
- Git Bash `$!` 是 MSYS 内部 pid，与 Windows pid 不通，跨进程查询改用命令行特征匹配
- Windows `realpathSync.native` 对大小写翻转/短名输入返回的字符串形式不稳定（长短名不一），互斥正确性由 OS 大小写不敏感兑底，`lockDir` 字符串仅作诊断不作相等断言

## 5. 风险与边界

- `process.kill(pid, 0)` 在 Windows 对权限不足的进程可能误报 EPERM → 存活判定以 EPERM=存活、ESRCH=死亡处理
- pid 复用（陈锁 pid 恰好被其他进程占用）概率低但存在 → 锁内容含 `startedAt`，接管提示中带原始启动时间供人工判断；不追求绝对正确，接管方向错了也能通过「报错含 data 路径」让人工介入
- 本阶段**不做**：PM2 集成与生命周期命令（P0-B）、健康状态（P0-C）、开机自启（P2）

## 6. Git 约定

每任务一 commit，message 带 `wechat-p0a` 前缀；阶段完成更新 `dev-docs/progress/执行进度.md` 并写 `dev-docs/progress-result/` 阶段报告。
