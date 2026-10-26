# bash 门禁脚本忠实移植 Python 的坑清单（v2-web 7 脚本实录）

- 日期：2026-10-22
- 场景：`dev-examples/v2-web/` 下 7 个 bash 门禁/工具脚本（gp1-gate / gp2-gate / fault-suite / sync-e2e-suite / demo-web / perf-baseline / v1-cli-smoke）忠实移植为 Python 3 标准库同名脚本。本文沉淀移植过程中实际踩到的 4 个坑，均已在 .py 中修复并验证。

## 坑 1：辅助函数 `http()` 遮蔽标准库 `http` 模块

- 现象：`demo_web.py` 首跑 `AttributeError: 'function' object has no attribute 'client'`，崩在 `http.client.HTTPConnection`。
- 根因：脚本顶部 `import http.client`，随后又定义 `def http(method, url, ...)` 请求辅助函数——模块级函数名覆盖了模块引用。
- 解决：`import http.client as http_client` 别名导入；或像 gp1_gate.py 那样只在 SSE 函数体内局部 `import http.client`（局部绑定只在函数内遮蔽）。
- 预防：给通用名字（http/json/os）当辅助函数命名前，先查标准库冲突；统一用 `api()`/别名导入最省心。

## 坑 2：URL 路径拆分带尾随空格，jq 断言静默失配

- 现象：`fault_suite.py` 的 jget（等价 `jq -r ... <<< body`）对 `snapshot.journalEntries` 始终查不到 → F1 轮询 24s 超时 → 错过 kill -9 窗口，连环 FAIL。
- 根因：`path.split("//", 1)` 切出的字段带原字符串尾随空格（如 `"journalEntries "`），且脚本首步 `text.strip()` 时机不覆盖所有入口。
- 解决：路径统一 `path.strip().strip(".")` 后再逐段索引。
- 预防：jq → `json.loads` + 字段链移植时，先打印 repr(path) 对拍一帧真实响应，再上轮询。

## 坑 3：`main()` 内赋值 + 期望函数可见 → UnboundLocalError

- 现象：`fault_suite.py` F2 重启 Server 时 `UnboundLocalError: SRV_PID`。
- 根因：SRV_PID 在模块级初始化、`main()` 内赋值；Python 因函数内存在赋值而把它当局部名。
- 解决：`main()` 开头 `global SRV_PID`（其余共享可变状态用 dict/list 也可规避）。

## 坑 4：$0 位置派生路径的 .sh 不能拷走对照运行

- 现象：把 fault-suite.sh 拷到 /tmp 跑对照，PASS=13 FAIL=24 全线崩。
- 根因：`REPO` 由 `$0` 目录推导，/tmp 下 REPO="/" → 重启步骤执行 `node /dist/cli/index.js` MODULE_NOT_FOUND，死服务器 + /tmp 陈旧响应文件的级联假象。
- 解决：对照 .sh 必须放回原路径运行（或先 sed 掉 build 步骤再在原目录跑）。本次在原目录用 `.fault-suite-nobuild-tmp.sh`（`sed 's|npm run build >/dev/null 2>&1|true|'`）建立 .sh 34/34 基线后才定论移植等价。

## 附：移植契约速记

- `curl` 失败/连接拒绝 → `(0, "")`（等价 curl 的 HTTP 000），断言语义才对齐 bash 的 `[ "$code" = 000 ]`。
- `cmd &` 后台进程 → `subprocess.Popen(..., start_new_session=True)` + 结尾 `os.killpg` 收尾；清理顺序保持原 .sh（TERM → sleep 0.5 → KILL → pkill pattern → rm BASE）。
- 每个门禁跑完 `nc -z` 确认端口释放，再跑下一个；`PI_WF_SKIP_BUILD=1` 跳过 build 步骤时 dist 必须已存在。
