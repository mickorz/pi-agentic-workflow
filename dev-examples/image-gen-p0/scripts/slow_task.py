#!/usr/bin/env python3
"""P0 T0.6 长任务模拟：写心跳标记 → 睡 secs 秒 → 打印 JSON 结果。

用于验证 agent 单命令桥接对长生命周期子进程的承载能力：
- 生命周期：子进程能否活过 agent 会话的 bash 工具超时
- 结果回传：stdout JSON 能否原样返回给 workflow
- 取消传播：宿主 SIGINT 后子进程是否随进程组终止（由外部观察者核验）
"""
import argparse
import json
import os
import time
from pathlib import Path
from typing import Optional


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=int, default=40)
    ap.add_argument("--marker", required=True)
    args = ap.parse_args()

    marker = Path(args.marker)
    marker.parent.mkdir(parents=True, exist_ok=True)

    def write(state: str, extra: Optional[dict] = None) -> None:
        payload = {"state": state, "pid": os.getpid(), "ts": time.time()}
        if extra:
            payload.update(extra)
        tmp = marker.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(marker)

    write("started")
    t0 = time.time()
    for i in range(args.secs):
        time.sleep(1)
        write("running", {"tick": i + 1, "elapsed": round(time.time() - t0, 1)})
    write("done", {"elapsed": round(time.time() - t0, 1)})
    # stdout 契约：单行 JSON（agent 桥 raw 回传后由 workflow 二次解析）
    print(json.dumps({"ok": True, "pid": os.getpid(), "secs": args.secs}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
