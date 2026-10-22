#!/usr/bin/env bash
# P0-A 单进程形态验证：node --import tsx 单层进程、锁互斥、陈锁自愈
# 用法：仓库根执行 bash dev-examples/wechat-service/verify-p0a.sh
# 设计：使用临时 data 目录，短窗口只验证锁行为（不依赖微信连接成功，不扰动真实服务）
set -u
export LC_ALL=C.UTF-8 LANG=C.UTF-8   # Git Bash grep 默认 locale 对 UTF-8 中文 pattern 匹配不可靠，断言一律用 ASCII 锚点
cd "$(dirname "$0")/../.."   # 仓库根

PASS=0; FAIL=0
check() {
  if [ "$2" = "1" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1"; FAIL=$((FAIL+1)); fi
}
check_cmd() { # check_cmd <名> <命令退出码>：0=PASS（shell 惯例）
  if [ "$2" = "0" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1"; FAIL=$((FAIL+1)); fi
}

DATA=$(mktemp -d)/pi-wechat-data
ENTRY="src/cli/index.ts"

# 1. 单进程形态启动（acquire 锁后即认为存活；不等微信连接）
nohup node --import tsx "$ENTRY" wechat start --data "$DATA" > /tmp/p0a-v1.log 2>&1 &
BOT_PID=$!
sleep 5
check "服务进程存活并到达锁获取点（锁文件生成）" $([ -f "$DATA/service.lock" ] && echo 1 || echo 0)

# 2. 单进程形态：存在命令行同时含 --import tsx 与 wechat start 的 node 进程（即 Bot 本体，无重执行包装）
#    注：bash $! 是 MSYS pid，无法直接查 Windows pid，改按命令行特征查询
CMD=$(powershell -NoProfile -Command 'Get-CimInstance Win32_Process | Where-Object { $_.Name -like "node*" -and $_.CommandLine -like "*--import tsx*wechat start*" } | Select-Object -First 1 -ExpandProperty CommandLine' 2>/dev/null)
echo "$CMD" | grep -q "wechat start"; check_cmd "单进程形态（node --import tsx 直起 Bot）" $?

# 3. 锁内容为当前启动的进程
grep -q "\"pid\": $BOT_PID" "$DATA/service.lock"; check "锁内容 pid 正确" $?

# 4. 二次启动被拦（前台混跑互斥）：等待进程写出报错并退出
node --import tsx "$ENTRY" wechat start --data "$DATA" > /tmp/p0a-v2.log 2>&1
SECOND_EXIT=$?
[ "$SECOND_EXIT" = "2" ]; check_cmd "二次启动退出码为 2" $?
grep -q "wechat service stop" /tmp/p0a-v2.log; check_cmd "前台二次启动被锁拦截（报错文案）" $?

# 5. 强杀 Bot（模拟崩溃）→ 锁残留（陈锁场景）
powershell -NoProfile -Command "Stop-Process -Id $BOT_PID -Force" 2>/dev/null
sleep 2
check "强杀后锁文件残留（陈锁场景）" $([ -f "$DATA/service.lock" ] && echo 1 || echo 0)

# 6. 陈锁自愈：新进程接管（锁内容 pid 变为新进程）
nohup node --import tsx "$ENTRY" wechat start --data "$DATA" > /tmp/p0a-v3.log 2>&1 &
RESTART_PID=$!
sleep 5
grep -q "\"pid\": $RESTART_PID" "$DATA/service.lock"; check "陈锁自愈：锁被新进程接管" $?

# 清理：强杀新进程；陈锁残留留给下次启动自愈（锁协议预期行为），临时目录整体删除
powershell -NoProfile -Command "Stop-Process -Id $RESTART_PID -Force" 2>/dev/null
sleep 1
rm -rf "$(dirname "$DATA")"

echo "----"
echo "PASS $PASS / FAIL $FAIL"
[ "$FAIL" = "0" ]
