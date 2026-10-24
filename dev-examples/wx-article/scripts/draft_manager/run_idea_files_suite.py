#!/usr/bin/env python3
"""idea_files.py 门禁套件（执行方案 §8：T01/T10/T12/T13/T16 + 攻击面 + 契约用例 IF-01…）。

用法：python3 run_idea_files_suite.py
输出契约：逐用例 [PASS]/[FAIL]/[SKIP]，结尾汇总 + `=== ALL DONE === PASS=x FAIL=y SKIP=z`；
退出码 0=全过/SKIP，1=存在 FAIL。fixture 为临时 vault（--vault-root 注入，不碰真实 vault）。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
TOOL = HERE / "idea_files.py"

PASS = 0
FAIL = 0
SKIP = 0


class Skip(Exception):
    pass


def run_tool(args: list[str], stdin: bytes | None = None) -> dict:
    proc = subprocess.run(
        [sys.executable, str(TOOL), "--vault-root", str(VAULT), *args],
        input=stdin if stdin is not None else b"",
        capture_output=True,
        text=False,
    )
    try:
        return json.loads(proc.stdout.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {"ok": False, "code": "bad_output",
                "stdout": proc.stdout[:200].decode("utf-8", "replace"),
                "stderr": proc.stderr[:200].decode("utf-8", "replace")}


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} {detail}")


def check_skip(name: str, reason: str) -> None:
    global SKIP
    SKIP += 1
    print(f"[SKIP] {name} {reason}")


VAULT = Path(tempfile.mkdtemp(prefix="idea-files-suite-")).resolve()
IDEA = VAULT / "60_Workspace" / "写作" / "灵感"
IDEA.mkdir(parents=True, exist_ok=True)


def t01_init_new() -> None:
    r = run_tool(["init", "--title", "程序员学AI做不出产品", "--message-id", "wx-1"], "很多程序员只研究框架，没解决业务问题。".encode())
    d = Path(r.get("dir", ""))
    check("IF-01a init created", r.get("ok") is True and r.get("created") is True, json.dumps(r, ensure_ascii=False)[:200])
    check("IF-01b articleId 格式", str(r.get("articleId", "")).startswith("art_") and len(str(r.get("articleId"))) == 17, str(r.get("articleId")))
    idea_txt = (d / "1-idea.md").read_text(encoding="utf-8") if (d / "1-idea.md").exists() else ""
    check("IF-01c 1-idea.md 原文逐字一致", idea_txt == "很多程序员只研究框架，没解决业务问题。", repr(idea_txt[:60]))
    yaml_txt = (d / "article.yaml").read_text(encoding="utf-8") if (d / "article.yaml").exists() else ""
    check("IF-01d yaml 状态 idea_captured", "status: idea_captured" in yaml_txt and f"articleId: {r.get('articleId')}" in yaml_txt)
    msgs = (d / "messages.jsonl").read_text(encoding="utf-8").splitlines() if (d / "messages.jsonl").exists() else []
    check("IF-01e messages 首条", len(msgs) == 1 and json.loads(msgs[0])["role"] == "user" and json.loads(msgs[0])["messageId"] == "wx-1")


def t12_idempotent() -> None:
    d = IDEA / "程序员学AI做不出产品"
    before = (d / "1-idea.md").read_bytes()
    r = run_tool(["init", "--title", "程序员学AI做不出产品", "--message-id", "wx-1"], "重复投递内容".encode())
    check("IF-02a init 同 messageId 幂等", r.get("ok") is True and r.get("idempotent") is True, json.dumps(r, ensure_ascii=False)[:150])
    check("IF-02b 1-idea.md 未被重写", (d / "1-idea.md").read_bytes() == before)
    msgs = (d / "messages.jsonl").read_text(encoding="utf-8").splitlines()
    check("IF-02c messages 不重复追加", len(msgs) == 1, f"lines={len(msgs)}")


def t10_conflict() -> None:
    r = run_tool(["init", "--title", "程序员学AI做不出产品", "--message-id", "wx-2"], "另一个灵感".encode())
    check("IF-03 同标题不同消息 conflict", r.get("ok") is False and r.get("code") == "conflict", json.dumps(r, ensure_ascii=False)[:150])


def t04_normalize() -> None:
    r = run_tool(["init", "--title", '坏/标题: *测试*?"<>|', "--message-id", "wx-3"], "规范化内容".encode())
    check("IF-04a init 规范化标题", r.get("ok") is True and r.get("created") is True, json.dumps(r, ensure_ascii=False)[:150])
    d = Path(r.get("dir", ""))
    check("IF-04b 目录名无非法字符", d.exists() and d.parent == IDEA and not any(c in d.name for c in '/\\:*?"<>|'), d.name)


def t05_read_whitelist() -> None:
    d = IDEA / "程序员学AI做不出产品"
    r = run_tool(["read", "--dir", str(d), "--file", "1-idea.md"])
    check("IF-05a read 白名单内", r.get("ok") is True and r.get("content", "").startswith("很多程序员"))
    r2 = run_tool(["read", "--dir", str(d), "--file", "../../etc/passwd"])
    check("IF-05b read 白名单外拒绝", r2.get("ok") is False and r2.get("code") == "invalid")
    r3 = run_tool(["read", "--dir", str(d), "--file", "9-unknown.md"])
    check("IF-05c read 未知阶段文件拒绝", r3.get("ok") is False)


def t06_write_backup() -> None:
    d = IDEA / "程序员学AI做不出产品"
    r = run_tool(["write", "--dir", str(d), "--file", "2-topic.md", "--reason", "选题分析"], "# 选题卡 v1".encode())
    check("IF-06a write 新建", r.get("ok") is True and (d / "2-topic.md").read_text(encoding="utf-8") == "# 选题卡 v1")
    check("IF-06b 首写无备份文件", not (d / ".history").exists() or not list((d / ".history").glob("2-topic-v*.md")))
    r2 = run_tool(["write", "--dir", str(d), "--file", "2-topic.md", "--reason", "重生成选题"], "# 选题卡 v2 改".encode())
    hist = list((d / ".history").glob("2-topic-v*.md")) if (d / ".history").exists() else []
    check("IF-07 覆盖自动备份旧版", r2.get("ok") is True and len(hist) == 1 and hist[0].read_text(encoding="utf-8") == "# 选题卡 v1", f"hist={hist}")
    r3 = run_tool(["write", "--dir", str(d), "--file", "1-idea.md", "--reason", "x"], "覆盖灵感".encode())
    check("IF-08 write 1-idea.md 拒绝", r3.get("ok") is False and "原始灵感" in str(r3.get("issues", "")))


def t09_append() -> None:
    d = IDEA / "程序员学AI做不出产品"
    r = run_tool(["append", "--dir", str(d), "--file", "1-idea.md"], "补充：面向小团队。".encode())
    txt = (d / "1-idea.md").read_text(encoding="utf-8")
    check("IF-09a append 补充段格式", r.get("ok") is True and "## 补充（" in txt and txt.startswith("很多程序员") and "补充：面向小团队。" in txt)
    r2 = run_tool(["append", "--dir", str(d), "--file", "messages.jsonl", "--role", "user", "--turn", "2", "--message-id", "wx-9"], "选 B".encode())
    msgs = [json.loads(x) for x in (d / "messages.jsonl").read_text(encoding="utf-8").splitlines()]
    check("IF-09b append messages 结构化", r2.get("ok") is True and msgs[-1]["turn"] == 2 and msgs[-1]["content"] == "选 B" and len(msgs) == 2)
    r3 = run_tool(["append", "--dir", str(d), "--file", "3-brief.md"], "x".encode())
    check("IF-09c append 其他文件拒绝", r3.get("ok") is False)


def t16_atomic() -> None:
    d = IDEA / "程序员学AI做不出产品"
    run_tool(["write", "--dir", str(d), "--file", "5-article.md", "--reason", "初稿"], "正文 v1".encode())
    hist = d / ".history"
    hist.mkdir(exist_ok=True)
    blocker = hist / "blocked.tmp"
    blocker.write_text("占位", encoding="utf-8")
    # 制造备份失败：把 .history 中塞一个与备份目标同名的目录，使备份写入失败
    (hist / "5-article-v99.md").mkdir()
    import re as _re
    yaml_rev = int(_re.search(r"revision: (\d+)", (d / "article.yaml").read_text(encoding="utf-8")).group(1))
    target = hist / f"5-article-v{yaml_rev}.md"
    if not target.exists():
        target.mkdir()  # 备份目标被目录占位 → write_bytes 抛错
    r = run_tool(["write", "--dir", str(d), "--file", "5-article.md", "--reason", "失败写"], "正文 v2".encode())
    ok = r.get("ok") is False
    unchanged = (d / "5-article.md").read_text(encoding="utf-8") == "正文 v1"
    check("IF-10 写失败不报告成功且原文件无损(T16)", ok and unchanged, json.dumps(r, ensure_ascii=False)[:150])
    target.rmdir()
    (hist / "5-article-v99.md").rmdir()
    blocker.unlink()


def t11_stale() -> None:
    d = IDEA / "程序员学AI做不出产品"
    run_tool(["write", "--dir", str(d), "--file", "4-outline.md", "--reason", "大纲"], "大纲 v1".encode())
    run_tool(["write", "--dir", str(d), "--file", "5-article.md", "--reason", "初稿"], "正文 v2".encode())
    r = run_tool(["stale", "--dir", str(d), "--from", "brief"])
    yaml_txt = (d / "article.yaml").read_text(encoding="utf-8")
    check("IF-11a stale brief→下游标记", r.get("ok") is True and set(r.get("staleMarked", [])) >= {"4-outline.md", "5-article.md"}, json.dumps(r, ensure_ascii=False)[:150])
    check("IF-11b yaml stale 含 outline/article/review", "outline:" in yaml_txt.split("stale:")[1].split("revision:")[0] if "stale:" in yaml_txt else False)
    check("IF-11c status 回退 brief_confirmed", "status: brief_confirmed" in yaml_txt)
    r2 = run_tool(["stale", "--dir", str(d), "--from", "不存在的阶段"])
    check("IF-11d 非法 from 拒绝", r2.get("ok") is False)


def t13_locate() -> None:
    run_tool(["init", "--title", "AI 工作流入门", "--message-id", "wx-10"], "AI 工作流灵感".encode())
    run_tool(["init", "--title", "AI 工作流进阶", "--message-id", "wx-11"], "AI 进阶灵感".encode())
    r = run_tool(["locate", "--title", "AI 工作流入门"])
    check("IF-12a locate 精确唯一", r.get("ok") is True and r.get("match") == "exact" and str(r.get("dir", "")).endswith("AI 工作流入门"))
    r2 = run_tool(["locate", "--title", "AI 工作流"])
    check("IF-12b 含糊标题→澄清列表(T13)", r2.get("ok") is False and r2.get("code") == "ambiguous" and len(r2.get("candidates", [])) == 2, json.dumps(r2, ensure_ascii=False)[:200])
    r3 = run_tool(["locate", "--title", "完全不存在"])
    check("IF-12c 零命中 not_found", r3.get("ok") is False and r3.get("code") == "not_found")


def t13b_attack() -> None:
    d = IDEA / "程序员学AI做不出产品"
    r = run_tool(["read", "--dir", "/tmp", "--file", "1-idea.md"])
    check("IF-13a --dir 根外拒绝", r.get("ok") is False)
    r2 = run_tool(["read", "--dir", str(IDEA / "程序员学AI做不出产品" / ".." / ".." / ".." / ".."), "--file", "1-idea.md"])
    check("IF-13b --dir 穿越拒绝", r2.get("ok") is False)
    esc = VAULT / "escape-link"
    if os.name == "nt":
        check_skip("IF-13c symlink 段拒绝", "Windows 创建 symlink 受限")
    else:
        if not esc.exists():
            esc.symlink_to(tempfile.gettempdir(), target_is_directory=True)
        r3 = run_tool(["read", "--dir", str(esc), "--file", "1-idea.md"])
        check("IF-13c --dir symlink 逃逸拒绝", r3.get("ok") is False)
    r4 = run_tool(["init", "--title", "标题';rm -rf /", "--message-id", "wx-12"], "x".encode())
    check("IF-13d title shell 元字符规范化", r4.get("ok") is True and not any(c in Path(r4.get("dir", "")).name for c in "';|$&"), json.dumps(r4, ensure_ascii=False)[:150])
    r5 = run_tool(["init", "--title", "ok标题", "--message-id", "wx-13", ], b"x" * (1024 * 1024 + 1))
    check("IF-13e stdin 超 1MB 拒绝", r5.get("ok") is False and r5.get("code") in ("too_large", "invalid"))


def t14_state() -> None:
    d = IDEA / "程序员学AI做不出产品"
    r = run_tool(["state", "--dir", str(d), "--set", "status=brief_confirmed", "--set", "approval.topic=approved", "--set", "lastRunId=run_abc"])
    yaml_txt = (d / "article.yaml").read_text(encoding="utf-8")
    check("IF-14a state 批量设置", r.get("ok") is True and "status: brief_confirmed" in yaml_txt and "topic: approved" in yaml_txt and "lastRunId: run_abc" in yaml_txt)
    r2 = run_tool(["state", "--dir", str(d), "--set", "status=非法状态"])
    check("IF-14b 非法状态值拒绝", r2.get("ok") is False)
    r3 = run_tool(["state", "--dir", str(d), "--set", "hack.key=1"])
    check("IF-14c 白名单外键拒绝", r3.get("ok") is False)


def t15_lock_takeover() -> None:
    d = IDEA / "程序员学AI做不出产品"
    lock = d / ".idea-files.rmw.lock"
    lock.write_text(json.dumps({"pid": 99999999, "runId": "dead", "scope": "idea-rmw"}), encoding="utf-8")
    r = run_tool(["write", "--dir", str(d), "--file", "6-review.md", "--reason", "审稿"], "# 审稿 v1".encode())
    check("IF-15 死进程锁自动接管", r.get("ok") is True and (d / "6-review.md").exists(), json.dumps(r, ensure_ascii=False)[:150])


def t16_list() -> None:
    r = run_tool(["list"])
    titles = {t["title"] for t in r.get("tasks", [])}
    check("IF-16 list 扫描全部任务", r.get("ok") is True and {"程序员学AI做不出产品", "AI 工作流入门", "AI 工作流进阶"} <= titles, json.dumps(r, ensure_ascii=False)[:200])


def t18_adopt() -> None:
    adopted_dir = IDEA / "主话术已有灵感"
    adopted_dir.mkdir()
    (adopted_dir / "1-idea.md").write_text("主话术保存的原始灵感", encoding="utf-8")
    r = run_tool(["init", "--title", "主话术已有灵感", "--message-id", "wx-20"], "start 话术重复的灵感内容".encode())
    ok = r.get("ok") is True and r.get("adopted") is True and r.get("created") is True
    idea_txt = (adopted_dir / "1-idea.md").read_text(encoding="utf-8")
    yaml_txt = (adopted_dir / "article.yaml").read_text(encoding="utf-8")
    check("IF-18a 领养：注册状态不动原始灵感", ok and idea_txt == "主话术保存的原始灵感" and "status: idea_captured" in yaml_txt, json.dumps(r, ensure_ascii=False)[:150])
    r2 = run_tool(["adopt-check", "--title", "主话术已有灵感"])
    check("IF-18b adopt-check hasState", r2.get("ok") is True and r2.get("exists") is True and r2.get("hasState") is True)
    r3 = run_tool(["adopt-check", "--title", "还不存在的任务"])
    check("IF-18c adopt-check 不存在", r3.get("ok") is True and r3.get("exists") is False)


def main() -> int:
    for fn in (t01_init_new, t12_idempotent, t10_conflict, t04_normalize, t05_read_whitelist,
               t06_write_backup, t09_append, t16_atomic, t11_stale, t13_locate, t13b_attack,
               t14_state, t15_lock_takeover, t16_list, t18_adopt):
        try:
            fn()
        except Skip as s:
            check_skip(fn.__name__, str(s))
        except Exception as e:  # noqa: BLE001
            global FAIL
            FAIL += 1
            print(f"[FAIL] {fn.__name__} 异常: {type(e).__name__}: {e}")
    print(f"=== ALL DONE === PASS={PASS} FAIL={FAIL} SKIP={SKIP}")
    import shutil
    shutil.rmtree(VAULT, ignore_errors=True)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
