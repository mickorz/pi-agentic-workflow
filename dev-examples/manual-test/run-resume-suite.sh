#!/usr/bin/env bash
# G3/G4/G5 自动化测试：强杀 + resume 回放 + 哈希不匹配拒绝 + 副作用确认未决拒绝
# 顺序：kill 后 run 处于 interrupted，先测 G4（哈希拒绝）与 G5（未决确认拒绝），
#       最后 G3 收尾回放（resume 后 run 变 completed，无法再测 G4/G5）。
# 用法：bash run-resume-suite.sh（在本目录执行；需要 pi-workflow 全局命令与可用凭证）

set -u
cd "$(dirname "$0")"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "[PASS] $1"; }
bad() { FAIL=$((FAIL+1)); echo "[FAIL] $1"; }

# ── 启动并在 n1/n2 提交后强杀 ──
before=$(ls -t .pi-workflows/runs 2>/dev/null | head -1)
pi-workflow run 08-resume-three-nodes.js > /tmp/g3-run.log 2>&1 &
WPID=$!

RUNID=""
for i in $(seq 1 100); do
  cand=$(ls -t .pi-workflows/runs | head -1)
  if [ "$cand" != "$before" ] && [ -f ".pi-workflows/runs/$cand/journal.jsonl" ]; then
    RUNID=$cand; break
  fi
  sleep 0.3
done
if [ -z "$RUNID" ]; then
  bad "未捕获 runId"; kill -9 "$WPID" 2>/dev/null; exit 1
fi
echo "runId=$RUNID"

n=0
for i in $(seq 1 400); do
  n=$(wc -l < ".pi-workflows/runs/$RUNID/journal.jsonl" 2>/dev/null || echo 0)
  [ "${n:-0}" -ge 2 ] && break
  sleep 0.3
done
[ "${n:-0}" -ge 2 ] && ok "journal 到 2 行（n1/n2 已提交）" || bad "journal 未到 2 行（n=$n）"

kill -9 "$WPID" 2>/dev/null
wait "$WPID" 2>/dev/null
sleep 1

st=$(pi-workflow list 2>/dev/null | grep "$RUNID" || true)
echo "$st" | grep -q interrupted \
  && ok "强杀后状态 interrupted（死进程补偿）" || bad "状态非 interrupted: $st"

# ── G4: 哈希不匹配拒绝（run 仍为 interrupted）──
cp 08-resume-three-nodes.js /tmp/08-backup.js
sed -i 's/node-3-done/node-3-CHANGED/' 08-resume-three-nodes.js
out=$(pi-workflow resume "$RUNID" --yes --non-interactive 2>&1); rc=$?
echo "$out" | grep -q "RESUME_MISMATCH" && ok "G4 RESUME_MISMATCH 拒绝脚本变更" || bad "G4 未拒绝: $out"
[ "$rc" -eq 2 ] && ok "G4 exit 2" || bad "G4 exit=$rc"
cp /tmp/08-backup.js 08-resume-three-nodes.js

# ── G5: 副作用确认未决拒绝（非交互且未显式 --yes）──
out=$(pi-workflow resume "$RUNID" --non-interactive 2>&1); rc=$?
echo "$out" | grep -q "非交互模式需显式" && ok "G5 未决确认拒绝（需显式 --yes）" || bad "G5 输出异常: $out"
[ "$rc" -eq 2 ] && ok "G5 exit 2" || bad "G5 exit=$rc"

# ── G3 收尾: 正常回放恢复 ──
out=$(pi-workflow resume "$RUNID" --yes --non-interactive 2>&1); rc=$?
echo "$out" | grep -q "journal 2 条可回放" && ok "G3 resume 提示 journal 2 条可回放" || bad "G3 回放提示缺失: $out"
echo "$out" | grep -q "journal 回放"       && ok "G3 n1/n2 带 journal 回放标记"       || bad "G3 回放标记缺失"
[ "$rc" -eq 0 ] && ok "G3 resume exit 0" || bad "G3 resume exit=$rc"
lines=$(wc -l < ".pi-workflows/runs/$RUNID/journal.jsonl")
[ "$lines" -eq 3 ] && ok "G3 journal 最终 3 行" || bad "G3 journal 行数=$lines（预期 3）"

echo "===================="
echo "PASS=$PASS FAIL=$FAIL runId=$RUNID"
[ "$FAIL" -eq 0 ]
