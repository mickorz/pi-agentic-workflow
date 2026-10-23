#!/usr/bin/env python3
"""文章发布原子锁：os.open(O_CREAT|O_EXCL) 排他文件创建，单机第一版实现。

契约（需求文档 V1.2 第 4.2 节）：
- 获取：排他创建锁文件，竞争失败方立即收到 LockHeldError，绝不等待重试
- 锁文件内容（JSON）：pid / runId / 粒度 / 获取时间
- 释放：仅由持有者调用 release() 删除
- 崩溃恢复：acquire 失败时读锁内 pid，进程已死视为残留锁可接管（删除后重新获取）；
  进程仍存活转人工，禁止按超时自动删锁（原任务可能仍在运行）

锁文件命名约定（位于文章目录内，随文章走，天然避免同名目录冲突）：
  .publish.article.lock              文章级锁（本地内容写入阶段）
  .publish.acct.<appid>.lock         账号级锁（远程草稿操作，粒度 = (articleId, account)）
"""
from __future__ import annotations

import errno
import json
import os
import time
from pathlib import Path


class LockHeldError(Exception):
    """锁被其他存活进程持有，携带锁内容供上层报告。"""

    def __init__(self, info: dict):
        self.info = info
        super().__init__(f"lock held by pid={info.get('pid')} runId={info.get('runId')}")


def pid_alive(pid: int) -> bool:
    """跨平台进程存活检测（Windows 下禁用 os.kill(pid,0)，会误杀进程）。"""
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes  # 仅标准库

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


class ArticleLock:
    """排他文件锁。用法：

    with ArticleLock(path, run_id="run-xxx", scope="article") as lk:
        ... 临界区 ...
    竞争失败抛 LockHeldError；检测到死进程残留锁时自动接管并打印 [LOCK] TAKEOVER。
    """

    def __init__(self, path: Path, run_id: str = "", scope: str = "article"):
        self.path = Path(path)
        self.run_id = run_id
        self.scope = scope
        self._fd: int | None = None
        self.taken_over = False

    def acquire(self) -> "ArticleLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        takeover_fails = 0
        while True:
            try:
                self._fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                break
            except OSError as e:
                if e.errno != errno.EEXIST:
                    raise
                info = self._read_info()
                if info and isinstance(info.get("pid"), int) and not pid_alive(info["pid"]):
                    # 残留锁：持有进程已死，接管（这不是超时删除，是存活核验）
                    print(f"[LOCK] TAKEOVER stale lock pid={info['pid']} scope={self.scope}")
                    self.taken_over = True
                    try:
                        self.path.unlink()
                    except OSError:
                        pass
                    takeover_fails += 1
                    if takeover_fails > 5:
                        # unlink 持续失败(如第三方进程短暂占用):明确报错而非死循环
                        raise LockHeldError({**info, "note": "stale lock unlink keeps failing, manual check"})
                    continue  # 竞态下可能再撞一次，循环重试
                raise LockHeldError(info or {"pid": None, "runId": None})
        payload = {
            "pid": os.getpid(),
            "runId": self.run_id,
            "scope": self.scope,
            "acquiredAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        os.write(self._fd, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        return self

    def _read_info(self) -> dict | None:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def release(self) -> None:
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None
            try:
                self.path.unlink()
            except OSError:
                pass

    def __enter__(self) -> "ArticleLock":
        return self.acquire()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()
