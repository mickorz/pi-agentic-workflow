#!/usr/bin/env python3
"""run_wt_p1_gate.py — 写作模板库 P1 工作流级确定性门禁（无 LLM：全部走早退分支或 --max-agents 0 前缀）。

覆盖方案 V1.2 §5.1 十项场景中可确定性验证的部分：
  W1 未知模板拒绝 / W2 draft 模板拒绝 / W3 重名拒绝
  W4 普通大纲后传模板拒绝（场景10 防混版）
  W5 已绑定传不同 ID 拒绝（场景8 换模板=新建任务）
  W6 已绑定快照缺失中止 / W7 快照哈希不一致中止（场景4/9 恢复契约）
  W8 首次绑定确定性前缀（快照+state 三键副作用，场景2 前半）
  W9 已绑定续写自动用快照（场景4 前半：restore 通过后才进 agent）
  W0 不传 template 存量行为不变（场景1 确定性近似）

生成质量部分（场景2/6 后半、内容对照）由 Gate C 真机与 template_store_Example.py 承担。

运行：python run_wt_p1_gate.py   （在仓库根执行；自动建临时 vault/模板库，结束清理）
输出：[PASS]/[FAIL] 逐条 + 汇总，=== ALL DONE === / === SUITE FAILED ===
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]  # dev-examples/wx-article/scripts -> 仓库根
WF = REPO / "dev-examples" / "wx-article" / "scripts" / "idea_article_write.js"
IDEA_FILES = REPO / "dev-examples" / "wx-article" / "scripts" / "draft_manager" / "idea_files.py"
TSTORE = REPO / "dev-examples" / "wx-article" / "scripts" / "template_store.py"
NODE = shutil.which("node") or "node"

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" | {detail}" if not cond and detail else ""))


def run_py(script: Path, args: list[str], env: dict) -> dict:
    r = subprocess.run(
        [sys.executable, str(script)] + args, capture_output=True, text=True,
        encoding="utf-8", errors="replace", env=env, cwd=str(REPO), timeout=120,
    )
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "code": "bad_output", "issues": [r.stdout[:200], r.stderr[:200]]}


def run_wf(args_obj: dict, env: dict, extra: list[str] | None = None) -> dict:
    cmd = [NODE, str(REPO / "dist" / "cli" / "index.js"), "run", str(WF),
           "--args", json.dumps(args_obj, ensure_ascii=False), "--json", "--non-interactive"]
    if extra:
        cmd += extra
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", env=env, cwd=str(REPO), timeout=120)
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": (r.stdout + r.stderr)[:400]}


def b64(s: str) -> str:
    return base64.b64encode(s.encode("utf-8")).decode()


def make_template(root: Path, tid: str, name: str, status: str, body: str) -> str:
    sha = hashlib.sha256(body.replace("\r\n", "\n").encode("utf-8")).hexdigest()
    vdir = root / "versions" / tid
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / "v1.md").write_text(
        f"---\ntemplate_id: {tid}\nversion: v1\nsha256: {sha}\nextracted_at: 2026-10-28\n---\n{body}",
        encoding="utf-8", newline="\n",
    )
    (root / f"{tid}-gate.md").write_text(
        "---\n"
        f"template_id: {tid}\nname: {name}\nstatus: {status}\ncurrent_version: v1\n"
        f"current_sha256: {sha}\napplicable: 门禁测试\nsource_article: 门禁\n---\n",
        encoding="utf-8", newline="\n",
    )
    return sha


def mk_task(vault: Path, env: dict, title: str, status: str, brief: str | None,
            outline: str | None = None, article: str | None = None) -> Path:
    r = run_py(IDEA_FILES, ["--vault-root", str(vault), "init", "--title", title,
                            "--source-channel", "gate", "--message-id", "m-" + title], env)
    assert r.get("ok"), f"init 失败: {r}"
    d = Path(r["dir"])
    run_py(IDEA_FILES, ["--vault-root", str(vault), "state", "--dir", str(d),
                        "--set", "status=" + status], env)
    if brief is not None:
        run_py(IDEA_FILES, ["--vault-root", str(vault), "write", "--dir", str(d),
                            "--file", "3-brief.md", "--reason", "gate", "--content-b64", b64(brief)], env)
    if outline is not None:
        run_py(IDEA_FILES, ["--vault-root", str(vault), "write", "--dir", str(d),
                            "--file", "4-outline.md", "--reason", "gate", "--content-b64", b64(outline)], env)
    if article is not None:
        run_py(IDEA_FILES, ["--vault-root", str(vault), "write", "--dir", str(d),
                            "--file", "5-article.md", "--reason", "gate", "--content-b64", b64(article)], env)
    return d


LONG_BRIEF = "## 主题\n\n" + "这是一段足够长的测试 Brief，用于通过 Brief 长度检查。" * 5 + "\n\n## 验收标准\n\n结构清晰。"


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="wt-p1-gate-"))
    vault = tmp / "vault"
    (vault / "60_Workspace" / "写作" / "灵感").mkdir(parents=True)
    troot = tmp / "templates"
    troot.mkdir()
    env = {**os.environ, "OBSIDIAN_VAULT_ROOT": str(vault), "WT_TEMPLATES_ROOT": str(troot)}
    try:
        # 模板库 fixture：t-001 active / t-002 draft / t-004 t-005 同名 active / t-006 active
        body1 = "## 一、适用\n\n正文甲\n\n## 二、骨架\n\n骨架甲\n"
        sha1 = make_template(troot, "t-001", "甲模板", "active", body1)
        make_template(troot, "t-002", "乙模板", "draft", "正文乙\n")
        make_template(troot, "t-004", "同名模板", "active", "正文丁\n")
        make_template(troot, "t-005", "同名模板", "active", "正文戊\n")
        sha6 = make_template(troot, "t-006", "丙模板", "active", "正文丙\n")

        # W1 未知模板
        mk_task(vault, env, "W1任务", "brief_confirmed", LONG_BRIEF)
        out = run_wf({"title": "W1任务", "template": "不存在"}, env)
        res = out.get("result") or {}
        check("W1.unknown-template-rejected",
              res.get("ok") is False and res.get("code") == "template_not_found", str(out)[:200])

        # W2 draft 模板
        mk_task(vault, env, "W2任务", "brief_confirmed", LONG_BRIEF)
        out = run_wf({"title": "W2任务", "template": "乙模板"}, env)
        res = out.get("result") or {}
        check("W2.draft-template-rejected",
              res.get("ok") is False and res.get("code") == "template_not_active", str(out)[:200])

        # W3 重名模板
        mk_task(vault, env, "W3任务", "brief_confirmed", LONG_BRIEF)
        out = run_wf({"title": "W3任务", "template": "同名模板"}, env)
        res = out.get("result") or {}
        check("W3.ambiguous-rejected",
              res.get("ok") is False and res.get("code") == "template_ambiguous", str(out)[:200])

        # W4 普通大纲已生成后传模板（防混版，场景10）
        mk_task(vault, env, "W4任务", "outline_generated", LONG_BRIEF, outline="## 一、章\n\n普通大纲\n")
        out = run_wf({"title": "W4任务", "template": "甲模板", "message": "确认大纲"}, env)
        res = out.get("result") or {}
        check("W4.late-bind-rejected",
              res.get("ok") is False and res.get("code") == "template_late_bind", str(out)[:200])

        # W5 已绑定传不同 ID
        d5 = mk_task(vault, env, "W5任务", "brief_confirmed", LONG_BRIEF)
        run_py(IDEA_FILES, ["--vault-root", str(vault), "state", "--dir", str(d5),
                            "--set", "writingTemplate.id=t-001", "--set", "writingTemplate.version=v1",
                            "--set", "writingTemplate.sha256=" + sha1], env)
        out = run_wf({"title": "W5任务", "template": "t-006"}, env)
        res = out.get("result") or {}
        check("W5.different-template-rejected",
              res.get("ok") is False and res.get("code") == "template_conflict", str(out)[:200])

        # W6 已绑定快照缺失（未传 template 参数的续写路径）
        d6 = mk_task(vault, env, "W6任务", "reviewing", LONG_BRIEF,
                     outline="## 一、章\n\n大纲\n", article="---\ntitle: t\n---\n正文内容足够长\n")
        run_py(IDEA_FILES, ["--vault-root", str(vault), "state", "--dir", str(d6),
                            "--set", "writingTemplate.id=t-001", "--set", "writingTemplate.version=v1",
                            "--set", "writingTemplate.sha256=" + sha1], env)
        out = run_wf({"title": "W6任务"}, env)
        res = out.get("result") or {}
        check("W6.bound-snapshot-missing-aborts",
              res.get("ok") is False and res.get("code") == "snapshot_missing", str(out)[:200])

        # W7 快照哈希与绑定不一致
        d7 = mk_task(vault, env, "W7任务", "reviewing", LONG_BRIEF,
                     outline="## 一、章\n\n大纲\n", article="---\ntitle: t\n---\n正文内容足够长\n")
        run_py(TSTORE, ["--root", str(troot), "snapshot", "--dir", str(d7),
                        "--sha256", sha6, "--content-b64", b64("正文丙\n")], env)
        run_py(IDEA_FILES, ["--vault-root", str(vault), "state", "--dir", str(d7),
                            "--set", "writingTemplate.id=t-001", "--set", "writingTemplate.version=v1",
                            "--set", "writingTemplate.sha256=" + sha1], env)
        out = run_wf({"title": "W7任务"}, env)
        res = out.get("result") or {}
        check("W7.snapshot-mismatch-aborts",
              res.get("ok") is False and res.get("code") == "snapshot_mismatch", str(out)[:200])

        # W8 首次绑定确定性前缀：短 Brief → 绑定（快照+state 三键）先落盘，随后确定性停在 Brief 检查（agent 前）
        d8 = mk_task(vault, env, "W8任务", "brief_confirmed", "短")
        out = run_wf({"title": "W8任务", "template": "甲模板"}, env)
        snap = d8 / "writing-template-snapshot.md"
        yaml8 = (d8 / "article.yaml").read_text(encoding="utf-8")
        err8 = str(out.get("error", ""))
        check("W8.first-bind-side-effects",
              snap.is_file() and "writingTemplate:" in yaml8 and f"sha256: {sha1}" in yaml8
              and "Brief" in err8,
              str(out)[:200])

        # W9 已绑定续写自动用快照：restore 通过后进审稿 agent，用 2s 超时+0 重试让它确定性失败（而非模板早退码）
        d9 = mk_task(vault, env, "W9任务", "reviewing", LONG_BRIEF,
                     outline="## 一、章\n\n大纲\n", article="---\ntitle: t\n---\n正文内容足够长\n")
        run_py(TSTORE, ["--root", str(troot), "snapshot", "--dir", str(d9),
                        "--sha256", sha1, "--content-b64", b64(body1)], env)
        run_py(IDEA_FILES, ["--vault-root", str(vault), "state", "--dir", str(d9),
                            "--set", "writingTemplate.id=t-001", "--set", "writingTemplate.version=v1",
                            "--set", "writingTemplate.sha256=" + sha1], env)
        out = run_wf({"title": "W9任务"}, env, extra=["--timeout", "2000", "--retries", "0"])
        res = out.get("result") or {}
        tpl_codes = {"snapshot_missing", "snapshot_mismatch", "template_not_found", "template_not_active",
                     "template_ambiguous", "template_conflict", "template_late_bind"}
        check("W9.resume-uses-snapshot-no-early-reject",
              res.get("code") not in tpl_codes and out.get("ok") is not True, str(out)[:250])

        # W0 不传 template：存量行为不变（短 Brief → 同样停在 Brief 检查，与改动前一致）
        mk_task(vault, env, "W0任务", "brief_confirmed", "短")
        out = run_wf({"title": "W0任务"}, env)
        err = str(out.get("error", ""))
        check("W0.no-template-unchanged", "Brief 缺失" in err or "Brief" in err, str(out)[:200])

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n===== SUITE SUMMARY: PASS {len(PASS)} / FAIL {len(FAIL)} =====")
    if FAIL:
        for f in FAIL:
            print(f"  - {f}")
        print("=== SUITE FAILED ===")
        return 1
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
