# V2 Web 工作台快速上手

> 本地单用户 Web 控制台：New Run → 实时进度（SSE）→ checkpoint 人工审批 → 完成/失败/取消 → 刷新重建历史。
> 安全边界：仅监听 `127.0.0.1` + 本地 token；浏览器永不直接触碰文件系统/密钥/Pi SDK。

## 1. 安装与启动

```bash
npm ci && npm run build

# 启动 Web Server（默认 127.0.0.1:4317，启动横幅会打印本次 token 与 curl 示例）
node dist/cli/index.js web --host 127.0.0.1 --port 4317
```

启动后：

- API 基址：`http://127.0.0.1:4317`
- 交互文档：`GET /api/openapi.json`（带 token）
- 健康探测：`GET /api/health`（免 token，无敏感信息）

## 2. 启动 Web UI（开发模式）

```bash
cd web && npm ci && npm run dev
# 打开 http://localhost:5199 ，粘贴启动横幅里的 token 进入
```

生产部署用同源反代：`cd web && npm run build` 产物为 `web/dist`，与 API 同域托管即可（token 仍走 `Authorization` 头）。

## 3. 配置允许项目（projectRoots 白名单）

Web 只能运行**显式白名单**里的 workflow，绝不接受任意路径。两种方式：

**配置文件**（推荐）——项目根放 `pi-workflow.config.json`：

```json
{
  "web": {
    "host": "127.0.0.1",
    "port": 4317,
    "token": "换成你的随机长 token（也可不填，每次启动随机生成并打印）",
    "projectRoots": ["./examples", "/absolute/path/to/your/project"],
    "maxConcurrentRuns": 2,
    "eventRetentionDays": 30
  }
}
```

`node dist/cli/index.js web --config <目录>`（`--config` 接**目录**，读取其下的 `pi-workflow.config.json`；`projectRoots` 相对该目录解析）。

**环境变量**：`PI_WORKFLOW_WEB_PORT`（优先级：CLI > env > config > 默认 4317）。

注意：

- 白名单根做 `realpath` 归一，symlink 指向白名单外的脚本一律 403（防穿越）。
- workflow 脚本需 `export const meta = { name: "snake_case", ... }`（`name` 必须 snake_case）。

## 4. 一条命令的完整演示

```bash
# 终端 1：Server（fake runner 演示，不花 token；去掉 env 即真实 Pi SDK）
PI_WORKFLOW_TEST_RUNNER=fake PI_WORKFLOW_FAKE_DELAY_MS=300 \
  node dist/cli/index.js web --config . --port 4317

# 终端 2：浏览一遍生命周期
TOKEN=<粘贴横幅里的 token>
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4317/api/projects
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"projectId":"examples","path":"checkpoint-demo.js"}' \
  http://127.0.0.1:4317/api/runs          # → {"runId":"run-..."}，run 进入 waiting_checkpoint
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4317/api/runs/<runId>/checkpoints
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"decision":"approve","expectedVersion":1}' \
  http://127.0.0.1:4317/api/runs/<runId>/checkpoints/<checkpointId>/decision
```

带 UI 的完整演示脚本（真实浏览器走 New Run → 审批 → 刷新重建）：`dev-examples/v2-web/demo-web.sh`。

## 5. 常见问题（FAQ / 故障排查）

| 症状 | 原因与处置 |
|---|---|
| 所有 API 返回 401 `UNAUTHORIZED` | token 缺失/不匹配。token 只认 `Authorization: Bearer <t>` 或 `X-PI-Workflow-Token` 头，**绝不读 URL query**（含 SSE）。从启动横幅复制本次 token；配置文件 `web.token` 可固定。 |
| 浏览器跨域请求 403 `FORBIDDEN` | Web Server 拒绝一切跨 Origin。开发模式必须走 vite dev 代理（`web/` 已配好，`PI_WORKFLOW_WEB_PROXY_TARGET` 可改上游）；生产同源部署。curl（无 Origin 头）不受影响。 |
| 429 `RATE_LIMITED` | 默认 60s/600 次（每 IP）；连按重试或轮询过密会触发，稍候即可。 |
| 429 `RUN_LIMIT_REACHED` | 并发 run 到达 `maxConcurrentRuns` 上限：等待现有 run 结束、或在 UI 取消、或调大配置。 |
| 409 `SIDE_EFFECTS_UNACKNOWLEDGED` | 恢复 interrupted run 必须显式确认副作用（UI 勾选 / API `acknowledgeSideEffects:true`）。这是设计行为，不会自动放行。 |
| run 显示「已中断」但没在跑 | Worker 被杀（kill/崩溃）。`effectiveStatus` 按 manifest+pid 探活判 interrupted，resume 可断点续跑。 |
| 端口被占用 | 换 `--port`，或先 `lsof -i :4317` 清理旧进程。 |
| `web` 命令行数与文档不符 | 全局 link 旧了：仓库根 `npm run build`（bin 指向 dist，rebuild 自动生效）。 |

更多排障见 [troubleshooting.md](troubleshooting.md)。

## 6. 与 CLI 的关系

- Web 与 CLI 共用同一套 manifest/journal/events 落盘（`.pi-workflows/runs/<runId>/`）：CLI 跑的 run 会出现在 Web 历史里，反之亦然（只读互通）。
- V1 CLI（`run/resume/stop/list/status/validate`）不受 V2 影响，退出码语义不变。
- 进一步的 API 语义（幂等键/游标/SSE 帧）见 [web-api-contract.md](web-api-contract.md) 与 [api/web-openapi.json](api/web-openapi.json)（也可启动后 `GET /api/openapi.json` 实时获取）。
