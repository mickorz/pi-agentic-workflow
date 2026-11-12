#!/usr/bin/env python3
"""collect_common.py —— 三渠道采集公共库（T0，content-intelligence 采集适配器底座）

职责：
  1. chrome-use 子进程封装（open/eval/tabs），输出解析容错（升级提示行等噪音）
  2. 浏览器全局互斥锁（市场分析方案 V2 P1：防多任务抢同一 Chrome；open(wx) 原子占位，30min 陈锁接管）
  3. 统一样本出参骨架（对齐 content-intelligence samples schema 的最小字段）
输出契约：脚本 stdout 纯 JSON；exit 0=ok / 1=fail（stderr 带原因）。
"""
import json
import os
import shutil
import subprocess
import sys
import time

CANDIDATES = ("chrome-use", "agent-browser")
TIMEOUT_SECONDS = 45
LOCK_PATH = "/tmp/piwf-chrome-collect.lock"
LOCK_STALE_SEC = 30 * 60


def find_binary():
    for name in CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    return None


def out(payload, code):
    payload.setdefault("ok", code == 0)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return code


def fail(message, **extra):
    payload = {"ok": False, "error": message}
    payload.update(extra)
    return out(payload, 1)


class BrowserLock:
    """全局浏览器采集互斥锁（与生图等浏览器任务约定共用此路径；生图侧接入登记在 T2）。"""

    def __init__(self, path=LOCK_PATH):
        self.path = path
        self.held = False

    def acquire(self, owner="collector"):
        try:
            fh = open(self.path, "x", encoding="utf-8")
        except FileExistsError:
            try:
                st = os.stat(self.path)
                if time.time() - st.st_mtime >= LOCK_STALE_SEC:
                    os.unlink(self.path)
                    fh = open(self.path, "x", encoding="utf-8")
                else:
                    age = int(time.time() - st.st_mtime)
                    raise RuntimeError("浏览器被其他采集任务占用（lock age=%ds，路径 %s）" % (age, self.path))
            except OSError as e:
                raise RuntimeError("锁获取失败：%s" % e)
        fh.write(json.dumps({"owner": owner, "at": time.time()}) + "\n")
        fh.close()
        self.held = True
        return self

    def release(self):
        if self.held:
            try:
                os.unlink(self.path)
            except OSError:
                pass
            self.held = False

    def __enter__(self):
        return self.acquire(owner="collector")

    def __exit__(self, *exc):
        self.release()


class ChromeUse:
    def __init__(self, binary=None):
        self.binary = binary or find_binary()
        if not self.binary:
            raise RuntimeError("未找到 chrome-use（也无旧名 agent-browser）")

    def _run(self, *argv):
        proc = subprocess.run([self.binary, *argv], capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
        return proc.returncode, proc.stdout, proc.stderr

    def open(self, url, wait_sec=5):
        code, so, se = self._run("open", url)
        if code != 0:
            raise RuntimeError("chrome-use open 失败：%s" % (se or so).strip()[:200])
        time.sleep(wait_sec)

    def eval(self, js, wait_sec=0):
        if wait_sec:
            time.sleep(wait_sec)
        code, so, se = self._run("eval", js)
        if code != 0:
            raise RuntimeError("chrome-use eval 失败：%s" % (se or so).strip()[:200])
        # 输出可能带升级提示等噪音行；兼容两种格式：{"success":true,"value":…} 包装与裸 JSON 行
        for line in reversed([l for l in so.splitlines() if l.strip()]):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if isinstance(d, (dict, list)):
                if isinstance(d, dict):
                    if d.get("success") is False:
                        raise RuntimeError("页面 eval 失败：%s" % json.dumps(d, ensure_ascii=False)[:200])
                    if "value" in d:
                        return d["value"]
                return line  # 裸 JSON 行（对象或数组）：原样返回（上层 eval_json 再解析）
        raise RuntimeError("eval 输出无可解析 JSON：%s" % so.strip()[:200])

    def eval_json(self, js, **kw):
        raw = self.eval(js, **kw)
        if isinstance(raw, str):
            try:
                return json.loads(raw)
            except ValueError:
                raise RuntimeError("页面返回非 JSON：%s" % raw[:200])
        return raw


def sample(platform, url, title, author="", metrics=None, method="chrome-use", extra=None):
    """统一样本骨架（最小字段；evidence/tier 由分析阶段补）"""
    s = {
        "platform": platform,
        "url": url,
        "title": title.strip() if title else "",
        "author": (author or "").strip(),
        "collected_at": time.strftime("%Y-%m-%d"),
        "collection_method": method,
        "metrics": metrics or {},
    }
    if extra:
        s.update(extra)
    return s
