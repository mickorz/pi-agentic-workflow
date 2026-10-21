#!/usr/bin/env bash
# P3-02 故障注入套件：每项故障后状态正确、不假成功（interrupted / 可恢复 / 去重）
# F1 Worker SIGKILL → interrupted + resume 恢复（journal 回放去重）
# F2 Server SIGKILL + 重启 → 孤儿 Worker 收敛 + 状态持久 + resume 恢复
# F3 journal 尾损（截断半行）→ 前缀回放 + 缺尾重执行，不假成功
# F4 审批重复点击（并发同版本双 POST）→ 恰一个生效，其余 409，run 只完成一次
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=4661
TOKEN="p302-fixed-token-0123456789abcdef"
BASE_URL="http://127.0.0.1:${PORT}"
AUTH="Authorization: Bearer $TOKEN"
PASS=0; FAIL=0; SRV_PID=""
SRV_LOG="/tmp/p302-fault-server.log"
BASE="$(mktemp -d /tmp/p302-fault.XXXXXX)"
mkdir -p "$BASE/proj"

ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
assert_eq() { # desc expected actual
  if [ "$2" = "$3" ]; then ok "$1（=$3）"; else bad "$1：期望 $2 实际 $3"; fi
}

cleanup() { stop_server; rm -rf "$BASE"; }
stop_server() {
  if [ -n "${SRV_PID:-}" ]; then
    kill "$SRV_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6; do kill -0 "$SRV_PID" 2>/dev/null || break; sleep 0.3; done
    kill -0 "$SRV_PID" 2>/dev/null && kill -9 "$SRV_PID" 2>/dev/null
    wait "$SRV_PID" 2>/dev/null; SRV_PID=""
  fi
  pkill -TERM -f "dist/cli/index.js web --config $BASE" 2>/dev/null; sleep 0.5
  pkill -KILL -f "dist/cli/index.js web --config $BASE" 2>/dev/null
  for _ in $(seq 1 12); do lsof -i :"$PORT" >/dev/null 2>&1 || break; sleep 0.3; done
}
start_server() {
  ( cd "$BASE" && PI_WORKFLOW_TEST_RUNNER=fake PI_WORKFLOW_FAKE_DELAY_MS=150 \
    node "$REPO/dist/cli/index.js" web --config "$BASE" --port "$PORT" >"$SRV_LOG" 2>&1 & echo $! > /tmp/p302-srv.pid )
  for _ in $(seq 1 60); do curl -sf -o /dev/null "$BASE_URL/api/health" && break; sleep 0.2; done
  SRV_PID="$(cat /tmp/p302-srv.pid)"
}
api() { # method path [data]
  if [ $# -ge 3 ]; then
    curl -s -o /tmp/p302-body -w "%{http_code}" -X "$1" -H "$AUTH" -H "Content-Type: application/json" -d "$3" "$BASE_URL$2"
  else
    curl -s -o /tmp/p302-body -w "%{http_code}" -X "$1" -H "$AUTH" "$BASE_URL$2"
  fi
}
jget() { jq -r "$1" /tmp/p302-body; }
wait_status() { # runId expectedStatus...（任一命中返回命中值，超时返回空）
  local rid="$1"; shift
  for _ in $(seq 1 200); do
    api GET "/api/runs/$rid" >/dev/null
    local s; s="$(jget '.snapshot.effectiveStatus // .snapshot.status')"
    for want in "$@"; do [ "$s" = "$want" ] && { echo "$s"; return 0; }; done
    sleep 0.3
  done
  echo ""
}
start_run() { # scriptLabel path -> runId
  local code; code=$(api POST /api/runs "{\"projectId\":\"proj\",\"path\":\"$2\"}")
  [ "$code" = "202" ] || { bad "启动 $1 失败 http=$code $(cat /tmp/p302-body)"; echo ""; return; }
  jget '.runId'
}

trap cleanup EXIT

# ---------- fixtures ----------
cat > "$BASE/proj/par.js" <<'EOF'
export const meta = { name: "fault_par", description: "two parallel agents" };
phase("fan");
const [a, b] = await Promise.all([agent("pa", { label: "pa" }), agent("pb", { label: "pb" })]);
return a && b;
EOF
cat > "$BASE/proj/long.js" <<'EOF'
export const meta = { name: "fault_long", description: "40 agents for kill windows" };
phase("long");
const out = [];
for (let i = 1; i <= 40; i++) out.push(await agent("s" + i, { label: "n" + i }));
return out.length;
EOF
cat > "$BASE/proj/cpv.js" <<'EOF'
export const meta = { name: "fault_cpv", description: "checkpoint for duplicate decision" };
phase("cp");
await agent("pre", { label: "pre" });
const okGo = await checkpoint("允许继续吗？");
if (okGo) { await agent("post", { label: "post" }); return true; }
return false;
EOF
cat > "$BASE/proj/boom.js" <<'EOF'
export const meta = { name: "fault_boom", description: "crash at end (tail loss target)" };
phase("b");
await agent("b1", { label: "b1" });
await agent("b2", { label: "b2" });
return "done";
EOF
cat > "$BASE/pi-workflow.config.json" <<EOF
{ "web": { "port": $PORT, "token": "$TOKEN", "projectRoots": ["./proj"] } }
EOF

echo "== 构建 dist =="
( cd "$REPO" && npm run build >/dev/null 2>&1 ) || { echo "FAIL: build"; exit 1; }
start_server

echo
echo "===== F1：Worker SIGKILL → interrupted（不假成功）+ resume 回放去重 ====="
RID="$(start_run long.js long.js)"
[ -n "$RID" ] || exit 1
# 等 worker pid 落 manifest 且 journal 攒下若干节点（pid 在 snapshot.manifest.pid）
WPID=""
for _ in $(seq 1 80); do
  api GET "/api/runs/$RID" >/dev/null
  WPID="$(jget '.snapshot.manifest.pid // empty')"
  JN="$(jget '.snapshot.journalEntries // 0')"
  [ -n "$WPID" ] && [ "$WPID" != "null" ] && [ "$JN" -ge 3 ] 2>/dev/null && break
  sleep 0.3
done
assert_eq "F1 manifest 有 worker pid" "yes" "$([ -n "$WPID" ] && [ "$WPID" != "null" ] && echo yes || echo no)"
sleep 1.5   # 让 journal 攒下若干节点
kill -9 "$WPID" 2>/dev/null
ST="$(wait_status "$RID" interrupted cancelled completed failed)"
assert_eq "F1 kill -9 后终态=interrupted" "interrupted" "${ST:-timeout}"
api GET "/api/runs/$RID" >/dev/null
assert_eq "F1 无 result（不假成功）" "null" "$(jget '.snapshot.result // "null"' | head -c 20 >/dev/null && jget 'if .snapshot.result then "has" else "null" end')"
CODE=$(api POST "/api/runs/$RID/resume" '{}')
assert_eq "F1 resume 未 ack → 409 SIDE_EFFECTS_UNACKNOWLEDGED" "409" "$CODE"
assert_eq "F1 错误码" "SIDE_EFFECTS_UNACKNOWLEDGED" "$(jget '.code')"
CODE=$(api POST "/api/runs/$RID/resume" '{"acknowledgeSideEffects":true}')
assert_eq "F1 resume ack → 200" "200" "$CODE"
ST="$(wait_status "$RID" completed)"
assert_eq "F1 resume 后 completed" "completed" "${ST:-timeout}"
api GET "/api/runs/$RID/events?limit=1000" >/dev/null
DUP=$(jget '[.events[] | select(.type=="run.completed")] | length')
assert_eq "F1 run.completed 恰一次" "1" "$DUP"
REPLAYED=$(jget '[.events[] | select(.type=="node.replayed")] | length')
[ "$REPLAYED" -ge 1 ] && ok "F1 journal 回放(replayed=${REPLAYED})" || bad "F1 无 node.replayed（journal 未复用？）"
LASTSEQ=$(jget '.lastSequence')
EVCOUNT=$(jget '[.events[] | select(.sequence>0)] | length')
assert_eq "F1 事件 sequence 无重复" "$LASTSEQ" "$EVCOUNT"

echo
echo "===== F2：Server SIGKILL + 重启 → 持久 + 孤儿收敛 + resume 恢复 ====="
RID2="$(start_run long.js long.js)"
[ -n "$RID2" ] || exit 1
sleep 2
api GET "/api/runs" >/dev/null
TOTAL_BEFORE=$(jget '.total')
kill -9 "$SRV_PID" 2>/dev/null
pkill -KILL -f "dist/cli/index.js web --config $BASE" 2>/dev/null
sleep 1
start_server
api GET "/api/runs" >/dev/null
assert_eq "F2 重启后 run 总数不变" "$TOTAL_BEFORE" "$(jget '.total')"
ST="$(wait_status "$RID2" cancelled interrupted)"
assert_eq "F2 孤儿 Worker 收敛（cancelled/interrupted，不假成功）" "yes" "$([ -n "$ST" ] && echo yes || echo no)"
CODE=$(api POST "/api/runs/$RID2/resume" '{"acknowledgeSideEffects":true}')
assert_eq "F2 resume ack → 200" "200" "$CODE"
ST="$(wait_status "$RID2" completed)"
assert_eq "F2 resume 后 completed" "completed" "${ST:-timeout}"

echo
echo "===== F3：journal 尾损（截断半行）→ 前缀回放 + 缺尾重执行 ====="
RID3="$(start_run boom.js boom.js)"
[ -n "$RID3" ] || exit 1
ST="$(wait_status "$RID3" completed)"
assert_eq "F3 基线 run completed" "completed" "${ST:-timeout}"
RUNDIR="$BASE/.pi-workflows/runs/$RID3"
node -e '
const fs = require("fs");
const p = process.argv[1];
const raw = fs.readFileSync(p, "utf-8");
// 尾损：砍掉最后一行完整条目，再把新的末行截成半行 JSON（无换行）
const lines = raw.split("\n").filter(Boolean);
const cut = lines.slice(0, -1).join("\n") + "\n" + lines[lines.length-1].slice(0, 20);
fs.writeFileSync(p, cut);
console.log("journal lines:", lines.length, "-> damaged tail");
' "$RUNDIR/journal.jsonl" || bad "F3 journal 损坏注入失败"
node -e '
const fs = require("fs");
const p = process.argv[1];
const m = JSON.parse(fs.readFileSync(p, "utf-8"));
m.status = "interrupted"; m.pid = 999999999;   // 模拟崩溃遗留：interrupted + 死 pid
delete m.endedAt;
fs.writeFileSync(p, JSON.stringify(m, null, 2));
' "$RUNDIR/manifest.json"
CODE=$(api POST "/api/runs/$RID3/resume" '{}')
assert_eq "F3 journal 非空 resume 未 ack → 409" "409" "$CODE"
CODE=$(api POST "/api/runs/$RID3/resume" '{"acknowledgeSideEffects":true}')
assert_eq "F3 resume ack → 200（半行被跳过，前缀回放）" "200" "$CODE"
ST="$(wait_status "$RID3" completed)"
assert_eq "F3 尾损后恢复 completed（缺尾节点重执行）" "completed" "${ST:-timeout}"
api GET "/api/runs/$RID3" >/dev/null
AGENTS=$(jget '.snapshot.result.agentCount // -1')
assert_eq "F3 agentCount 仍为 2（不膨胀不假成功）" "2" "$AGENTS"

echo
echo "===== F4：审批重复点击（并发同版本双 POST）→ 恰一个生效 ====="
RID4="$(start_run cpv.js cpv.js)"
[ -n "$RID4" ] || exit 1
ST="$(wait_status "$RID4" waiting_checkpoint)"
assert_eq "F4 进入 waiting_checkpoint" "waiting_checkpoint" "${ST:-timeout}"
api GET "/api/runs/$RID4/checkpoints" >/dev/null
CPID="$(jget '.checkpoints[0].checkpointId // empty')"
VER="$(jget '.checkpoints[0].version // empty')"
assert_eq "F4 拿到 pending checkpoint" "yes" "$([ -n "$CPID" ] && [ -n "$VER" ] && echo yes || echo no)"
# 并发同决策双 POST：同 checkpointId 同 expectedVersion（幂等语义：同决策+同版本重放 → 200 idempotent）
BODY="{\"decision\":\"approve\",\"expectedVersion\":$VER}"
api POST "/api/runs/$RID4/checkpoints/$CPID/decision" "$BODY" > /tmp/p302-c1 &
P1=$!
api POST "/api/runs/$RID4/checkpoints/$CPID/decision" "$BODY" > /tmp/p302-c2 &
P2=$!
wait $P1 $P2
C1=$(cat /tmp/p302-c1); C2=$(cat /tmp/p302-c2)
OKS=0
for c in "$C1" "$C2"; do [ "$c" = "200" ] || [ "$c" = "409" ] || bad "F4 并发返回非预期码 $c"; [ "$c" = "200" ] && OKS=$((OKS+1)); done
[ "$OKS" -ge 1 ] && ok "F4 并发至少一个 200（$C1/${C2}）" || bad "F4 并发无 200（$C1/${C2}）"
ST="$(wait_status "$RID4" completed)"
assert_eq "F4 run 恰完成一次" "completed" "${ST:-timeout}"
api GET "/api/runs/$RID4/checkpoints" >/dev/null
assert_eq "F4 checkpoint 终态 approved 恒一次" "approved" "$(jget '.checkpoints[0].status')"
assert_eq "F4 checkpoint version 不再叠版" "$VER" "$(jget '.checkpoints[0].version')"
# 已决策后：同决策同版本重放 → 200 幂等（设计语义）；不同决策 → 409
CODE=$(api POST "/api/runs/$RID4/checkpoints/$CPID/decision" "$BODY")
assert_eq "F4 同决策重放 → 200 幂等" "200" "$CODE"
CODE=$(api POST "/api/runs/$RID4/checkpoints/$CPID/decision" "{\"decision\":\"reject\",\"expectedVersion\":$VER}")
assert_eq "F4 已 approve 后 reject → 409" "409" "$CODE"
api GET "/api/runs/$RID4/events?limit=1000" >/dev/null
COMPLETED=$(jget '[.events[] | select(.type=="run.completed")] | length')
assert_eq "F4 run.completed 恰一次" "1" "$COMPLETED"

# F4b：并发反向决策（同版本 approve+reject）→ 恰一个生效，另一个 409
RID5="$(start_run cpv.js cpv.js)"
[ -n "$RID5" ] || exit 1
ST="$(wait_status "$RID5" waiting_checkpoint)"
assert_eq "F4b 进入 waiting_checkpoint" "waiting_checkpoint" "${ST:-timeout}"
api GET "/api/runs/$RID5/checkpoints" >/dev/null
CPID5="$(jget '.checkpoints[0].checkpointId // empty')"
VER5="$(jget '.checkpoints[0].version // empty')"
api POST "/api/runs/$RID5/checkpoints/$CPID5/decision" "{\"decision\":\"approve\",\"expectedVersion\":$VER5}" > /tmp/p302-d1 &
Q1=$!
api POST "/api/runs/$RID5/checkpoints/$CPID5/decision" "{\"decision\":\"reject\",\"expectedVersion\":$VER5}" > /tmp/p302-d2 &
Q2=$!
wait $Q1 $Q2
D1=$(cat /tmp/p302-d1); D2=$(cat /tmp/p302-d2)
ONES=0; CONFLICTS=0
for c in "$D1" "$D2"; do [ "$c" = "200" ] && ONES=$((ONES+1)); [ "$c" = "409" ] && CONFLICTS=$((CONFLICTS+1)); done
assert_eq "F4b 反向并发恰一个 200" "1" "$ONES"
assert_eq "F4b 另一个 409" "1" "$CONFLICTS"
api GET "/api/runs/$RID5/checkpoints" >/dev/null
FINALST="$(jget '.checkpoints[0].status')"
[ "$FINALST" = "approved" ] || [ "$FINALST" = "rejected" ] && ok "F4b 终态确定性（${FINALST}）" || bad "F4b 终态不确定：$FINALST"
ST="$(wait_status "$RID5" completed failed)"
[ -n "$ST" ] && ok "F4b run 按决策收敛（${ST}，与终态一致）" || bad "F4b run 未收敛"
[ "$FINALST" = "approved" ] && [ "$ST" = "completed" ] || { [ "$FINALST" = "rejected" ] && [ "$ST" = "failed" ]; } && ok "F4b 决策与终态一致" || bad "F4b 决策/终态不一致：$FINALST/$ST"

echo
echo "== 结果：PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "HAS FAILURES"
[ "$FAIL" -eq 0 ]
