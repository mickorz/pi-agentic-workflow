#!/usr/bin/env bash
# V2-P1 G-P1 总验收门：真实 Web Server（dist）+ 真实 Worker 子进程（fake agent runner）。
# 覆盖：health / 幂等 start 单创建 / SSE 顺序事件 / cancel / checkpoint 审批 /
#       completed resume 409 / Server 重启历史可读 / E13 穿越 403 / 未授权 401。
set -u
cd "$(dirname "$0")/../.." || exit 1

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { # check <desc> <expr...>
  local desc="$1"; shift
  if "$@"; then ok "$desc"; else bad "$desc"; fi
}

PORT=4631
REPO=$(pwd)
BASE=$(mktemp -d /tmp/v2-gp1-XXXX)
mkdir -p "$BASE/proj"

cat > "$BASE/proj/ok.js" <<'EOF'
export const meta = { name: "ok", description: "单 agent" }
const a = await agent("hi")
return { a }
EOF
cat > "$BASE/proj/long.js" <<'EOF'
export const meta = { name: "long", description: "40 agent 长 run（取消用）" }
const out = []
for (let i = 0; i < 40; i++) out.push(await agent(`step ${i}`))
return { n: out.length }
EOF
cat > "$BASE/proj/cp.js" <<'EOF'
export const meta = { name: "cp", description: "checkpoint 审批" }
const a = await agent("prepare")
const ok = await checkpoint("允许继续吗？")
const b = await agent("after")
return { a, ok, b }
EOF
cat > "$BASE/pi-workflow.config.json" <<EOF
{ "web": { "port": $PORT, "projectRoots": ["./proj"] } }
EOF

echo "== 构建 dist =="
npm run build > "$BASE/build.log" 2>&1 || { echo "FAIL: build"; exit 1; }

start_server() { # start_server <logfile>
  ( cd "$BASE" && PI_WORKFLOW_TEST_RUNNER=fake PI_WORKFLOW_FAKE_DELAY_MS=300 \
    node "$REPO/dist/cli/index.js" web --config "$BASE" --port $PORT > "$BASE/$(basename "$1")" 2>&1 & echo $! > "$BASE/server.pid" )
  SERVER_PID=$(cat "$BASE/server.pid")
  for _ in $(seq 1 40); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" && return 0
    sleep 0.25
  done
  return 1
}
stop_server() {
  kill "$SERVER_PID" 2>/dev/null
  # 子 shell 包一层导致 $! 是 wrapper：按精确命令行兜底清理 node 本体
  pkill -f "dist/cli/index.js web --config $BASE" 2>/dev/null
  for _ in $(seq 1 20); do
    curl -s -o /dev/null --max-time 0.5 "http://127.0.0.1:$PORT/api/health" || return 0
    sleep 0.25
  done
}

start_server "$BASE/server1.log" || { echo "FAIL: server 启动"; exit 1; }
TOKEN=$(grep -o 'token（本次会话）：.*' "$BASE/server1.log" | sed 's/token（本次会话）：//')
AUTH="Authorization: Bearer $TOKEN"
API="http://127.0.0.1:$PORT/api"
[ -n "$TOKEN" ] && ok "server 启动+token 提取" || bad "token 提取"

# 1 health
check "G1 health 200（免 token）" test "$(curl -s -o /dev/null -w '%{http_code}' $API/health)" = "200"

# 2 未授权不可读（events/list）+ E13 穿越 + 跨 Origin
RUNID=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -H "Idempotency-Key: gp1-key-1" -d '{"projectId":"proj","path":"ok.js"}' $API/runs \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')
check "G2 幂等 start 202 且返回 runId" test -n "$RUNID"
RUNID2=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -H "Idempotency-Key: gp1-key-1" -d '{"projectId":"proj","path":"ok.js"}' $API/runs \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["runId"], d.get("replayed"))')
check "G2 同幂等键 → 同 runId+replayed" test "$RUNID2" = "$RUNID True"
TOTAL=$(curl -s -H "$AUTH" "$API/runs" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])')
check "G2 幂等=单创建（total=1）" test "$TOTAL" = "1"

check "G3 未授权不可读事件（401）" test "$(curl -s -o /dev/null -w '%{http_code}' $API/runs/$RUNID/events)" = "401"
E13=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"projectId":"proj","path":"../../etc/passwd"}' $API/runs)
check "G3 E13 路径穿越被拒（403）" test "$E13" = "403"
check "G3 跨 Origin 被拒（403）" test "$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H "Origin: http://evil.example" $API/projects)" = "403"

