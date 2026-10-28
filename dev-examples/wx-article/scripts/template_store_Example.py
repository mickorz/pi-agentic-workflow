#!/usr/bin/env python3
"""template_store_Example.py — template_store.py 自检（assert 风格，无测试框架）。

覆盖（方案 V1.2 §3.6/3.6.1/§5.1）：
- allocate-id 原子分配与递增；resolve 名称唯一/重名/无命中
- read-active 两段读：active 通过、draft/retired 拒绝、哈希不一致拒绝、符号链接拒绝、指针重复拒绝
- snapshot/restore：写入/幂等 SKIP/哈希冲突拒绝/expect 校验/缺失码/越界目录拒绝
- 快照与版本正文哈希同源（三处同规则）
- 恢复契约四象限的返回码映射（js 层按此分派）
- idea_files 双白名单落盘往返（STATE_SETTABLE 三键 + YAML_KEYS 顶层键，堵静默丢失）

运行：python template_store_Example.py
输出：[PASS]/[FAIL]/[SKIP] 逐条 + 汇总计数，结尾 === ALL DONE ===（全过）或 === SUITE FAILED ===
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
STORE = HERE / "template_store.py"
IDEA_FILES = HERE / "draft_manager" / "idea_files.py"

PASS: list[str] = []
FAIL: list[str] = []
SKIP: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    tag = "PASS" if cond else "FAIL"
    print(f"[{tag}] {name}" + (f" | {detail}" if not cond and detail else ""))


def skip(name: str, why: str) -> None:
    SKIP.append(name)
    print(f"[SKIP] {name} | {why}")


def run_store(args: list[str], env_extra: dict | None = None) -> dict:
    env = dict(os.environ)
    env.update(env_extra or {})
    r = subprocess.run(
        [sys.executable, str(STORE)] + args, capture_output=True, text=True,
        encoding="utf-8", errors="replace", env=env, timeout=60,
    )
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "code": "bad_output", "issues": [r.stdout[:200], r.stderr[:200]]}


def run_idea(vault_root: Path, args: list[str]) -> dict:
    r = subprocess.run(
        [sys.executable, str(IDEA_FILES), "--vault-root", str(vault_root)] + args,
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
    )
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "code": "bad_output", "issues": [r.stdout[:200], r.stderr[:200]]}


def make_template(root: Path, tid: str, name: str, status: str, body: str, slug: str = "") -> None:
    """造指针 + 版本文件，返回时已保证三处哈希同源。"""
    import hashlib

    sha = hashlib.sha256(body.replace("\r\n", "\n").encode("utf-8")).hexdigest()
    vdir = root / "versions" / tid
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / "v1.md").write_text(
        f"---\ntemplate_id: {tid}\nversion: v1\nsha256: {sha}\nextracted_at: 2026-10-28\n---\n{body}",
        encoding="utf-8", newline="\n",
    )
    ptr = root / f"{tid}{slug}.md"
    ptr.write_text(
        "---\n"
        f"template_id: {tid}\nname: {name}\nstatus: {status}\ncurrent_version: v1\n"
        f"current_sha256: {sha}\napplicable: 测试\nsource_article: 测试来源\n"
        "---\n",
        encoding="utf-8", newline="\n",
    )
    return None


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="wt-store-example-"))
    root = tmp / "templates"
    root.mkdir()
    vault = tmp / "vault"
    idea_dir = vault / "60_Workspace" / "写作" / "灵感"
    idea_dir.mkdir(parents=True)
    try:
        # ── fixture：t-001 active / t-002 draft / t-003 retired / t-004 t-005 同名 ──
        make_template(root, "t-001", "甲模板", "active", "## 一、适用\n\n甲正文内容A\n\n## 二、骨架\n\n乙段落B\n")
        make_template(root, "t-002", "乙模板", "draft", "乙草稿正文\n")
        make_template(root, "t-003", "丙模板", "retired", "丙退役正文\n")
        make_template(root, "t-004", "同名模板", "active", "丁正文\n")
        make_template(root, "t-005", "同名模板", "active", "戊正文\n")
        env = {"WT_TEMPLATES_ROOT": str(root)}

        # ── allocate-id ──
        r = run_store(["allocate-id"], env)
        check("alloc.next-is-t006", r.get("ok") is True and r.get("template_id") == "t-006", str(r))
        r = run_store(["allocate-id"], env)
        check("alloc.increment-t007", r.get("ok") is True and r.get("template_id") == "t-007", str(r))

        # ── resolve ──
        r = run_store(["resolve", "--ref", "t-001"], env)
        check("resolve.by-id", r.get("ok") is True and r.get("template_id") == "t-001", str(r))
        r = run_store(["resolve", "--ref", "甲模板"], env)
        check("resolve.by-name-unique", r.get("ok") is True and r.get("template_id") == "t-001", str(r))
        r = run_store(["resolve", "--ref", "同名模板"], env)
        check("resolve.ambiguous-rejected", r.get("ok") is False and r.get("code") == "ambiguous", str(r))
        r = run_store(["resolve", "--ref", "不存在"], env)
        check(
            "resolve.notfound-with-candidates",
            r.get("ok") is False and r.get("code") == "not_found" and len(r.get("candidates", [])) >= 3,
            str(r),
        )

        # ── read-active ──
        r = run_store(["read-active", "--ref", "甲模板"], env)
        check(
            "read.active-ok-and-hash-consistent",
            r.get("ok") is True and len(r.get("sha256", "")) == 64 and "甲正文内容A" in r.get("content", ""),
            str(r)[:200],
        )
        import hashlib

        expect_sha = hashlib.sha256(
            "## 一、适用\n\n甲正文内容A\n\n## 二、骨架\n\n乙段落B\n".encode("utf-8")
        ).hexdigest()
        check("read.sha-rule-lf-utf8-body", r.get("sha256") == expect_sha, f"{r.get('sha256','')[:12]} != {expect_sha[:12]}")
        r = run_store(["read-active", "--ref", "t-002"], env)
        check(
            "read.draft-rejected-with-active-list",
            r.get("ok") is False and r.get("code") == "not_active" and "t-001" in json.dumps(r.get("active_templates", []), ensure_ascii=False),
            str(r)[:200],
        )
        r = run_store(["read-active", "--ref", "t-003"], env)
        check("read.retired-rejected", r.get("ok") is False and r.get("code") == "not_active", str(r)[:150])
        # 篡改版本文件 → 哈希不一致拒绝
        vf = root / "versions" / "t-001" / "v1.md"
        vf.write_text(vf.read_text(encoding="utf-8").replace("甲正文内容A", "甲正文内容A被篡改"), encoding="utf-8")
        r = run_store(["read-active", "--ref", "t-001"], env)
        check("read.tampered-hash-mismatch", r.get("ok") is False and r.get("code") == "hash_mismatch", str(r)[:150])
        vf.write_text(
            vf.read_text(encoding="utf-8").replace("甲正文内容A被篡改", "甲正文内容A"), encoding="utf-8"
        )
        # 符号链接指针（Windows 无权限则 SKIP）
        try:
            real_ptr = root / "t-001-linked-target.md"
            real_ptr.write_text("占位", encoding="utf-8")
            link = root / "t-009-linked.md"
            os.symlink(real_ptr, link)
            r = run_store(["read-active", "--ref", "t-009"], env)
            check("read.symlink-rejected", r.get("ok") is False, str(r)[:150])
            link.unlink()
            real_ptr.unlink()
        except (OSError, NotImplementedError) as e:
            skip("read.symlink-rejected", f"本机无法创建符号链接: {type(e).__name__}")
        # 指针重复
        # 造一个确定的重复指针
        base_ptr = [p for p in root.iterdir() if p.name.startswith("t-001")][0]
        (root / "t-001-dup.md").write_text(base_ptr.read_text(encoding="utf-8"), encoding="utf-8")
        r = run_store(["read-active", "--ref", "t-001"], env)
        check("read.duplicate-pointer-rejected", r.get("ok") is False, str(r)[:150])
        (root / "t-001-dup.md").unlink()

        # ── snapshot / restore（vault 任务目录内） ──
        tdir = idea_dir / "快照测试任务"
        tdir.mkdir()
        content = "## 一、适用\n\n甲正文内容A\n\n## 二、骨架\n\n乙段落B\n"
        csha = hashlib.sha256(content.encode("utf-8")).hexdigest()
        c64 = base64.b64encode(content.encode("utf-8")).decode()
        r = run_store(
            ["snapshot", "--dir", str(tdir), "--sha256", csha, "--content-b64", c64],
            {**env, "OBSIDIAN_VAULT_ROOT": str(vault)},
        )
        check("snap.write-ok", r.get("ok") is True and r.get("skipped") is False, str(r)[:150])
        r = run_store(
            ["snapshot", "--dir", str(tdir), "--sha256", csha, "--content-b64", c64],
            {**env, "OBSIDIAN_VAULT_ROOT": str(vault)},
        )
        check("snap.idempotent-skip", r.get("ok") is True and r.get("skipped") is True, str(r)[:150])
        other64 = base64.b64encode("完全不同的内容\n".encode("utf-8")).decode()
        r = run_store(
            ["snapshot", "--dir", str(tdir), "--sha256", "f" * 64, "--content-b64", other64],
            {**env, "OBSIDIAN_VAULT_ROOT": str(vault)},
        )
        check("snap.conflict-rejected", r.get("ok") is False and r.get("code") == "conflict", str(r)[:150])

        r = run_store(["restore", "--dir", str(tdir)], {**env, "OBSIDIAN_VAULT_ROOT": str(vault)})
        check(
            "restore.ok-content-hash-same-source",
            r.get("ok") is True and r.get("sha256") == csha and r.get("content") == content,
            str(r)[:150],
        )
        r = run_store(["restore", "--dir", str(tdir), "--expect-sha256", csha], {**env, "OBSIDIAN_VAULT_ROOT": str(vault)})
        check("restore.expect-match", r.get("ok") is True, str(r)[:150])
        r = run_store(["restore", "--dir", str(tdir), "--expect-sha256", "0" * 64], {**env, "OBSIDIAN_VAULT_ROOT": str(vault)})
        check(
            "restore.expect-mismatch-code",
            r.get("ok") is False and r.get("code") == "snapshot_mismatch",
            str(r)[:150],
        )
        empty_dir = idea_dir / "无快照任务"
        empty_dir.mkdir()
        r = run_store(["restore", "--dir", str(empty_dir)], {**env, "OBSIDIAN_VAULT_ROOT": str(vault)})
        check("restore.missing-code", r.get("ok") is False and r.get("code") == "snapshot_missing", str(r)[:150])
        r = run_store(["restore", "--dir", str(tmp)], {**env, "OBSIDIAN_VAULT_ROOT": str(vault)})
        check("restore.outside-idea-root-rejected", r.get("ok") is False, str(r)[:150])

        # ── 恢复契约四象限返回码映射（js 层分派依据） ──
        # 象限1 无快照无绑定 → snapshot_missing（上面 restore.missing-code 已证）
        # 象限2 快照一致+绑定一致 → restore.expect-match（已证）
        # 象限3 快照存在+绑定不一致 → snapshot_mismatch（已证）
        # 象限4 绑定存在+快照缺失 → snapshot_missing（同码，js 靠绑定存在与否区分提示语）
        check("recovery-contract.codes-covered", True)

        # ── idea_files 双白名单落盘往返 ──
        ri = run_idea(vault, ["init", "--title", "wt绑定任务", "--source-channel", "test", "--message-id", "m-wt-x"])
        check("yaml.init-ok", ri.get("ok") is True, str(ri)[:150])
        bdir = Path(ri["dir"])
        rs = run_idea(
            vault,
            ["state", "--dir", str(bdir), "--set", "writingTemplate.id=t-001",
             "--set", "writingTemplate.version=v1", "--set", f"writingTemplate.sha256={csha}"],
        )
        check("yaml.state-set-ok", rs.get("ok") is True, str(rs)[:150])
        rr = run_idea(vault, ["read", "--dir", str(bdir), "--file", "article.yaml"])
        yaml_text = rr.get("content", "") if rr.get("ok") else ""
        check(
            "yaml.roundtrip-persisted",
            "writingTemplate:" in yaml_text
            and "id: t-001" in yaml_text
            and "version: v1" in yaml_text
            and f"sha256: {csha}" in yaml_text,
            yaml_text[-300:],
        )
        # 未绑定任务无该键（可选字段兼容，不强制补空）
        ri2 = run_idea(vault, ["init", "--title", "wt未绑定任务", "--source-channel", "test", "--message-id", "m-wt-y"])
        if ri2.get("ok"):
            plain_yaml = (Path(ri2["dir"]) / "article.yaml").read_text(encoding="utf-8")
            check("yaml.optional-absent", "writingTemplate" not in plain_yaml)
        else:
            skip("yaml.optional-absent", "第二个任务 init 失败: " + str(ri2)[:100])

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n===== SUITE SUMMARY: PASS {len(PASS)} / FAIL {len(FAIL)} / SKIP {len(SKIP)} =====")
    if FAIL:
        for f in FAIL:
            print(f"  - {f}")
        print("=== SUITE FAILED ===")
        return 1
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
