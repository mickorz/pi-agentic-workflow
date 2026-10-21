#!/usr/bin/env bash
# AM-9 启动后绑定前崩溃（kill -9 注入）—— 两分支断言：自动补链 / unknown 禁重试
# 用法：bash dev-examples/am-p0/kill-window-suite.sh   （逐断言 PASS/FAIL，结尾汇总）
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENTRY="$ROOT/dev-examples/am-p0/crash-window.ts"
PASS=0; FAIL=0

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); say "PASS: $*"; }
bad()  { FAIL=$((FAIL+1)); say "FAIL: $*"; }

assert_eq() { # actual expected label
  if [ "$1" = "$2" ]; then ok "$3 (=$1)"; else bad "$3：期望 $2 实得 $1"; fi
}

run_child() { # mode dataDir → pid；等 READY 后由调用方 kill
  local mode="$1" dir="$2"
  npx tsx "$ENTRY" "$mode" "$dir" >"$dir/child.log" 2>&1 &
  CHILD_PID=$!
  for _ in $(seq 1 120); do
    grep -q READY "$dir/child.log" 2>/dev/null && return 0
    kill -0 "$CHILD_PID" 2>/dev/null || break
    sleep 0.25
  done
  return 1
}

kill_child() {
  kill -9 "$CHILD_PID" 2>/dev/null
  wait "$CHILD_PID" 2>/dev/null
}

TMP="$(mktemp -d /tmp/am-kill-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

say "── 分支 1：启动成功+绑定落盘 → kill -9 于 link 前 → 恢复自动补链"
D1="$TMP/case1"; mkdir -p "$D1"
if run_child prime-linked "$D1"; then
  kill_child
  OUT="$(npx tsx "$ENTRY" recover "$D1" | tail -1)"
  LINKED="$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.linked)})')"
  UNKNOW="$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.unknown)})')"
  assert_eq "$LINKED" 1 "对上 TaskBinding → 自动补链 1 条"
  assert_eq "$UNKNOW" 0 "无 unknown"
  STARTS="$(npx tsx "$ENTRY" service-starts "$D1" | tail -1)"
  assert_eq "$STARTS" 1 "恢复期零新启动（总启动数仍为崩溃前的 1）"
else
  bad "prime-linked 子进程未达 READY"
  kill_child 2>/dev/null
fi

say "── 分支 2：仅预写（start 前被杀）→ 恢复 unknown + 禁自动重试"
D2="$TMP/case2"; mkdir -p "$D2"
if run_child prime-unknown "$D2"; then
  kill_child
  OUT="$(npx tsx "$ENTRY" recover "$D2" | tail -1)"
  LINKED="$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.linked)})')"
  UNKNOW="$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.unknown)})')"
  assert_eq "$LINKED" 0 "无绑定 → 不补链"
  assert_eq "$UNKNOW" 1 "标记 unknown（人工核对）"
  STARTS="$(npx tsx "$ENTRY" service-starts "$D2" | tail -1)"
  assert_eq "$STARTS" 0 "禁自动重试：全程零启动"
else
  bad "prime-unknown 子进程未达 READY"
  kill_child 2>/dev/null
fi

say ""
say "汇总：PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
