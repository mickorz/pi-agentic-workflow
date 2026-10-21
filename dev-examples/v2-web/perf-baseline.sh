#!/usr/bin/env bash
# V2-P3-07 性能基线采集（真实数据，可复现）：
#   1) Server 冷启动→health 200 耗时
#   2) Run 生命周期延迟（fake runner 固定 250ms/agent，5-agent 脚本：POST→completed）
#   3) SSE 首帧延迟（逐行带时间戳读流）
#   4) 内存：Server / Worker 进程 RSS（pgrep 实抓 node 进程；Worker run 中采样）
# 用法：bash dev-examples/v2-web/perf-baseline.sh [port]
set -euo pipefail
PORT="${1:-4731}"
TOKEN="perf-fixed-token-0001"
BASE=$(mktemp -d /tmp/v2-perf.XXXXXX)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$BASE/proj"

cat > "$BASE/proj/p5.js" <<'EOF'
export const meta = { name: "p5_baseline", description: "perf" }
phase("load")
const a = await agent("a", { label: "a1" })
const b = await agent("b", { label: "a2" })
const c = await agent("c", { label: "a3" })
const d = await agent("d", { label: "a4" })
const e = await agent("e", { label: "a5" })
return { a, b, c, d, e }
EOF
cat > "$BASE/pi-workflow.config.json" <<EOF
{ "web": { "token": "$TOKEN", "port": $PORT, "projectRoots": ["$BASE/proj"] } }
EOF

stop_server() {
  pkill -f "dist/cli/index.js web --config $BASE" 2>/dev/null || true
}
trap stop_server EXIT

now_ms() { perl -MTime::HiRes=time -e 'printf "%.0f", time*1000'; }

echo "== 0. 环境 =="
echo "   node $(node -v) · $(uname -s) $(uname -m) · $(date '+%F %T')"

echo "== 1. Server 冷启动 → health 200 =="
T0=$(now_ms)
( cd "$BASE" && PI_WORKFLOW_TEST_RUNNER=fake PI_WORKFLOW_FAKE_DELAY_MS=250 \
    node "$REPO/dist/cli/index.js" web --config "$BASE" --port "$PORT" >/tmp/v2-perf-server.log 2>&1 & )
for _ in $(seq 1 200); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.05
done
T1=$(now_ms)
STARTUP_MS=$((T1-T0))
SERVER_PID=$(pgrep -f "dist/cli/index.js web --config $BASE" | head -1)
SRSS_IDLE=$(ps -o rss= -p "$SERVER_PID" | tr -d ' ')
echo "   启动耗时 ≈ ${STARTUP_MS}ms · pid=$SERVER_PID"
echo "   Server 空载 RSS ≈ $((SRSS_IDLE/1024))MB"

AUTH="Authorization: Bearer $TOKEN"
U="http://127.0.0.1:$PORT"

echo "== 2. Run 生命周期（5 agent × 250ms） =="
T0=$(now_ms)
RID=$(curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"projectId":"proj","path":"p5.js"}' "$U/api/runs" | jq -r .runId)
WPID=""; WRSS=0
for _ in $(seq 1 300); do
  DETAIL=$(curl -s -H "$AUTH" "$U/api/runs/$RID")
  S=$(echo "$DETAIL" | jq -r '.snapshot.effectiveStatus // empty')
  if [[ -z "$WPID" ]]; then
    P=$(echo "$DETAIL" | jq -r '.snapshot.manifest.pid // 0')
    if [[ "$P" != "0" && "$P" != "null" ]]; then WPID=$P; WRSS=$(ps -o rss= -p "$P" 2>/dev/null | tr -d ' ' || echo 0); fi
  fi
  [[ "$S" == "completed" ]] && break
  sleep 0.1
done
T1=$(now_ms)
RUN_MS=$((T1-T0))
echo "   POST→completed ≈ ${RUN_MS}ms（含 5×250ms 模拟延迟 + 100ms 轮询粒度）"
echo "   Worker RSS（run 中采样）≈ $((WRSS/1024))MB"

echo "== 3. SSE 首帧延迟（逐行时间戳） =="
T0=$(now_ms)
curl -s -N --max-time 30 -H "$AUTH" "$U/api/runs/$RID/stream" > /tmp/v2-perf-sse.txt &
CURL_PID=$!
FIRST=""
for _ in $(seq 1 600); do
  if [[ -s /tmp/v2-perf-sse.txt ]]; then
    FIRST=$(perl -ne 'if (/^(id|event):/) { print; exit }' /tmp/v2-perf-sse.txt)
    [[ -n "$FIRST" ]] && break
  fi
  sleep 0.02
done
T1=$(now_ms)
kill $CURL_PID 2>/dev/null || true
SSE_MS=$((T1-T0))
echo "   首帧到达 ≈ ${SSE_MS}ms（已完成 run 补传场景；帧：$(echo "$FIRST" | head -1)）"

echo "== 4. Server run 后 RSS =="
SRSS_AFTER=$(ps -o rss= -p "$SERVER_PID" | tr -d ' ')
echo "   Server RSS ≈ $((SRSS_AFTER/1024))MB（空载 $((SRSS_IDLE/1024))MB）"

echo "== 汇总（真实采集） =="
cat <<SUMMARY
   启动→health 200   : ${STARTUP_MS}ms
   5-agent run 全程  : ${RUN_MS}ms
   SSE 首帧(补传)    : ${SSE_MS}ms
   Server RSS 空载/后: $((SRSS_IDLE/1024))MB / $((SRSS_AFTER/1024))MB
   Worker RSS(run中) : $((WRSS/1024))MB
SUMMARY
rm -rf "$BASE"
