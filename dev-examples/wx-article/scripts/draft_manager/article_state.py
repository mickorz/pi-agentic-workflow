#!/usr/bin/env python3
"""publish-state.json 状态管理：按账号隔离 + 读改写串行化 + 原子落盘。

契约（需求文档 V1.2 第 4.3/6.2 节）：
- 单文件、顶层 accounts 字典按账号 appid 隔离，互不覆盖
- 共享状态文件的读—改—写必须串行化：内部持有一把独立的 RMW 排他锁
  （.publish-state.rmw.lock，O_CREAT|O_EXCL），不同账号并发也安全
- 原子落盘：临时文件 + os.replace，进程任意时刻崩溃不会留下半个 JSON
- 业务状态（status/draftMediaId/contentHash）与单次远程操作（pendingOperation）分离
- unknown/pendingOperation 存在时，上层禁止自动重试，只能人工核对后用 resolve 清除

状态结构示例：
{
  "articleId": "第一篇",
  "articlePath": "E:/Obsidian/.../第一篇",
  "accounts": {
    "wx1234567890": {
      "status": "not_drafted|drafted|published",
      "draftMediaId": null,
      "thumbMediaId": null,
      "thumbHash": null,
      "contentHash": null,
      "updatedAt": "...",
      "pendingOperation": null
      // pendingOperation: {type: draft_add|draft_update, targetHash, status: running|unknown, startedAt}
    }
  }
}
"""
from __future__ import annotations

import errno
import json
import os
import time
from pathlib import Path


class StateRMW:
    """publish-state.json 的读—改—写上下文。

    with StateRMW(state_path) as st:
        acc = st.account(appid)
        acc["status"] = "drafted"
        ...                      # 退出时自动串行化写回（原子替换）
    """

    def __init__(self, state_path: Path):
        self.path = Path(state_path)
        self.lock_path = self.path.parent / (self.path.name + ".rmw.lock")
        self.data: dict = {}
        self._fd: int | None = None

    # -- 上下文管理 ----------------------------------------------------------

    def __enter__(self) -> "StateRMW":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # RMW 串行锁:短忙等 + 死进程接管;有重试上限(约 10s),超限明确报错而非死循环
        waits = 0
        while True:
            try:
                self._fd = os.open(str(self.lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                break
            except OSError as e:
                if e.errno != errno.EEXIST:
                    raise
                info = self._read_lock_info()
                if info and isinstance(info.get("pid"), int) and not _pid_alive(info["pid"]):
                    try:
                        self.lock_path.unlink()
                    except OSError:
                        pass
                    continue
                waits += 1
                if waits > 200:
                    raise SystemExit(f"[FAIL] state RMW lock busy >10s: {self.lock_path} (holder={info})")
                time.sleep(0.05)
        self.data = self._load()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if exc_type is None:
                self._save()
        finally:
            if self._fd is not None:
                os.close(self._fd)
                self._fd = None
                try:
                    self.lock_path.unlink()
                except OSError:
                    pass

    # -- 数据访问 ------------------------------------------------------------

    def account(self, appid: str) -> dict:
        """取指定账号的记录，不存在则初始化（不影响其他账号字段）。"""
        accounts = self.data.setdefault("accounts", {})
        acc = accounts.get(appid)
        if acc is None:
            acc = {
                "status": "not_drafted",
                "draftMediaId": None,
                "thumbMediaId": None,
                "thumbHash": None,
                "contentHash": None,
                "updatedAt": _now(),
                "pendingOperation": None,
            }
            accounts[appid] = acc
        return acc

    # -- 内部 ----------------------------------------------------------------

    def _load(self) -> dict:
        if not self.path.is_file():
            return {"articleId": self.path.parent.name, "articlePath": str(self.path.parent), "accounts": {}}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # 状态文件损坏：这是本机可信文件，损坏只可能来自外部改动；明确报错不静默重建
            raise SystemExit(f"[FAIL] state file corrupted, manual check needed: {self.path}")
        data.setdefault("accounts", {})
        return data

    def _save(self) -> None:
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(str(tmp), str(self.path))  # 原子替换

    def _read_lock_info(self) -> dict | None:
        try:
            return json.loads(self.lock_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None


def _pid_alive(pid: int) -> bool:
    # 复用 article_lock 的实现，避免循环导入：此处内联同样逻辑
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        SYNCHRONIZE = 0x00100000
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")
