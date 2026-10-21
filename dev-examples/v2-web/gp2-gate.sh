#!/usr/bin/env bash
# G-P2 浏览器验收门：真实 Chromium 驱动 Web 工作台全流程（TokenGate→New Run→实时→审批→拒绝→刷新重建→浏览器关闭 Worker 存活）。
set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="$(mktemp -d /tmp/gp2.XXXXXX)"
PORT=4651
WEB_PORT=5199
TOKEN="gp2-fixed-token-123456"
PASS=0; FAIL=0

cleanup() {
  [ -n "${VITE_PID:-}" ] && kill "$VITE_PID" 2>/dev/null
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  sleep 0.5
  [ -n "${SERVER_PID:-}" ] && kill -9 "$SERVER_PID" 2>/dev/null
  pkill -f "dist/cli/index.js web --config $BASE" 2>/dev/null
  pkill -f "vite --port $WEB_PORT" 2>/dev/null
  rm -rf "$BASE"
}
trap cleanup EXIT

count() { if echo "$1" | grep -q "PASS="; then P=$(echo "$1" | grep -oE "PASS=[0-9]+" | cut -d= -f2); F=$(echo "$1" | grep -oE "FAIL=[0-9]+" | cut -d= -f2); PASS=$((PASS+P)); FAIL=$((FAIL+F)); else FAIL=$((FAIL+1)); fi }

echo "== G-P2 浏览器门 BASE=$BASE =="

# 1) 准备项目脚本（agent/parallel/verify/checkpoint/长流程）
mkdir -p "$BASE/proj"
cat > "$BASE/proj/par.js" <<'EOF'
export const meta = { name: "par_demo", description: "phase + parallel agents" };
phase("fan-out")
const [a, b] = await parallel([
  () => agent("A", { label: "pa" }),
  () => agent("B", { label: "pb" }),
])
return { a, b }
EOF
cat > "$BASE/proj/cpv.js" <<'EOF'
export const meta = { name: "cpv_demo", description: "verify + checkpoint + agent" };
const v = await verify("1+1=2")
const ok = await checkpoint("允许继续吗？")
const r = await agent("after-cp")
return { real: v.real, ok, r }
EOF
cat > "$BASE/proj/long.js" <<'EOF'
export const meta = { name: "long_demo", description: "40 agents" };
phase("loop")
const out = []
for (let i = 0; i < 40; i++) out.push(await agent("step " + i, { label: "s" + i }))
return { steps: out.length }
EOF
cat > "$BASE/pi-workflow.config.json" <<EOF
{ "web": { "port": $PORT, "token": "$TOKEN", "projectRoots": ["./proj"] } }
EOF

# 2) 构建产物（Server 走 dist；Web 用 vite dev 代理）
( cd "$REPO" && npm run build >/dev/null 2>&1 ) || { echo "FAIL: dist build"; exit 1; }
( cd "$REPO/web" && npm run build >/dev/null 2>&1 ) || { echo "FAIL: web build"; exit 1; }

# 3) 启动 Server（fake runner 250ms/agent）与 vite dev
( cd "$BASE" && PI_WORKFLOW_TEST_RUNNER=fake PI_WORKFLOW_FAKE_DELAY_MS=250 node "$REPO/dist/cli/index.js" web --config "$BASE" >"$BASE/server.log" 2>&1 & echo $! > "$BASE/server.pid" )
SERVER_PID="$(cat "$BASE/server.pid")"
( cd "$REPO/web" && PI_WORKFLOW_WEB_PROXY_TARGET="http://127.0.0.1:$PORT" npx vite --port $WEB_PORT --strictPort >"$BASE/vite.log" 2>&1 & echo $! > "$BASE/vite.pid" )
VITE_PID="$(cat "$BASE/vite.pid")"

for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "FAIL: server 未起"; exit 1; }
for i in $(seq 1 60); do curl -sf "http://localhost:$WEB_PORT/" >/dev/null && break; sleep 0.5; done
curl -sf "http://localhost:$WEB_PORT/" >/dev/null || { echo "FAIL: vite 未起（$(tail -3 "$BASE/vite.log")）"; exit 1; }

# 4) 跑浏览器验收
OUT="$(cd "$REPO/dev-examples/v2-web" && WEB_URL="http://localhost:$WEB_PORT" TOKEN="$TOKEN" API="http://127.0.0.1:$PORT" npx tsx gp2-browser.mts 2>&1)"
echo "$OUT"
count "$OUT"

echo "== G-P2 结果：PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] && [ "$PASS" -ge 15 ]
