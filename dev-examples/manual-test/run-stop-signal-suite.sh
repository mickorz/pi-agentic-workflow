#!/usr/bin/env bash
# G2(SIGINT 取消) / H(stop 跨进程终止) / I(事件流连续性) / J(超时失败路径) 自动化测试
# 平台说明（Windows）：
#   - MSYS/Git Bash 的 kill -INT 无法送达 Windows 原生进程（无同 console CTRL_C_EVENT），
#     G2 在此环境下不可自动化；PowerShell 终端手动 Ctrl-C 已验证（manifest=cancelled）。
#     脚本仍会尝试并如实报告 SKIP。
#   - stop 在 Windows 上表现为强杀 + 死进程补偿标 cancelled；POSIX 下被停进程 exit 130，
#     Windows 下 exit 非零（无法捕获信号），故 H 断言终态 cancelled + exit 非零。
# 用法：bash run-stop-signal-suite.sh（在本目录执行；需要 pi-workflow 全局命令与可用凭证）

set -u
cd "$(dirname "$0")"

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); echo "[PASS] $1"; }
bad()  { FAIL=$((FAIL+1)); echo "[FAIL] $1"; }
skip() { SKIP=$((SKIP+1)); echo "[SKIP] $1"; }

newest_run() { ls -t .pi-workflows/runs | head -1; }

wait_journal() { # $1=runId $2=期望行数
  for i in $(seq 1 400); do
    local n; n=$(wc -l < ".pi-workflows/runs/$1/journal.jsonl" 2>/dev/null || echo 0)
    [ "${n:-0}" -ge "$2" ] && return 0
    sleep 0.3
  done
  return 1
}

# 启动后台 run：全局变量 WPID（进程 pid）与 LAST_RUN（runId）
start_run() { # $1=script $2=log
  local before cand
  before=$(newest_run)
  pi-workflow run "$1" > "$2" 2>&1 &
  WPID=$!
  LAST_RUN=""
  for i in $(seq 1 100); do
    cand=$(newest_run)
    if [ "$cand" != "$before" ] && [ -f ".pi-workflows/runs/$cand/journal.jsonl" ]; then
      LAST_RUN=$cand; return 0
    fi
    sleep 0.3
  done
  return 1
}

# ── G2: SIGINT 取消 ──
if start_run 08-resume-three-nodes.js /tmp/g2-run.log; then
  RUNID=$LAST_RUN
  wait_journal "$RUNID" 1
  kill -INT "$WPID" 2>/dev/null
  wait "$WPID" 2>/dev/null; rc=$?
  if grep -q "收到 SIGINT" /tmp/g2-run.log; then
    ok "G2 SIGINT 送达并提示"
    [ "$rc" -eq 130 ] && ok "G2 exit 130" || bad "G2 exit=$rc（预期 130）"
    pi-workflow list | grep "$RUNID" | grep -q cancelled \
      && ok "G2 状态 cancelled" || bad "G2 状态非 cancelled"
  else
    skip "G2 MSYS 下 kill -INT 无法送达 Windows 进程（run 自行跑完）；手动 Ctrl-C 已验证 cancelled"
    kill -9 "$WPID" 2>/dev/null
  fi
else
  bad "G2 启动失败"
fi

# ── H: stop 跨进程终止 ──
if start_run 08-resume-three-nodes.js /tmp/h-run.log; then
  HID=$LAST_RUN
  sleep 2   # 等 manifest 写入 pid
  out=$(pi-workflow stop "$HID" 2>&1)
  echo "$out" | grep -q "SIGINT" && ok "H stop 发出终止信号" || bad "H stop 输出异常: $out"
  wait "$WPID" 2>/dev/null; rc=$?
  [ "$rc" -ne 0 ] && ok "H 被 stop 的 run 非零退出（$rc）" || bad "H exit=0（被停进程不应正常完成）"
  pi-workflow list | grep "$HID" | grep -q cancelled \
    && ok "H 终态 cancelled（死进程补偿）" || bad "H 状态非 cancelled"
  STOP_RUN=$HID
else
  bad "H 启动失败"; STOP_RUN=""
fi

# ── I: 事件流连续性（独立跑 01-smoke，天然包含全部事件类型）──
if start_run 01-smoke.js /tmp/i-run.log; then
  IID=$LAST_RUN
  wait "$WPID" 2>/dev/null
  EV=".pi-workflows/runs/$IID/events.jsonl"
  verdict=$(node -e "
const fs=require('fs');
const lines=fs.readFileSync(process.argv[1],'utf8').trim().split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
const seqs=lines.map(e=>e.sequence);
const cont=seqs.every((s,i)=>s===i+1);
const types=new Set(lines.map(e=>e.type));
const need=['run.started','node.started','node.completed','run.completed','agent.session.created'];
const missing=need.filter(t=>!types.has(t));
console.log((cont?'continuous':'BROKEN')+'|'+(missing.length?'MISSING:'+missing.join(','):'types-ok'));
" "$EV")
  echo "$verdict" | grep -q "^continuous" && ok "I sequence 连续递增无断裂" || bad "I sequence 断裂: $verdict"
  echo "$verdict" | grep -q "types-ok" \
    && ok "I 含 run/node/agent.session 全部关键事件" || bad "I 缺事件: $verdict"
else
  bad "I 启动失败"
fi

# ── J: 超时失败路径（09 必然超时，预期 exit 1）──
out=$(pi-workflow run 09-timeout.js 2>&1); rc=$?
echo "$out" | grep -qE "AGENT_TIMEOUT|超时" && ok "J 超时被闸门吸收（AGENT_TIMEOUT）" || bad "J 输出异常: $out"
[ "$rc" -eq 1 ] && ok "J exit 1" || bad "J exit=$rc（预期 1）"

echo "===================="
echo "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
[ "$FAIL" -eq 0 ]
