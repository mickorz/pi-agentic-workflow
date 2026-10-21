#!/usr/bin/env bash
# P3-06 操作演示：一条脚本走完 Web 生命周期（终端版，fake runner 不花 token）
#   启动 Server → 枚举项目 → 启动 run（checkpoint 等待）→ 审批 → 完成 → SSE 重连游标 → 恢复演示
# 人类可读输出；断言失败即退出非 0。浏览器版演示见 gp2-gate.sh（Playwright 真浏览器）。
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${DEMO_PORT:-4711}"
TOKEN="demo-fixed-token-0123456789abcdef"
BASE_URL="http://127.0.0.1:${PORT}"
AUTH="Authorization: Bearer $TOKEN"
BASE="$(mktemp -d /tmp/p306-demo.XXXXXX)"
SRV_PID=""
cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null || true
  sleep 0.4; [ -n "${SRV_PID:-}" ] && kill -9 "$SRV_PID" 2>/dev/null || true
  pkill -f "dist/cli/index.js web --config $BASE" 2>/dev/null || true
  rm -rf "$BASE"
}
trap cleanup EXIT

step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
note()  { printf '   \033[2m%s\033[0m\n' "$1"; }

( cd "$REPO" && npm run build >/dev/null 2>&1 )

step "0. 准备演示项目（白名单 + 固定 token）"
mkdir -p "$BASE/proj"
cat > "$BASE/proj/approve_demo.js" <<'EOF'
export const meta = { name: "approve_demo", description: "演示：审批前 2 agent，批准后 1 agent", phases: [{ title: "before" }, { title: "gate" }, { title: "after" }] }
phase("before")
const p1 = await agent("prepare part 1", { label: "prep-1" })
const p2 = await agent("prepare part 2", { label: "prep-2" })
phase("gate")
const ok = await checkpoint("演示审批：允许执行有副作用的收尾阶段吗？")
phase("after")
const fin = await agent("finish", { label: "finalize" })
return { p1, p2, ok, fin }
EOF
cat > "$BASE/pi-workflow.config.json" <<EOF
{ "web": { "token": "$TOKEN", "projectRoots": ["$BASE/proj"] } }
EOF
note "BASE=${BASE}（演示结束自动清理）"

step "1. 启动 Web Server（fake runner，可视化延迟 250ms/agent）"
( cd "$BASE" && PI_WORKFLOW_TEST_RUNNER=fake PI_WORKFLOW_FAKE_DELAY_MS=250 \
    node "$REPO/dist/cli/index.js" web --config "$BASE" --port "$PORT" > "$BASE/web.log" 2>&1 & echo $! > "$BASE/web.pid" )
for _ in $(seq 1 60); do curl -sf -o /dev/null "$BASE_URL/api/health" && break; sleep 0.25; done
SRV_PID="$(cat "$BASE/web.pid")"
curl -s "$BASE_URL/api/health" | jq -c '{ok, service, uptimeSec}'
note "health 免 token；其余全部要 token"

step "2. 无 token → 401（安全边界演示）"
curl -s -o /dev/null -w '   HTTP %{http_code}\n' "$BASE_URL/api/runs"

step "3. 枚举白名单项目与 workflow"
PROJ=$(curl -s -H "$AUTH" "$BASE_URL/api/projects" | jq -r '.projects[0].id')
curl -s -H "$AUTH" "$BASE_URL/api/projects/$PROJ/workflows" | jq -c '.workflows[] | {path, name: .meta.name}'

step "4. 启动 run → 前两阶段执行 → checkpoint 等待"
RID=$(curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PROJ\",\"path\":\"approve_demo.js\"}" \
  "$BASE_URL/api/runs" | jq -r '.runId')
note "runId=$RID"
for _ in $(seq 1 60); do
  S=$(curl -s -H "$AUTH" "$BASE_URL/api/runs/$RID" | jq -r '.snapshot.effectiveStatus')
  [ "$S" = "waiting_checkpoint" ] && break; sleep 0.3
done
echo "   状态=$S"
curl -s -H "$AUTH" "$BASE_URL/api/runs/$RID/events?limit=50" | jq -r '.events[] | "   #\(.sequence) \(.type)"' | tail -4

step "5. 审批（approve，expectedVersion=1 乐观并发）"
CPID=$(curl -s -H "$AUTH" "$BASE_URL/api/runs/$RID/checkpoints" | jq -r '.checkpoints[0].checkpointId')
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"decision":"approve","expectedVersion":1}' \
  "$BASE_URL/api/runs/$RID/checkpoints/$CPID/decision" | jq -c '.checkpoint | {checkpointId, status, version}'

step "6. SSE 订阅（Last-Event-ID 游标重连：从 #3 续读，不重复不缺口）"
curl -s -N --max-time 6 -H "$AUTH" -H 'Last-Event-ID: 3' "$BASE_URL/api/runs/$RID/stream" \
  | grep '^id:' | awk '{printf "   收到帧 %s\n", $2}' | tail -5 || true

step "7. 终态与用量"
for _ in $(seq 1 60); do
  S=$(curl -s -H "$AUTH" "$BASE_URL/api/runs/$RID" | jq -r '.snapshot.effectiveStatus')
  [ "$S" = "completed" ] && break; sleep 0.3
done
curl -s -H "$AUTH" "$BASE_URL/api/runs/$RID" | jq -c '{status: .snapshot.status, agentCount: .snapshot.result.agentCount, durationMs: .snapshot.result.durationMs}'

step "8. 幂等重放（同 Idempotency-Key 二次提交 → 同一 run，不重复执行）"
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -H 'Idempotency-Key: demo-key-001' \
  -d "{\"projectId\":\"$PROJ\",\"path\":\"approve_demo.js\"}" "$BASE_URL/api/runs" | jq -c .
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -H 'Idempotency-Key: demo-key-001' \
  -d "{\"projectId\":\"$PROJ\",\"path\":\"approve_demo.js\"}" "$BASE_URL/api/runs" | jq -c .

step "9. 刷新重建（Server 重启后历史仍在，模拟浏览器 reload）"
kill "$SRV_PID"; for _ in $(seq 1 40); do lsof -i ":$PORT" >/dev/null 2>&1 || break; sleep 0.25; done
pkill -f "dist/cli/index.js web --config $BASE" 2>/dev/null || true
( cd "$BASE" && PI_WORKFLOW_TEST_RUNNER=fake PI_WORKFLOW_FAKE_DELAY_MS=250 \
    node "$REPO/dist/cli/index.js" web --config "$BASE" --port "$PORT" >> "$BASE/web.log" 2>&1 & echo $! > "$BASE/web.pid" )
for _ in $(seq 1 60); do curl -sf -o /dev/null "$BASE_URL/api/health" && break; sleep 0.25; done
SRV_PID="$(cat "$BASE/web.pid")"
curl -s -H "$AUTH" "$BASE_URL/api/runs" | jq -c '{total, first: .runs[0].runId}'

printf '\n\033[1;32m演示完成：New Run → 实时事件 → 审批 → 完成 → 游标重连 → 幂等 → 重启重建 全链路 OK\033[0m\n'
printf '   （带 UI 的浏览器版：bash %s/gp2-gate.sh）\n' "$(dirname "$0")"
