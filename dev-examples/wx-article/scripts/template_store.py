#!/usr/bin/env python3
"""template_store.py — 写作模板库确定性读写器（纯 stdlib）。

契约：dev-docs/planning/2026-10-28-优质文章写作模板库执行方案.md（V1.2 §3.1/3.2/3.5/3.6）
- 模板库根目录解析链：--root > WT_TEMPLATES_ROOT env > 配置 writing_templates_root
  （配置经 vault_query.find_config 找 obsidian.config.json / .aws-article/config.json）
- 指针文件 t-NNN-<slug>.md 只存元数据（status/current_version/current_sha256），可变；
  版本文件 versions/t-NNN/vN.md 存七节正文，不可变。status 转换只改指针。
- 哈希规则：sha256 只算七节正文 UTF-8 字节、换行统一 LF、不含 frontmatter；
  指针 current_sha256 / 版本文件 sha256 / 任务快照哈希三处同源同规则。
- 快照：写入任务目录（须位于 vault 灵感根内，与 idea_files.py 同一 IDEA_RELPATH 约束），
  文件内容 = 模板正文（无 frontmatter），存在且哈希一致返回 SKIP，不一致拒绝（不可变）。
- stdout 单 JSON；退出码恒 0；ok 字段承载语义。LLM 不接触本工具的任何输入文件。

子命令：
  allocate-id  [--slug <英文slug>]                分配下一 template_id（versions/t-NNN 原子 mkdir）
  resolve      --ref <ID或名称>                    确定性解析：精确ID > name唯一；重名/无命中拒绝并给候选
  read-active  --ref <ID或名称>                    指针->版本两段读；status=active + 哈希一致才放行
  snapshot     --dir <任务目录> --sha256 <哈希> --content-b64 <正文b64>
  restore      --dir <任务目录> [--expect-sha256 <哈希>]
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR / "draft_manager"))

from vault_query import find_config  # noqa: E402
from idea_files import IDEA_RELPATH  # noqa: E402

MAX_CONTENT_BYTES = 1024 * 1024
SNAPSHOT_NAME = "writing-template-snapshot.md"
ID_RE = re.compile(r"^t-(\d{3})$")
POINTER_RE = re.compile(r"^t-(\d{3})(?:-.*)?$")  # 指针文件名可带 slug 后缀
VERSION_RE = re.compile(r"^v(\d+)$")


def pointer_id(stem: str) -> str | None:
    """指针文件 stem -> template_id（t-001-xxx -> t-001；纯 t-001 亦可）。"""
    m = POINTER_RE.match(stem)
    return f"t-{m.group(1)}" if m else None


def out(payload: dict) -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False))


def fail(code: str, issues: list, **extra) -> dict:
    payload = {"ok": False, "code": code, "issues": issues}
    payload.update(extra)
    return payload


# ---------------------------------------------------------------- root 解析


def resolve_root(arg_root: str | None) -> tuple[Path | None, list[str]]:
    if arg_root:
        root = Path(arg_root).expanduser()
        if not root.is_dir():
            return None, [f"--root 不是目录: {arg_root}"]
        return root.resolve(), []
    env = os.environ.get("WT_TEMPLATES_ROOT", "").strip()
    if env:
        root = Path(env).expanduser()
        if not root.is_dir():
            return None, [f"WT_TEMPLATES_ROOT 不是目录: {env}"]
        return root.resolve(), []
    found = find_config(SCRIPT_DIR)
    if found:
        _cfg_root, data = found
        vr = str(data.get("writing_templates_root", "")).strip()
        if vr:
            root = Path(vr).expanduser()
            if not root.is_dir():
                return None, [f"配置 writing_templates_root 不是目录: {vr}"]
            return root.resolve(), []
    return None, [
        "模板库根未配置：请用 --root / WT_TEMPLATES_ROOT / 配置文件 writing_templates_root"
    ]


def resolve_vault_root_for_tasks(arg_vault: str | None) -> tuple[Path | None, list[str]]:
    """任务目录校验需要 vault 根（与 idea_files 同链：--vault-root > env > 配置）。"""
    from vault_query import resolve_vault_root

    vault, _cfg, _data, issues = resolve_vault_root(arg_vault)
    if issues:
        return None, issues
    return vault, []


def task_dir_checked(raw_dir: str | None, vault_root: Path) -> tuple[Path | None, list[str]]:
    """任务目录必须位于 vault 灵感根之内（与 idea_files.resolve_dir 同语义）。"""
    if not raw_dir:
        return None, ["缺少 --dir"]
    p = Path(raw_dir)
    if not p.is_absolute():
        return None, ["--dir 必须是绝对路径"]
    idea_root_real = (vault_root / IDEA_RELPATH).resolve()
    try:
        real = p.resolve()
        real.relative_to(idea_root_real)
    except ValueError:
        return None, [f"任务目录越界(必须在 {idea_root_real} 内): {p}"]
    if not real.is_dir():
        return None, [f"任务目录不存在: {p}"]
    return real, []


# ---------------------------------------------------------------- 指针/正文


def parse_frontmatter(text: str) -> dict:
    m = re.match(r"^---\n([\s\S]*?)\n---\n", text)
    if not m:
        return {}
    fm: dict = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            fm[k.strip()] = v.strip()
    return fm


def body_of(text: str) -> str:
    m = re.match(r"^---\n[\s\S]*?\n---\n", text)
    return text[m.end():] if m else text


def sha256_body(content: str) -> str:
    """哈希规则：LF 规范化后的 UTF-8 字节（调用方保证传正文、不含 frontmatter）。"""
    data = content.replace("\r\n", "\n").encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def no_symlink(path: Path) -> bool:
    p = Path(path)
    while p.name not in ("", "/", "\\", "."):
        if p.is_symlink():
            return False
        p = p.parent
    return True


def scan_ids(root: Path) -> list[int]:
    nums: set[int] = set()
    if not root.is_dir():
        return []
    for entry in root.iterdir():
        if entry.is_file() and entry.suffix == ".md":
            pid = pointer_id(entry.stem)
            if pid:
                nums.add(int(pid[2:]))
    versions = root / "versions"
    if versions.is_dir():
        for entry in versions.iterdir():
            m = ID_RE.match(entry.name)
            if m:
                nums.add(int(m.group(1)))
    return sorted(nums)


def pointer_files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    outp: list[Path] = []
    for entry in sorted(root.iterdir()):
        if entry.is_file() and entry.suffix == ".md" and pointer_id(entry.stem):
            outp.append(entry)
    return outp


def read_pointer(root: Path, template_id: str) -> tuple[dict | None, list[str]]:
    if not ID_RE.match(template_id):
        return None, [f"template_id 非法: {template_id}"]
    matches = [p for p in pointer_files(root) if pointer_id(p.stem) == template_id]
    if not matches:
        return None, [f"模板不存在: {template_id}"]
    if len(matches) > 1:
        return None, [f"模板指针重复: {template_id}（{[p.name for p in matches]}）"]
    path = matches[0]
    if not no_symlink(path):
        return None, [f"拒绝符号链接: {path}"]
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        return None, [f"指针读取失败: {e}"]
    fm = parse_frontmatter(text)
    if not fm.get("template_id") or not fm.get("status"):
        return None, [f"指针 frontmatter 不完整(缺 template_id/status): {path.name}"]
    return fm, []


# ---------------------------------------------------------------- 子命令


def do_allocate_id(args, root: Path) -> dict:
    existing = scan_ids(root)
    nxt = (existing[-1] + 1) if existing else 1
    versions = root / "versions"
    for _ in range(5):  # 并发下 mkdir 独占失败则重扫，天然防重复编号
        tid = f"t-{nxt:03d}"
        target = versions / tid
        try:
            target.mkdir(parents=True, exist_ok=False)
            return {"ok": True, "template_id": tid, "versions_dir": str(target)}
        except FileExistsError:
            existing = scan_ids(root)
            nxt = (existing[-1] + 1) if existing else 1
    return fail("conflict", ["allocate-id 连续冲突，请重试"])


def do_resolve(args, root: Path) -> dict:
    ref = (args.ref or "").strip()
    if not ref:
        return fail("invalid", ["缺少 --ref"])
    candidates = []
    for p in pointer_files(root):
        fm, issues = read_pointer(root, pointer_id(p.stem))
        if issues:
            continue
        candidates.append({"template_id": fm["template_id"], "name": fm.get("name", "")})
    # 确定性归一化：路由提取常带「模板」后缀（如「变局应对认知长文模板」），剥离后重试；仅一次变换，不做模糊匹配
    normalized = re.sub(r"[\s。｡]*模板$", "", ref).strip()
    refs = [ref] if normalized == ref else [ref, normalized]
    for r in refs:
        by_id = [c for c in candidates if c["template_id"] == r]
        if by_id:
            return {"ok": True, "template_id": r, "matched_by": "id"}
        by_name = [c for c in candidates if c["name"] == r]
        if len(by_name) == 1:
            return {"ok": True, "template_id": by_name[0]["template_id"], "matched_by": "name"}
        if len(by_name) > 1:
            return fail("ambiguous", [f"模板名称重复: {r}"], candidates=by_name)
    return fail(
        "not_found",
        [f"未找到模板: {ref}（可用: {'、'.join(c['template_id'] + '(' + c['name'] + ')' for c in candidates) or '无'}）"],
        candidates=candidates,
    )


def do_read_active(args, root: Path) -> dict:
    ref = (args.ref or "").strip()
    if not ref:
        return fail("invalid", ["缺少 --ref"])
    r = do_resolve(args, root)
    if not r.get("ok"):
        return r
    template_id = r["template_id"]
    fm, issues = read_pointer(root, template_id)
    if issues:
        return fail("invalid", issues)
    status = fm.get("status", "")
    if status != "active":
        active = []
        for p in pointer_files(root):
            f2, err2 = read_pointer(root, p.stem)
            if not err2 and f2.get("status") == "active":
                active.append(f2["template_id"] + "(" + f2.get("name", "") + ")")
        return fail(
            "not_active",
            [f"模板 {template_id} 状态为 {status}（仅 active 可用于写作）；可用: {'、'.join(active) or '无'}"],
            status=status,
            active_templates=active,
        )
    version = fm.get("current_version", "")
    sha_expect = fm.get("current_sha256", "")
    if not VERSION_RE.match(version) or len(sha_expect) != 64:
        return fail("invalid", [f"指针 current_version/current_sha256 非法: {template_id}"])
    vpath = root / "versions" / template_id / (version + ".md")
    if not no_symlink(vpath) or not vpath.is_file():
        return fail("not_found", [f"版本文件不存在: {vpath}"])
    try:
        text = vpath.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        return fail("io_error", [f"版本文件读取失败: {e}"])
    if len(text.encode("utf-8")) > MAX_CONTENT_BYTES:
        return fail("too_large", [f"版本文件超限: {vpath}"])
    body = body_of(text)
    sha_actual = sha256_body(body)
    if sha_actual != sha_expect:
        return fail(
            "hash_mismatch",
            [f"版本文件哈希与指针不一致: {template_id}/{version} expect={sha_expect[:12]} actual={sha_actual[:12]}"],
        )
    return {
        "ok": True,
        "template_id": template_id,
        "name": fm.get("name", ""),
        "version": version,
        "sha256": sha_actual,
        "content": body,
    }


def do_snapshot(args, root: Path) -> dict:
    vault, v_issues = resolve_vault_root_for_tasks(args.vault_root)
    if v_issues:
        return fail("invalid", v_issues)
    workdir, d_issues = task_dir_checked(args.dir, vault)
    if d_issues:
        return fail("invalid", d_issues)
    if not args.sha256 or len(args.sha256) != 64:
        return fail("invalid", ["--sha256 需要 64 位十六进制"])
    if not args.content_b64:
        return fail("invalid", ["缺少 --content-b64"])
    try:
        data = base64.b64decode(args.content_b64, validate=True)
    except (ValueError, TypeError) as e:
        return fail("invalid", [f"--content-b64 解码失败: {e}"])
    if len(data) > MAX_CONTENT_BYTES:
        return fail("too_large", [f"内容超限: {len(data)} 字节"])
    content = data.decode("utf-8", errors="strict")
    target = workdir / SNAPSHOT_NAME
    if target.exists():
        existing = target.read_text(encoding="utf-8")
        if sha256_body(existing) == args.sha256:
            return {"ok": True, "skipped": True, "path": str(target)}
        return fail(
            "conflict",
            [f"快照已存在且哈希不一致，拒绝覆盖（不可变）: {target}；换模板请新建任务"],
        )
    fd, tmp = tempfile.mkstemp(dir=str(workdir), prefix="." + SNAPSHOT_NAME + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, target)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return {"ok": True, "skipped": False, "path": str(target)}


def do_restore(args, root: Path) -> dict:
    vault, v_issues = resolve_vault_root_for_tasks(args.vault_root)
    if v_issues:
        return fail("invalid", v_issues)
    workdir, d_issues = task_dir_checked(args.dir, vault)
    if d_issues:
        return fail("invalid", d_issues)
    target = workdir / SNAPSHOT_NAME
    if not target.is_file():
        return fail("snapshot_missing", [f"快照不存在: {target}"], exists=False)
    if not no_symlink(target):
        return fail("invalid", [f"拒绝符号链接: {target}"])
    content = target.read_text(encoding="utf-8")
    if len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
        return fail("too_large", [f"快照超限: {target}"])
    sha = sha256_body(content)
    expect = (args.expect_sha256 or "").strip()
    if expect and expect != sha:
        return fail("snapshot_mismatch", [f"快照哈希与绑定不一致: expect={expect[:12]} actual={sha[:12]}"], exists=True, actual_sha256=sha)
    return {"ok": True, "sha256": sha, "content": content}


# ---------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description="写作模板库确定性读写器")
    parser.add_argument("--root", default=None, help="模板库根（调试/测试用；缺省走 WT_TEMPLATES_ROOT > 配置链）")
    parser.add_argument("--vault-root", default=None, help="vault 根（snapshot/restore 校验任务目录用）")
    sub = parser.add_subparsers(dest="action")

    p_alloc = sub.add_parser("allocate-id")
    p_alloc.add_argument("--slug", default=None)

    p_resolve = sub.add_parser("resolve")
    p_resolve.add_argument("--ref", required=True)

    p_read = sub.add_parser("read-active")
    p_read.add_argument("--ref", required=True)

    p_snap = sub.add_parser("snapshot")
    p_snap.add_argument("--dir", required=True)
    p_snap.add_argument("--sha256", required=True)
    p_snap.add_argument("--content-b64", dest="content_b64", required=True)

    p_restore = sub.add_parser("restore")
    p_restore.add_argument("--dir", required=True)
    p_restore.add_argument("--expect-sha256", dest="expect_sha256", default=None)

    args = parser.parse_args()
    if not args.action:
        out(fail("invalid", ["缺少子命令（allocate-id/resolve/read-active/snapshot/restore）"]))
        return 0

    needs_root = args.action in ("allocate-id", "resolve", "read-active")
    root: Path | None = None
    if needs_root:
        root, root_issues = resolve_root(args.root)
        if root_issues:
            out(fail("invalid", root_issues))
            return 0

    handlers = {
        "allocate-id": lambda: do_allocate_id(args, root),
        "resolve": lambda: do_resolve(args, root),
        "read-active": lambda: do_read_active(args, root),
        "snapshot": lambda: do_snapshot(args, root),
        "restore": lambda: do_restore(args, root),
    }
    try:
        result = handlers[args.action]()
    except (OSError, ValueError) as e:
        result = fail("io_error", [f"{type(e).__name__}: {e}"])
    out(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