# 4 等完成 + SSE 顺序事件（断连重连补传用 Last-Event-ID）
for _ in $(seq 1 40); do
  ST=$(curl -s -H "$AUTH" $API/runs/$RUNID | python3 -c 'import json,sys; print(json.load(sys.stdin)["snapshot"]["status"])' 2>/dev/null)
  [ "$ST" = "completed" ] && break; sleep 0.5
done
check "G4 run 真实完成（Worker 子进程）" test "$ST" = "completed"
curl -s -N --max-time 8 -H "$AUTH" "$API/runs/$RUNID/stream" > "$BASE/sse1.txt"
check "G4 SSE 流含顺序事件+done" bash -c "grep -q 'id: 1' $BASE/sse1.txt && grep -q 'run.completed' $BASE/sse1.txt && grep -q 'event: done' $BASE/sse1.txt"
LAST=$(grep -o '^id: [0-9]*' "$BASE/sse1.txt" | tail -1 | cut -d' ' -f2)
curl -s -N --max-time 6 -H "$AUTH" -H "Last-Event-ID: $LAST" "$API/runs/$RUNID/stream" > "$BASE/sse2.txt"
check "G4 SSE 游标重连零重复补传" bash -c "! grep -q 'id: 1\b' $BASE/sse2.txt && grep -q 'event: done' $BASE/sse2.txt"

# 5 cancel：长 run 中途取消 → cancelled
CRUN=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"projectId":"proj","path":"long.js"}' $API/runs | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')
sleep 2
CRES=$(curl -s -X POST -H "$AUTH" $API/runs/$CRUN/cancel | python3 -c 'import json,sys; print(json.load(sys.stdin)["snapshot"]["status"])')
check "G5 cancel → cancelled（幂等快照）" test "$CRES" = "cancelled"

# 6 checkpoint 审批：cp.js → waiting → approve → completed
PRUN=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"projectId":"proj","path":"cp.js"}' $API/runs | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')
for _ in $(seq 1 40); do
  PST=$(curl -s -H "$AUTH" $API/runs/$PRUN | python3 -c 'import json,sys; print(json.load(sys.stdin)["snapshot"]["status"])' 2>/dev/null)
  [ "$PST" = "waiting_checkpoint" ] && break; sleep 0.5
done
check "G6 checkpoint 挂起 waiting_checkpoint" test "$PST" = "waiting_checkpoint"
CP=$(curl -s -H "$AUTH" $API/runs/$PRUN/checkpoints | python3 -c 'import json,sys; d=json.load(sys.stdin)["checkpoints"][0]; print(d["checkpointId"], d["version"], d["status"])')
CPID=$(echo "$CP" | cut -d' ' -f1); CPV=$(echo "$CP" | cut -d' ' -f2)
check "G6 审批清单 pending" test "$(echo "$CP" | cut -d' ' -f3)" = "pending"
DRES=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"decision\":\"approve\",\"expectedVersion\":$CPV}" $API/runs/$PRUN/checkpoints/$CPID/decision \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["checkpoint"]["status"])')
check "G6 approve → approved" test "$DRES" = "approved"
for _ in $(seq 1 40); do
  PST=$(curl -s -H "$AUTH" $API/runs/$PRUN | python3 -c 'import json,sys; print(json.load(sys.stdin)["snapshot"]["status"])' 2>/dev/null)
  [ "$PST" = "completed" ] && break; sleep 0.5
done
check "G6 审批后 run completed" test "$PST" = "completed"

# 7 resume 语义：completed run resume → 409（不允许无意义恢复）
R7=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"acknowledgeSideEffects":true}' $API/runs/$RUNID/resume)
check "G7 completed resume → 409" test "$R7" = "409"
R7b=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{}' $API/runs/run-nope/resume)
check "G7 未知 run resume → 404" test "$R7b" = "404"

# 8 Server 重启 → 历史可读（幂等键缓存丢失但 run 历史完整）
stop_server
start_server "$BASE/server2.log" || { echo "FAIL: server 重启"; exit 1; }
TOKEN2=$(grep -o 'token（本次会话）：.*' "$BASE/server2.log" | sed 's/token（本次会话）：//')
AUTH2="Authorization: Bearer $TOKEN2"
LIST=$(curl -s -H "$AUTH2" $API/runs | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])')
check "G8 重启后历史可读（3 runs）" test "$LIST" = "3"
H8=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH2" $API/runs/$RUNID)
check "G8 重启后 run 快照 200" test "$H8" = "200"
check "G8 重启后 openapi 可用" test "$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH2" $API/openapi.json)" = "200"

stop_server

echo
echo "== G-P1 结果：PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ]
