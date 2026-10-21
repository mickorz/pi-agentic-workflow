#!/usr/bin/env bash
# P2-05 useRunEvents/RunEventSync E2E 冒烟（E16：断网刷新后 UI 状态重建不丢）
# phase1 刷新重建（终态 run 全量补拉）+ phase2 运行中断 Server → 重启 → 补漏收敛 interrupted
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=4641
# 固定 token：Server 重启后新会话 token 会变，固定 token 保证驱动进程跨重启可用
TOKEN="p205-fixed-token-0123456789abcdef"
BASE_URL="http://127.0.0.1:${PORT}"
PASS=0; FAIL=0
SRV_PID=""
SRV_LOG="/tmp/p205-sync-server.log"
DRIVER_PID=""

BASE="$(mktemp -d /tmp/p205-sync.XXXXXX)"
mkdir -p "$BASE/proj"

cleanup() {
  [ -n "$DRIVER_PID" ] && kill "$DRIVER_PID" 2>/dev/null
  stop_server
  rm -rf "$BASE"
}
stop_server() {
  # 先优雅 TERM；但 hijacked SSE 长连接会拖住优雅关停，宽限后必须 KILL 升级（E16 断网语义）
  if [ -n "${SRV_PID:-}" ]; then
    kill "$SRV_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6; do
      kill -0 "$SRV_PID" 2>/dev/null || break
      sleep 0.3
    done
    kill -0 "$SRV_PID" 2>/dev/null && kill -9 "$SRV_PID" 2>/dev/null
    wait "$SRV_PID" 2>/dev/null
    SRV_PID=""
  fi
  pkill -TERM -f "dist/cli/index.js web --config $BASE" 2>/dev/null
  sleep 0.5
  pkill -KILL -f "dist/cli/index.js web --config $BASE" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! lsof -i :"$PORT" >/dev/null 2>&1; then break; fi
    sleep 0.3
  done
}
start_server() {
  ( cd "$BASE" && PI_WORKFLOW_TEST_RUNNER=fake PI_WORKFLOW_FAKE_DELAY_MS=250 \
    node "$REPO/dist/cli/index.js" web --config "$BASE" --port "$PORT" >"$SRV_LOG" 2>&1 & echo $! > /tmp/p205-srv.pid )
  for _ in $(seq 1 50); do
    curl -sf -o /dev/null "$BASE_URL/api/health" && break
    sleep 0.2
  done
  SRV_PID="$(cat /tmp/p205-srv.pid)"
  echo "server pid=$SRV_PID"
}
count() {
  if grep -q "^PASS:" "$1" 2>/dev/null; then P=$(grep -c "^PASS:" "$1"); else P=0; fi
  if grep -q "^FAIL:" "$1" 2>/dev/null; then F=$(grep -c "^FAIL:" "$1"); else F=0; fi
  # 驱动崩溃/非零退出也计 FAIL（否则 0 断言会被误判 ALL PASS）
  if grep -q "DRIVER-ERROR" "$1" 2>/dev/null; then F=$((F+1)); fi
  PASS=$((PASS+P)); FAIL=$((FAIL+F))
}

trap cleanup EXIT

# ---------- 工程与脚本 ----------
cat > "$BASE/proj/ok.js" <<'EOF'
export const meta = { name: "smoke_ok", description: "single agent" };
phase("p1");
const r = await agent("ok", { label: "a1" });
return r;
EOF
cat > "$BASE/proj/long.js" <<'EOF'
export const meta = { name: "smoke_long", description: "long run for restart window" };
phase("long");
const out = [];
for (let i = 1; i <= 80; i++) {
  out.push(await agent("step " + i, { label: "s" + i }));
}
return out.length;
EOF
cat > "$BASE/pi-workflow.config.json" <<EOF
{ "web": { "port": $PORT, "token": "$TOKEN", "projectRoots": ["./proj"] } }
EOF

echo "== 构建 dist =="
( cd "$REPO" && npm run build >/dev/null 2>&1 ) || { echo "FAIL: build"; exit 1; }

start_server

echo "== phase1：刷新重建（终态 run）=="
OUT1="$(BASE_URL="$BASE_URL" TOKEN="$TOKEN" PROJECT=proj SCRIPT=ok.js PHASE=phase1 \
  npx tsx "$REPO/dev-examples/v2-web/sync-driver.mts" 2>&1)"
echo "$OUT1"
echo "$OUT1" > /tmp/p205-phase1.out
count /tmp/p205-phase1.out

echo "== phase2：运行中 kill Server → 重启 → 补漏收敛 =="
# 驱动进程后台跑，等 WATCH-READY 再杀 Server
( BASE_URL="$BASE_URL" TOKEN="$TOKEN" PROJECT=proj SCRIPT=long.js PHASE=phase2 \
    npx tsx "$REPO/dev-examples/v2-web/sync-driver.mts" > /tmp/p205-phase2.out 2>&1 ; echo $? > /tmp/p205-phase2.rc ) &
DRIVER_PID=$!

for _ in $(seq 1 120); do
  grep -q "WATCH-READY" /tmp/p205-phase2.out 2>/dev/null && break
  sleep 0.5
done
grep -q "WATCH-READY" /tmp/p205-phase2.out || { echo "FAIL: 未等到 WATCH-READY"; kill "$DRIVER_PID" 2>/dev/null; DRIVER_PID=""; }

echo "-- kill Server（模拟断网/进程崩溃）--"
stop_server
sleep 1
echo "-- 重启 Server --"
start_server

wait "$DRIVER_PID" 2>/dev/null
cat /tmp/p205-phase2.out
count /tmp/p205-phase2.out
DRIVER_PID=""

echo
echo "== 结果：PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "HAS FAILURES"
[ "$FAIL" -eq 0 ]
