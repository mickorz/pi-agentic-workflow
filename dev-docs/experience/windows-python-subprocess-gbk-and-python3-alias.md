# Windows-Python-子进程编码与 python3 占位符陷阱

## 问题现象

1. `python3 xxx.py` 在 Windows 直接报「Python was not found; run without arguments to install from the Microsoft Store」——但 `python xxx.py` 正常（Python 3.14.6 已装）。
2. 迁移后的自检脚本 `run.py`（subprocess 捕获子进程输出）报 `TypeError: unsupported operand type(s) for +: 'NoneType' and 'str'`，子进程明明有输出。
3. `capture_output=True, text=True` 捕获打印中文的子进程时，偶发输出乱码。

## 排查过程

- 现象 1：`where python3` 命中 `WindowsApps\python3.exe`——python.org 安装版在 Windows 只有 `python.exe`；`python3.exe` 是 Microsoft Store 的 App Execution Alias 占位符（未从商店装即失败）。
- 现象 2：最小复现 `subprocess.run([...], capture_output=True, text=True)` 打印 `stdout type: NoneType`，同时 stderr 出现读线程异常
  `UnicodeDecodeError: 'gbk' codec can't decode byte ...`——子进程自己 `sys.stdout.reconfigure(encoding='utf-8')` 输出 UTF-8，父进程 `text=True` 按系统 locale（GBK）解码，读线程抛异常后 buffer 保持 None，`proc.stdout` 变 None。加 `-X utf8` 全局 UTF-8 模式则不复现。
- 现象 3：同根因——解码/控制台编码不一致。

## 根因

- Windows 默认控制台编码是 GBK（cp936），Python 3.14 默认仍未开 UTF-8 模式（3.15 才默认）。
- `python3` 在 Windows 是 Store 占位符；macOS 相反只有 `python3`。

## 解决方案

- subprocess 捕获**显式指定** `encoding="utf-8", errors="replace"`，不裸用 `text=True`：
  ```python
  p = subprocess.run([...], capture_output=True, text=True, encoding="utf-8", errors="replace")
  out = (p.stdout or "") + (p.stderr or "")
  ```
- 脚本入口统一 `if hasattr(sys.stdout, "reconfigure"): sys.stdout.reconfigure(encoding="utf-8")`。
- 跨平台调解释器：`PY=$(command -v python3 || command -v python); "$PY" script.py`（bash 工具内），或直接 `sys.executable`（fixture 内）。
- 另：微信封面要求真实尺寸——1x1 PNG 会被 draft/add 以 `53402 封面裁剪失败` 拒绝；fixture 用标准库 zlib+struct 生成 900x383 纯色 PNG。

## 预防/注意事项

- 仓库其余迁移脚本（manual-test/am-p0/v2-web 的 run*.py 等）仍是裸 `text=True`——在 Windows 上若捕获中文输出会同样炸，用到时按上式补 encoding。
- 微信链路 workflow（article_insert_images_meta / wechat_md_to_draft）已改为探测式解释器调用（2026-10-22 提交）。
