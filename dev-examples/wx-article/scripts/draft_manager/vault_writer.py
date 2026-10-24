#!/usr/bin/env python3
"""Obsidian vault 写后端（P1a Phase W，方案 §2/§2.2/§2.3）

用法（内容一律走 stdin，UTF-8，上限 1MB）:
  echo "正文" | vault_writer.py --action create --rel "灵感/新笔记.md" --operation-id <id>
  echo "追加" | vault_writer.py --action append --rel "灵感/新笔记.md" --operation-id <id>

契约:
- createNote: os.open(O_CREAT|O_EXCL|O_WRONLY)——已存在即冲突拒绝；禁临时文件重命名（§2.2）
- appendNote: os.open(O_APPEND|O_WRONLY)——不存在即拒绝；不创建
- 幂等台账（§2）: <配置根>/.obsidian-ops/ledger.jsonl（O_APPEND 单行事件）
  started{operationId,action,rel,contentDigest} → 写前
  done{operationId,...,bytes}    → 写成功 fsync 后
  failed{operationId,reason}     → 写失败（干净关闭 started，允许重试）
  重试同 operationId:
    末态 done   → 幂等成功，不重复写（status=idempotent）
    末态 started（无后续事件）→ unknown：报错，禁自动重试，人工核对
    末态 failed → 允许重试（正常重新走 started→done）
    done 的 rel/contentDigest 与本次不一致 → 拒绝（invalid）
- stdout 单 JSON、退出码恒 0，语义由 ok 字段承载；stdout 绝不回显 content（§2.3）
- vault_root 配置链同 vault_query.py（§5）：--vault-root > OBSIDIAN_VAULT_ROOT >
  obsidian.config.json > .aws-article/config.json；台账根 = --ledger-root > 配置根 > cwd
- 单机单写者假设（§2）；Windows 兼容：O_EXCL/O_APPEND 均为 os 模块跨平台旗标
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

MAX_CONTENT_BYTES = 1024 * 1024  # §2.2：stdin 内容上限 1MB
LEDGER_DIRNAME = ".obsidian-ops"
LEDGER_FILENAME = "ledger.jsonl"
OP_ID_RE_OK = True  # operationId 语法校验开关（保留字面量 True，见 validate_operation_id）
REL_ALLOWED_SUFFIX = ".md"  # 写面只接受笔记（与 vault_query 读面一致）

sys.stdout.reconfigure(encoding="utf-8")


def out(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def fail(code: str, issues: list[str], **extra) -> dict:
    payload: dict = {"ok": False, "code": code, "issues": issues}
    payload.update(extra)
    return payload


# ── 配置发现（与 vault_query.py 同链：§5）──

def _read_config(cfg_path: Path) -> dict | None:
    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def find_config(start: Path) -> tuple[Path, dict] | None:
    for cur in [start] + list(start.parents):
        p = cur / "obsidian.config.json"
        if p.is_file():
            data = _read_config(p)
            if data:
                return cur, data
    for cur in [start] + list(start.parents):
        p = cur / ".aws-article" / "config.json"
        if p.is_file():
            data = _read_config(p)
            if data:
                return cur, data
    return None


def resolve_vault_root(args_vault_root: str | None) -> tuple[Path, Path | None, dict, list[str]]:
    """返回 (vault_root 绝对路径, 配置根, 配置内容, issues)。issues 非空 = 失败。"""
    if args_vault_root:
        root = Path(args_vault_root).expanduser()
        if not root.is_dir():
            return Path(), None, {}, [f"--vault-root 不是目录：{args_vault_root}"]
        return root.resolve(), None, {}, []
    env = os.environ.get("OBSIDIAN_VAULT_ROOT", "").strip()
    if env:
        root = Path(env).expanduser()
        if not root.is_dir():
            return Path(), None, {}, [f"OBSIDIAN_VAULT_ROOT 不是目录：{env}"]
        return root.resolve(), None, {}, []
    for base in (Path.cwd(), Path(__file__).resolve().parent):
        found = find_config(base)
        if found:
            cfg_root, data = found
            vr = str(data.get("vault_root", "")).strip()
            if not vr:
                continue
            root = Path(vr).expanduser()
            if not root.is_dir():
                return Path(), None, {}, [f"配置 vault_root 不是目录：{vr}"]
            return root.resolve(), cfg_root, data, []
    return (
        Path(),
        None,
        {},
        ["vault_root 未配置：请用 --vault-root / OBSIDIAN_VAULT_ROOT / obsidian.config.json（或兼容 .aws-article/config.json）"],
    )


def resolve_ledger_root(args_ledger_root: str | None, cfg_root: Path | None) -> Path:
    """台账根（§2）：--ledger-root（测试旗标）> PI_OBSIDIAN_LEDGER_ROOT env > 配置根 > cwd。"""
    if args_ledger_root:
        return Path(args_ledger_root).expanduser().resolve()
    env_root = os.environ.get("PI_OBSIDIAN_LEDGER_ROOT")
    if env_root:
        return Path(env_root).expanduser().resolve()
    return (cfg_root or Path.cwd()).resolve()


# ── 校验 ──

def validate_operation_id(op_id: str | None) -> list[str]:
    if not isinstance(op_id, str) or not op_id.strip():
        return ["operationId 必填（幂等台账键）"]
    s = op_id.strip()
    if len(s) > 128 or any(c.isspace() or ord(c) < 0x20 for c in s):
        return ["operationId 非法（≤128 字符且不含空白/控制字符）"]
    return []


def validate_rel(rel: str | None) -> list[str]:
    if not isinstance(rel, str) or not rel.strip():
        return ["rel 必填（vault 相对路径）"]
    r = rel.strip().replace("\\", "/")
    if r.startswith("/"):
        return ["rel 必须是 vault 相对路径（不允许以 / 开头）"]
    parts = [p for p in r.split("/") if p != ""]
    if not parts:
        return ["rel 不能为空路径"]
    if any(p in (".", "..") for p in parts):
        return ["rel 不允许包含 . / .. 段"]
    # P1a：拒绝隐藏段/空 stem（如 ".md"、".x.md"——vault 剪枝约定本就忽略隐藏项）
    if any(p.startswith(".") for p in parts):
        return ["rel 不允许包含以点开头的隐藏段"]
    if any(ord(c) < 0x20 for c in r):
        return ["rel 不允许包含控制字符"]
    # P1a §2.2：写面拒绝 shell 元字符/引号（spawn 虽不走 shell，但 vault 文件名保持干净可移植）
    bad_chars = '"\'`$;|&<>'
    if any(c in bad_chars for c in r):
        return [f"rel 不允许包含特殊字符（{' '.join(bad_chars)}）：写入面仅接受常规笔记名"]
    if not r.lower().endswith(REL_ALLOWED_SUFFIX):
        return [f"rel 必须以 {REL_ALLOWED_SUFFIX} 结尾（写面仅接受笔记文件）"]
    return []


def safe_target(vault_root: Path, rel: str) -> tuple[Path | None, list[str]]:
    """逐段拒绝符号链接 + resolve 必须仍在 vault 根内（§2.2）。"""
    rel_norm = rel.strip().replace("\\", "/")
    cur = vault_root
    try:
        root_resolved = vault_root.resolve()
        for part in rel_norm.split("/"):
            cur = cur / part
            if cur.is_symlink():
                return None, [f"rel 路径段是符号链接，拒绝：{cur}"]
        resolved = cur.resolve()
        if resolved != root_resolved and root_resolved not in resolved.parents:
            return None, [f"路径越界（resolve 后不在 vault 根内）：{rel_norm}"]
    except Exception:
        return None, [f"路径无法解析：{rel_norm}"]
    return resolved, []


# ── 台账（§2 状态机；单机单写者 + O_APPEND 单行）──

def ledger_path(ledger_root: Path) -> Path:
    return ledger_root / LEDGER_DIRNAME / LEDGER_FILENAME


def append_event(ledger_root: Path, event: dict) -> None:
    p = ledger_path(ledger_root)
    p.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({**event, "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"}, ensure_ascii=False)
    fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        os.write(fd, (line + "\n").encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def read_events(ledger_root: Path) -> list[dict]:
    p = ledger_path(ledger_root)
    if not p.is_file():
        return []
    events: list[dict] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
            if isinstance(ev, dict):
                events.append(ev)
        except Exception:
            continue  # 坏行跳过（人工核对场景由 --dump 处理，不阻塞写入）
    return events


def last_state_for(events: list[dict], op_id: str) -> dict | None:
    """operationId 的末态事件（started/done/failed 中最后一个）。"""
    state: dict | None = None
    for ev in events:
        if ev.get("operationId") == op_id and ev.get("event") in ("started", "done", "failed"):
            state = ev
    return state


# ── 写动作 ──

def read_content() -> tuple[bytes | None, list[str]]:
    raw = sys.stdin.buffer.read()
    if len(raw) > MAX_CONTENT_BYTES:
        return None, [f"内容超限：{len(raw)} 字节 > 1MB 上限（§2.2）"]
    try:
        raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return None, ["内容不是合法 UTF-8"]
    return raw, []


def do_write(vault_root: Path, ledger_root: Path, action: str, rel: str, op_id: str) -> dict:
    content, issues = read_content()
    if issues:
        return fail("too_large", issues)
    assert content is not None
    content_digest = hashlib.sha256(content).hexdigest()

    target, t_issues = safe_target(vault_root, rel)
    if t_issues:
        return fail("invalid", t_issues)
    assert target is not None

    # 幂等预检（§2）：同 operationId 末态
    prior = last_state_for(read_events(ledger_root), op_id)
    if prior:
        if prior.get("event") == "done":
            if prior.get("rel") != rel or prior.get("contentDigest") != content_digest:
                return fail(
                    "invalid",
                    [f"operationId 已 done 且 rel/contentDigest 与本次不一致，拒绝复用：{op_id}"],
                )
            return {
                "ok": True,
                "action": action,
                "status": "idempotent",
                "rel": rel,
                "operationId": op_id,
                "bytes": int(prior.get("bytes", 0)),
                "contentDigest": content_digest,
            }
        if prior.get("event") == "started":
            return fail(
                "unknown",
                [
                    f"operationId 末态为 started（无 done/failed）：写入结果不确定，禁自动重试，请人工核对台账与文件：{op_id}",
                    f"台账：{ledger_path(ledger_root)}",
                ],
            )
        # failed → 允许重试

    # 动作前置条件（§2.2）
    exists = target.exists()
    if action == "create" and exists:
        return fail("conflict", [f"目标已存在（O_EXCL 语义拒绝创建）：{rel}"])
    if action == "append" and not exists:
        return fail("missing", [f"目标不存在（append 不创建）：{rel}"])
    if action == "create":
        parent = target.parent
        if parent.is_symlink():
            return fail("invalid", [f"父目录是符号链接，拒绝：{parent}"])
        if not parent.is_dir():
            # 话术「<内容> 保存到灵感」：rel=灵感/<标题>/idea.md，标题目录首建时父链不存在。
            # 逐段创建（不 mkdir -p 一步到位，保证每段都可拒绝符号链接，§2.2 防护不放松）；
            # 失败回滚本次新建段，不留半成品目录。
            rel_parts = rel.strip().replace("\\", "/").split("/")[:-1]
            cur = vault_root
            made: list[Path] = []
            try:
                for part in rel_parts:
                    cur = cur / part
                    if cur.is_symlink():
                        raise OSError(f"rel 路径段是符号链接，拒绝：{cur}")
                    if not cur.exists():
                        cur.mkdir()
                        made.append(cur)
                    elif not cur.is_dir():
                        raise OSError(f"rel 路径段已存在且不是目录：{cur}")
            except OSError as e:
                for p in reversed(made):
                    try:
                        p.rmdir()
                    except OSError:
                        pass
                return fail("invalid", [f"父目录创建失败：{e}"])
    if action == "append" and (target.is_symlink() or not target.is_file()):
        return fail("invalid", [f"目标不是普通文件（或为符号链接），拒绝 append：{rel}"])

    # started → 写 → done（写失败落 failed 干净收口，允许重试）
    append_event(ledger_root, {
        "event": "started", "operationId": op_id, "action": action, "rel": rel, "contentDigest": content_digest,
    })
    try:
        flags = os.O_WRONLY | os.O_APPEND if action == "append" else os.O_WRONLY | os.O_CREAT | os.O_EXCL
        fd = os.open(str(target), flags, 0o644)
        try:
            written = 0
            view = memoryview(content)
            while written < len(content):
                written += os.write(fd, view[written:])
            os.fsync(fd)
        finally:
            os.close(fd)
    except FileExistsError:
        append_event(ledger_root, {"event": "failed", "operationId": op_id, "reason": "conflict(O_EXCL)"})
        return fail("conflict", [f"目标已存在（O_EXCL 语义拒绝创建）：{rel}"])
    except FileNotFoundError:
        append_event(ledger_root, {"event": "failed", "operationId": op_id, "reason": "missing"})
        return fail("missing", [f"目标不存在（append 不创建）：{rel}"])
    except OSError as e:
        append_event(ledger_root, {"event": "failed", "operationId": op_id, "reason": f"io_error:{e}"})
        return fail("io_error", [f"写入失败：{e}"])

    append_event(ledger_root, {
        "event": "done", "operationId": op_id, "action": action, "rel": rel,
        "bytes": len(content), "contentDigest": content_digest,
    })
    return {
        "ok": True,
        "action": action,
        "status": "created" if action == "create" else "appended",
        "rel": rel,
        "operationId": op_id,
        "bytes": len(content),
        "contentDigest": content_digest,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Obsidian vault 写后端（P1a Phase W）")
    parser.add_argument("--action", choices=["create", "append"], help="create|append（--dump 时可省）")
    parser.add_argument("--rel", help="vault 相对路径（.md；--dump 时可省）")
    parser.add_argument("--operation-id", help="幂等台账键（服务端派生；--dump 时可省）")
    parser.add_argument("--vault-root", help="覆盖 vault 根（优先级最高）")
    parser.add_argument("--ledger-root", help="覆盖台账根（测试旗标）")
    parser.add_argument("--dump", action="store_true", help="打印台账后退出（人工核对通道）")
    args = parser.parse_args()

    if args.dump:
        root, cfg_root, _, issues = resolve_vault_root(args.vault_root)
        if issues:
            out(fail("invalid", issues))
            return 0
        out({"ok": True, "ledger": str(ledger_path(resolve_ledger_root(args.ledger_root, cfg_root))),
             "events": read_events(resolve_ledger_root(args.ledger_root, cfg_root))})
        return 0

    if not args.action:
        out(fail("invalid", ["--action 必填（create|append），或使用 --dump 查看台账"]))
        return 0

    issues: list[str] = []
    issues += validate_operation_id(args.operation_id or "")
    issues += validate_rel(args.rel or "")
    if issues:
        out(fail("invalid", issues))
        return 0

    root, cfg_root, _, issues = resolve_vault_root(args.vault_root)
    if issues:
        out(fail("invalid", issues))
        return 0

    out(do_write(root, resolve_ledger_root(args.ledger_root, cfg_root), args.action, args.rel, args.operation_id))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
