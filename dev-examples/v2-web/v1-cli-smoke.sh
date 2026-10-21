#!/usr/bin/env bash
# P3-03 E06：V1 CLI 旧命令验收（真实 SDK）+ V2 Web 只读兼容
#  validate / run（真实 SDK）/ status / list / run --non-interactive 等待态 / resume(终端审批 y) /
#  V2 Web Server 读 CLI 创建的 run（manifest/events 跨轨读取）
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=4681
TOKEN="p303-fixed-token-0123456789abcdef"
BASE_URL="http://127.0.0.1:${PORT}"
AUTH="Authorization: Bearer $TOKEN"
PASS=0; FAIL=0; SRV_PID=""
BASE="$(mktemp -d /tmp/p303-v1cli.XXXXXX)"

ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then ok "$1（=$3）"; else bad "$1：期望 $2 实际 $3"; fi }

CLI="$REPO/dist/cli/index.js"
cleanup() {
  if [ -n "${SRV_PID:-}" ]; then kill "$SRV_PID" 2>/dev/null; sleep 0.5; kill -9 "$SRV_PID" 2>/dev/null; fi
  pkill -f "dist/cli/index.js web --config $BASE" 2>/dev/null
  rm -rf "$BASE"
}
trap cleanup EXIT

echo "== 构建 dist =="
( cd "$REPO" && npm run build >/dev/null 2>&1 ) || { echo "FAIL: build"; exit 1; }

echo "== 1. validate（旧命令，合法/非法退出码） =="
node "$CLI" validate "$REPO/examples/smoke.js" --cwd "$BASE" >/dev/null 2>&1 && ok "validate 合法脚本 exit 0" || bad "validate 合法脚本非 0"
echo 'export const meta = { name: "X" }' > "$BASE/bad.js"   # 缺 description 之外再破坏语法
echo 'syntax ((((' >> "$BASE/bad.js"
node "$CLI" validate "$BASE/bad.js" --cwd "$BASE" >/dev/null 2>&1 && bad "validate 非法脚本误 0" || ok "validate 非法脚本 exit 2"

echo "== 2. list 空目录（旧命令 exit 0） =="
node "$CLI" list --cwd "$BASE" >/dev/null 2>&1 && ok "list 空 exit 0" || bad "list 空目录非 0"

echo "== 3. run examples/smoke.js（真实 SDK，旧主路径） =="
node "$CLI" run "$REPO/examples/smoke.js" --cwd "$BASE" > "$BASE/run1.out" 2>&1
RC=$?
assert_eq "run smoke.js exit 0" "0" "$RC"
grep -q "pi-workflow smoke ok" "$BASE/run1.out" && ok "真实 agent 回复出现在输出" || bad "输出未见预期回复：$(tail -3 "$BASE/run1.out")"
RID1=$(ls "$BASE/.pi-workflows/runs" | head -1)
[ -n "$RID1" ] && ok "runId 落盘 $RID1" || bad "未见 run 目录"

echo "== 4. status / list（旧命令读新 run；两者以 process.cwd() 为 base，需 cd） =="
( cd "$BASE" && node "$CLI" status "$RID1" 2>&1 | grep -qi "completed" ) && ok "status 显示 completed" || bad "status 未显示 completed"
( cd "$BASE" && node "$CLI" list 2>&1 | grep -q "$RID1" ) && ok "list 含该 run" || bad "list 缺该 run"

echo "== 5. run checkpoint-demo --non-interactive → 等待态 exit 3 =="
( cd "$BASE" && node "$CLI" run "$REPO/examples/checkpoint-demo.js" --non-interactive --cwd "$BASE" > "$BASE/run2.out" 2>&1 )
RC2=$?
assert_eq "等待态退出码 3" "3" "$RC2"
RID2=$(ls -t "$BASE/.pi-workflows/runs" | head -1)
grep -q "$RID1" <<<"$(ls "$BASE/.pi-workflows/runs")" || true

echo "== 6. resume + 终端审批（echo y → 批准 → 真实写文件 → exit 0） =="
( cd "$BASE" && printf 'y\n' | node "$CLI" resume "$RID2" > "$BASE/run2-resume.out" 2>&1 )
RC3=$?
assert_eq "resume 批准路径 exit 0" "0" "$RC3"
[ -f "$BASE/note.txt" ] && ok "note.txt 真实落盘（副作用执行）" || bad "note.txt 未创建：$(tail -5 "$BASE/run2-resume.out")"

echo "== 7. V2 Web Server 只读兼容：读 CLI 创建的 run =="
cat > "$BASE/pi-workflow.config.json" <<EOF
{ "web": { "port": $PORT, "token": "$TOKEN", "projectRoots": ["$REPO/examples"] } }
EOF
( cd "$BASE" && node "$CLI" web --config "$BASE" --port "$PORT" > "$BASE/web.log" 2>&1 & echo $! > "$BASE/web.pid" )
for _ in $(seq 1 50); do curl -sf -o /dev/null "$BASE_URL/api/health" && break; sleep 0.2; done
SRV_PID="$(cat "$BASE/web.pid")"
TOTAL=$(curl -s -H "$AUTH" "$BASE_URL/api/runs" | jq -r '.total')
assert_eq "Web list 读到 CLI runs（total=2）" "2" "$TOTAL"
EFF1=$(curl -s -H "$AUTH" "$BASE_URL/api/runs/$RID1" | jq -r '.snapshot.effectiveStatus')
assert_eq "Web 读 CLI manifest effectiveStatus=completed" "completed" "$EFF1"
EVCNT=$(curl -s -H "$AUTH" "$BASE_URL/api/runs/$RID1/events?limit=1000" | jq -r '[.events[] | select(.sequence>0)] | length')
[ "${EVCNT:-0}" -ge 3 ] && ok "Web 读 CLI events.jsonl（$EVCNT 条）" || bad "events 读取异常：$EVCNT"
AGENTS=$(curl -s -H "$AUTH" "$BASE_URL/api/runs/$RID1" | jq -r '.snapshot.result.agentCount // -1')
assert_eq "Web 读 CLI result.json agentCount=1" "1" "$AGENTS"

echo
echo "== 结果：PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "HAS FAILURES"
[ "$FAIL" -eq 0 ]
