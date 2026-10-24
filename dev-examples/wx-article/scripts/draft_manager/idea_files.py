#!/usr/bin/env python3
"""idea_files.py — idea_to_article 阶段产物确定性文件工具（纯 stdlib）。

契约：dev-docs/design/2026-10-24-idea-to-article-v1-执行方案.md §2 D4 / §5.1
- 工作目录必须位于 <vault>/60_Workspace/写作/灵感/ 之内（vault 根解析链与 vault_query.py 一致：
  --vault-root > OBSIDIAN_VAULT_ROOT env > obsidian.config.json > .aws-article/config.json）
- 1-idea.md 只允许 init 写一次 + append 补充段，禁止覆盖重写（原始灵感保护，需求 §10.1）
- write：原子写（tempfile+rename）+ 写前自动备份 .history/<name>-v<N>.md + 目录内 RMW 锁
- article.yaml 为业务状态权威（行式固定字段集，本工具为唯一写入口）
- stdout 单 JSON；退出码恒 0；ok 字段承载语义；不回显全文内容

子命令：
  init          --title --source-channel --message-id [--user-id]（stdin=原始灵感全文）
  adopt-check   --title
  locate        --title
  list
  read          --dir --file <白名单名>
  write         --dir --file <白名单名> --reason <短语>（stdin=新内容）
  append        --dir --file 1-idea.md|messages.jsonl [--role --turn --message-id]（stdin=内容）
  stale         --dir --from topic|brief|outline
  state         --dir --set k=v [--set k=v ...]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from contextlib import redirect_stdout
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from article_lock import ArticleLock, LockHeldError  # noqa: E402
from vault_query import resolve_vault_root  # noqa: E402

MAX_CONTENT_BYTES = 1024 * 1024
IDEA_RELPATH = Path("60_Workspace") / "写作" / "灵感"
LOCK_NAME = ".idea-files.rmw.lock"
HISTORY_DIR = ".history"
YAML_NAME = "article.yaml"
IDEA_NAME = "1-idea.md"
MESSAGES_NAME = "messages.jsonl"

# 阶段文件白名单（read/write 允许；1-idea.md 与 article.yaml 另有专用通道）
STAGE_FILES = [
    "1-idea.md",
    "2-topic.md",
    "3-brief.md",
    "4-outline.md",
    "5-article.md",
    "6-review.md",
    "7-publish.md",
    "配图建议.md",
    "messages.jsonl",
]
WRITABLE_STAGE_FILES = [
    "2-topic.md",
    "3-brief.md",
    "4-outline.md",
    "5-article.md",
    "6-review.md",
    "7-publish.md",
    "配图建议.md",
]
READABLE_FILES = WRITABLE_STAGE_FILES + [IDEA_NAME, MESSAGES_NAME, YAML_NAME]

STAGE_KEY_TO_FILE = {
    "idea": IDEA_NAME,
    "topic": "2-topic.md",
    "brief": "3-brief.md",
    "outline": "4-outline.md",
    "article": "5-article.md",
    "review": "6-review.md",
    "publish": "7-publish.md",
}
# 上游变更 → 下游失效矩阵（需求 §7.3）
STALE_DOWNSTREAM = {
    "topic": ["brief", "outline", "article", "review"],
    "brief": ["outline", "article", "review"],
    "outline": ["article", "review"],
}
STALE_STATUS_ROLLBACK = {
    "topic": "waiting_topic_confirmation",
    "brief": "brief_confirmed",
    "outline": "outline_generated",
}

# article.yaml 顶层键序（序列化确定性）
YAML_KEYS = [
    "schemaVersion",
    "articleId",
    "title",
    "source",
    "workflow",
    "status",
    "currentStage",
    "approval",
    "files",
    "stale",
    "revision",
    "lastRunId",
    "handoff",
    "config",
    "stats",
    "createdAt",
    "updatedAt",
]
STATUS_VALUES = {
    "idea_captured",
    "topic_generated",
    "waiting_topic_confirmation",
    "brief_confirmed",
    "outline_generated",
    "drafting",
    "reviewing",
    "draft_ready",
    "needs_revision",
    "handed_off",
    "paused",
    "abandoned",
}
# state --set 允许的键（点路径）与值约束
STATE_SETTABLE = {
    "title": str,
    "status": STATUS_VALUES,
    "currentStage": str,
    "approval.topic": {"pending", "approved", "rejected", "not_required"},
    "approval.outline": {"pending", "approved", "rejected", "not_required"},
    "approval.publish": {"not_requested", "pending", "approved", "rejected"},
    "lastRunId": str,
    "handoff.articleDir": str,
    "handoff.handoffId": str,
    "config.outlineApproval": {"true", "false"},
    "config.targetWords": str,
    "config.reviewFixLimit": str,
    "config.historyTurns": str,
}

TITLE_ILLEGAL = re.compile(r"[/\\:*?\"<>|;'`$&\x00-\x1f\x7f]")


def out(payload: dict) -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False))


def fail(code: str, issues: list[str], **extra) -> dict:
    payload = {"ok": False, "code": code, "issues": issues}
    payload.update(extra)
    return payload


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def new_article_id() -> str:
    return f"art_{time.strftime('%Y%m%d')}_{os.urandom(2).hex()}"


def normalize_title(title: str) -> str:
    t = re.sub(r"\s+", " ", (title or "").strip())
    t = TITLE_ILLEGAL.sub(" ", t)
    t = re.sub(r" +", " ", t).strip()
    if len(t) > 64:
        t = t[:64].strip()
    return t


def validate_title_segment(seg: str) -> list[str]:
    if not seg or seg.startswith("."):
        return [f"标题不能为空或以点开头: {seg!r}"]
    if TITLE_ILLEGAL.search(seg):
        return ["标题含非法字符(路径分隔符/控制字符/shell 元字符)"]
    if seg in {".", ".."}:
        return ["标题不能是 . 或 .."]
    return []


def read_stdin() -> tuple[bytes | None, list[str]]:
    data = sys.stdin.buffer.read()
    if len(data) > MAX_CONTENT_BYTES:
        return None, [f"内容超限: {len(data)} > {MAX_CONTENT_BYTES} 字节"]
    return data, []


def content_text(data: bytes) -> str:
    return data.decode("utf-8", errors="strict")


# ---------------------------------------------------------------- vault/dir


def idea_root(vault_root: Path) -> Path:
    return vault_root / IDEA_RELPATH


def resolve_dir(raw_dir: str | None, root: Path) -> tuple[Path | None, list[str]]:
    """校验工作目录：resolve 后必须位于灵感根之内。

    逐段 symlink 检查在 macOS 会误杀系统级 /var→/private/var 前缀（tmpdir 场景），
    且 resolve+前缀约束已等价防逃逸：vault 内 symlink 段一旦把最终路径引出灵感根即拒绝。
    """
    if not raw_dir:
        return None, ["缺少 --dir"]
    p = Path(raw_dir)
    if not p.is_absolute():
        return None, ["--dir 必须是绝对路径"]
    root_real = root.resolve()
    try:
        real = p.resolve()
        real.relative_to(root_real)
    except ValueError:
        return None, [f"工作目录越界(必须在 {root_real} 内): {p}"]
    if real == root_real:
        return None, ["--dir 不得为灵感根本身"]
    if not real.is_dir():
        return None, [f"任务目录不存在: {p}"]
    return real, []


def load_state_yaml(workdir: Path) -> dict:
    """行式 yaml 解析为嵌套 dict（字段集固定，两空格缩进）。"""
    result: dict = {}
    stack: list[tuple[int, dict]] = [(0, result)]
    for line in (workdir / YAML_NAME).read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        body = line.strip()
        if ":" not in body:
            continue
        key, _, value = body.partition(":")
        key = key.strip()
        value = value.strip()
        while stack and indent <= stack[-1][0] and len(stack) > 1:
            stack.pop()
        parent = stack[-1][1]
        if value == "":
            child: dict = {}
            parent[key] = child
            stack.append((indent, child))
        else:
            if value == "{}" or value == "[]":
                parent[key] = {} if value == "{}" else []
            else:
                parent[key] = value
    return result


def render_state_yaml(state: dict) -> str:
    """确定性序列化：固定键序 + 两空格缩进；dict 空则 {}。"""
    lines: list[str] = []

    def emit(container: dict, keys: list[str], depth: int) -> None:
        pad = "  " * depth
        for key in keys:
            if key not in container:
                continue
            val = container[key]
            if isinstance(val, dict):
                if not val:
                    lines.append(f"{pad}{key}: {{}}")
                else:
                    lines.append(f"{pad}{key}:")
                    emit(val, list(val.keys()), depth + 1)
            else:
                lines.append(f"{pad}{key}: {val}")

    emit(state, YAML_KEYS, 0)
    return "\n".join(lines) + "\n"


def default_state(title: str, article_id: str, channel: str, message_id: str, user_id: str) -> dict:
    return {
        "schemaVersion": 1,
        "articleId": article_id,
        "title": title,
        "source": {"channel": channel, "messageId": message_id, "userId": user_id},
        "workflow": {"name": "idea_to_article", "version": 1},
        "status": "idea_captured",
        "currentStage": "idea",
        "approval": {"topic": "pending", "outline": "not_required", "publish": "not_requested"},
        "files": {k: v for k, v in STAGE_KEY_TO_FILE.items()},
        "stale": {},
        "revision": 1,
        "handoff": {},
        "config": {
            "outlineApproval": "false",
            "targetWords": "1500-2500",
            "reviewFixLimit": "2",
            "historyTurns": "8",
        },
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }


def atomic_write(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def with_rmw_lock(workdir: Path, fn):
    lock = ArticleLock(workdir / LOCK_NAME, run_id=f"idea-files-{os.getpid()}", scope="idea-rmw")
    try:
        with redirect_stdout(sys.stderr), lock:  # 锁接管诊断行进 stderr，保 stdout 单 JSON 契约
            return fn()
    except LockHeldError as e:
        info = getattr(e, "info", {}) or {}
        return fail("locked", [f"工作目录被其他进程持有 RMW 锁(pid={info.get('pid')})，请稍后重试"])


def backup_and_bump(workdir: Path, name: str, state: dict) -> None:
    """写前备份已有文件到 .history/<stem>-v<N>.md 并 revision+1（无旧文件则仅 bump）。"""
    target = workdir / name
    if target.exists():
        hist = workdir / HISTORY_DIR
        hist.mkdir(exist_ok=True)
        rev = int(state.get("revision", 1))
        stem = Path(name).stem
        backup = hist / f"{stem}-v{rev}.md"
        backup.write_bytes(target.read_bytes())
    state["revision"] = int(state.get("revision", 1)) + 1


# ---------------------------------------------------------------- 子命令


def do_init(args, root: Path) -> dict:
    issues: list[str] = []
    title_norm = normalize_title(args.title)
    issues += validate_title_segment(title_norm)
    data, size_issues = read_stdin()
    issues += size_issues
    if data is None and not issues:
        issues.append("缺少 stdin 内容")
    if issues:
        return fail("invalid", issues)
    if not args.message_id:
        return fail("invalid", ["缺少 --message-id（幂等键）"])

    workdir = root / title_norm
    exists = workdir.exists()
    if exists and (workdir / YAML_NAME).exists():
        state = load_state_yaml(workdir)
        if state.get("source", {}).get("messageId") == args.message_id:
            return {
                "ok": True,
                "idempotent": True,
                "created": False,
                "dir": str(workdir),
                "articleId": state.get("articleId"),
                "title": state.get("title"),
                "status": state.get("status"),
            }
        return fail(
            "conflict",
            [f"同名任务已存在(articleId={state.get('articleId')})，不同消息不得合并或覆盖；可换标题重试"],
            dir=str(workdir),
        )

    # 新建或领养（主话术已建目录但无 article.yaml）
    if not exists:
        try:
            workdir.mkdir(parents=False)
        except FileNotFoundError:
            return fail("io_error", [f"灵感根目录不存在: {root}"])
        except FileExistsError:
            return fail("conflict", [f"目录已被并发创建: {workdir}"])

    def build() -> dict:
        idea_path = workdir / IDEA_NAME
        adopted = False
        if idea_path.exists():
            adopted = True  # 领养：原始 1-idea.md 原样保留
        else:
            atomic_write(idea_path, content_text(data))
        article_id = new_article_id()
        state = default_state(title_norm, article_id, args.source_channel, args.message_id, args.user_id or "")
        if adopted:
            state["status"] = "idea_captured"
            state["currentStage"] = "idea"
        first_msg = {
            "ts": now_iso(),
            "role": "user",
            "content": content_text(data),
            "turn": 1,
            "messageId": args.message_id,
        }
        with open(workdir / MESSAGES_NAME, "a", encoding="utf-8") as f:
            f.write(json.dumps(first_msg, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())
        atomic_write(workdir / YAML_NAME, render_state_yaml(state))
        return {
            "ok": True,
            "created": True,
            "adopted": adopted,
            "idempotent": False,
            "dir": str(workdir),
            "articleId": article_id,
            "title": title_norm,
            "status": state["status"],
        }

    return with_rmw_lock(workdir, build)


def scan_tasks(root: Path) -> list[dict]:
    tasks = []
    if not root.exists():
        return tasks
    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.is_symlink() or child.name.startswith("."):
            continue
        yaml_path = child / YAML_NAME
        if not yaml_path.exists():
            continue
        try:
            state = load_state_yaml(child)
        except (OSError, ValueError):
            continue
        tasks.append(
            {
                "title": state.get("title", child.name),
                "articleId": state.get("articleId"),
                "dir": str(child),
                "dirName": child.name,
                "status": state.get("status"),
                "updatedAt": state.get("updatedAt"),
                "stale": sorted((state.get("stale") or {}).keys()),
            }
        )
    return tasks


def do_locate(args, root: Path) -> dict:
    title_norm = normalize_title(args.title)
    tasks = scan_tasks(root)
    exact = [t for t in tasks if normalize_title(t["title"]) == title_norm]
    if len(exact) == 1:
        return {"ok": True, "match": "exact", **exact[0]}
    if len(exact) > 1:
        return fail("ambiguous", ["多个任务同名，请用目录名消歧"], candidates=exact)
    partial = [t for t in tasks if title_norm and title_norm in normalize_title(t["title"])]
    if len(partial) == 1:
        return {"ok": True, "match": "partial", **partial[0]}
    if len(partial) > 1:
        return fail(
            "ambiguous",
            ["含糊标题命中多个任务，请回复编号或完整标题"],
            candidates=[
                {"title": t["title"], "dirName": t["dirName"], "status": t["status"]} for t in partial
            ],
        )
    return fail("not_found", [f"没有找到标题含「{args.title}」的任务，请先用主话术创建"])


def do_adopt_check(args, root: Path) -> dict:
    title_norm = normalize_title(args.title)
    seg_issues = validate_title_segment(title_norm)
    if seg_issues:
        return fail("invalid", seg_issues)
    workdir = root / title_norm
    if not workdir.exists():
        return {"ok": True, "exists": False, "hasState": False, "dir": str(workdir)}
    has_state = (workdir / YAML_NAME).exists()
    return {
        "ok": True,
        "exists": True,
        "hasState": has_state,
        "dir": str(workdir),
        "hasIdea": (workdir / IDEA_NAME).exists(),
    }


def do_list(_args, root: Path) -> dict:
    tasks = scan_tasks(root)
    return {"ok": True, "tasks": tasks, "total": len(tasks)}


def do_read(args, root: Path) -> dict:
    workdir, issues = resolve_dir(args.dir, root)
    if issues:
        return fail("invalid", issues)
    name = args.file
    if name not in READABLE_FILES:
        return fail("invalid", [f"文件不在白名单内: {name}"])
    path = workdir / name
    if path.is_symlink() or not path.is_file():
        return fail("not_found", [f"文件不存在: {name}"])
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as e:
        return fail("io_error", [f"读取失败: {e}"])
    return {"ok": True, "file": name, "content": content, "size": len(content.encode("utf-8"))}


def do_write(args, root: Path) -> dict:
    workdir, issues = resolve_dir(args.dir, root)
    if issues:
        return fail("invalid", issues)
    name = args.file
    if name == IDEA_NAME:
        return fail("invalid", ["1-idea.md 为原始灵感保护文件，禁止覆盖重写（补充请用 append）"])
    if name == YAML_NAME:
        return fail("invalid", ["article.yaml 由 state/stale 子命令维护，禁止直接 write"])
    if name not in WRITABLE_STAGE_FILES:
        return fail("invalid", [f"文件不在可写白名单内: {name}"])
    data, size_issues = read_stdin()
    if size_issues:
        return fail("too_large", size_issues)
    if not data:
        return fail("invalid", ["缺少 stdin 内容"])
    if not (workdir / YAML_NAME).exists():
        return fail("not_found", ["工作目录未注册（缺 article.yaml），请先 init"])

    def perform() -> dict:
        state = load_state_yaml(workdir)
        backup_and_bump(workdir, name, state)
        text = content_text(data)
        atomic_write(workdir / name, text)
        state["updatedAt"] = now_iso()
        state["stale"].pop(next((k for k, v in STAGE_KEY_TO_FILE.items() if v == name), ""), None)
        atomic_write(workdir / YAML_NAME, render_state_yaml(state))
        return {
            "ok": True,
            "file": name,
            "bytes": len(data),
            "revision": state["revision"],
            "reason": args.reason or "",
        }

    return with_rmw_lock(workdir, perform)


def do_append(args, root: Path) -> dict:
    workdir, issues = resolve_dir(args.dir, root)
    if issues:
        return fail("invalid", issues)
    name = args.file
    data, size_issues = read_stdin()
    if size_issues:
        return fail("too_large", size_issues)
    if data is None:
        return fail("invalid", ["缺少 stdin 内容"])

    if name == MESSAGES_NAME:
        if args.role not in {"user", "assistant", "system"}:
            return fail("invalid", [f"--role 必须是 user/assistant/system: {args.role}"])
        if not data.strip():
            return fail("invalid", ["消息内容为空"])
        line = {
            "ts": now_iso(),
            "role": args.role,
            "content": content_text(data),
            "turn": args.turn if args.turn is not None else 0,
        }
        if args.message_id:
            line["messageId"] = args.message_id

        def append_msg() -> dict:
            with open(workdir / MESSAGES_NAME, "a", encoding="utf-8") as f:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")
                f.flush()
                os.fsync(f.fileno())
            return {"ok": True, "file": name, "appended": line["role"], "turn": line["turn"]}

        return with_rmw_lock(workdir, append_msg)

    if name == IDEA_NAME:
        supplement = content_text(data).strip()
        if not supplement:
            return fail("invalid", ["补充内容为空"])

        def append_idea() -> dict:
            state = load_state_yaml(workdir)
            backup_and_bump(workdir, name, state)
            block = f"\n## 补充（{now_iso()}）\n\n{supplement}\n"
            with open(workdir / IDEA_NAME, "a", encoding="utf-8") as f:
                f.write(block)
                f.flush()
                os.fsync(f.fileno())
            state["updatedAt"] = now_iso()
            atomic_write(workdir / YAML_NAME, render_state_yaml(state))
            return {"ok": True, "file": name, "appended": True, "revision": state["revision"]}

        return with_rmw_lock(workdir, append_idea)

    return fail("invalid", [f"append 只允许 1-idea.md / messages.jsonl: {name}"])


def do_stale(args, root: Path) -> dict:
    workdir, issues = resolve_dir(args.dir, root)
    if issues:
        return fail("invalid", issues)
    frm = args.from_stage
    if frm not in STALE_DOWNSTREAM:
        return fail("invalid", [f"--from 必须是 {'/'.join(STALE_DOWNSTREAM)}: {frm}"])

    def perform() -> dict:
        state = load_state_yaml(workdir)
        marked = []
        for key in STALE_DOWNSTREAM[frm]:
            fname = STAGE_KEY_TO_FILE[key]
            if (workdir / fname).exists():
                state["stale"][key] = now_iso()
                marked.append(fname)
        state["status"] = STALE_STATUS_ROLLBACK[frm]
        state["currentStage"] = frm if frm != "topic" else "topic"
        state["revision"] = int(state.get("revision", 1)) + 1
        state["updatedAt"] = now_iso()
        atomic_write(workdir / YAML_NAME, render_state_yaml(state))
        return {
            "ok": True,
            "from": frm,
            "staleMarked": marked,
            "status": state["status"],
            "note": "已标记下游产物失效；重新生成前历史版本保留在 .history/",
        }

    return with_rmw_lock(workdir, perform)


def do_state(args, root: Path) -> dict:
    workdir, issues = resolve_dir(args.dir, root)
    if issues:
        return fail("invalid", issues)
    if not args.set:
        return fail("invalid", ["缺少 --set k=v"])

    def nested_set(state: dict, dotted: str, value: str) -> list[str]:
        parts = dotted.split(".")
        spec = STATE_SETTABLE.get(dotted)
        if spec is None:
            return [f"不可设置的字段: {dotted}（白名单: {', '.join(sorted(STATE_SETTABLE))}）"]
        if isinstance(spec, set) and value not in spec:
            return [f"字段 {dotted} 的值必须是 {sorted(spec)} 之一: {value}"]
        cursor: dict = state
        for p in parts[:-1]:
            child = cursor.get(p)
            if not isinstance(child, dict):
                child = {}
                cursor[p] = child
            cursor = child
        cursor[parts[-1]] = value
        return []

    def perform() -> dict:
        state = load_state_yaml(workdir)
        for kv in args.set:
            if "=" not in kv:
                return fail("invalid", [f"--set 需要 k=v 形式: {kv}"])
            key, _, value = kv.partition("=")
            errs = nested_set(state, key.strip(), value.strip())
            if errs:
                return fail("invalid", errs)
        state["updatedAt"] = now_iso()
        atomic_write(workdir / YAML_NAME, render_state_yaml(state))
        return {"ok": True, "set": [kv.split("=", 1)[0] for kv in args.set], "status": state.get("status")}

    return with_rmw_lock(workdir, perform)


# ---------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description="idea_to_article 确定性文件工具")
    parser.add_argument("--vault-root", default=None, help="vault 根（调试/测试用；缺省走配置链）")
    sub = parser.add_subparsers(dest="action")

    p_init = sub.add_parser("init")
    p_init.add_argument("--title", required=True)
    p_init.add_argument("--source-channel", default="wechat")
    p_init.add_argument("--message-id", required=True)
    p_init.add_argument("--user-id", default="")

    p_adopt = sub.add_parser("adopt-check")
    p_adopt.add_argument("--title", required=True)

    p_locate = sub.add_parser("locate")
    p_locate.add_argument("--title", required=True)

    sub.add_parser("list")

    p_read = sub.add_parser("read")
    p_read.add_argument("--dir", required=True)
    p_read.add_argument("--file", required=True)

    p_write = sub.add_parser("write")
    p_write.add_argument("--dir", required=True)
    p_write.add_argument("--file", required=True)
    p_write.add_argument("--reason", default="")

    p_append = sub.add_parser("append")
    p_append.add_argument("--dir", required=True)
    p_append.add_argument("--file", required=True)
    p_append.add_argument("--role", default="user")
    p_append.add_argument("--turn", type=int, default=None)
    p_append.add_argument("--message-id", default="")

    p_stale = sub.add_parser("stale")
    p_stale.add_argument("--dir", required=True)
    p_stale.add_argument("--from", dest="from_stage", required=True)

    p_state = sub.add_parser("state")
    p_state.add_argument("--dir", required=True)
    p_state.add_argument("--set", action="append", default=[])

    args = parser.parse_args()
    if not args.action:
        out(fail("invalid", ["缺少子命令（init/adopt-check/locate/list/read/write/append/stale/state）"]))
        return 0

    vault_root, _cfg_root, _config, root_issues = resolve_vault_root(args.vault_root)
    if root_issues:
        out(fail("invalid", root_issues))
        return 0
    root = idea_root(vault_root)

    handlers = {
        "init": lambda: do_init(args, root),
        "adopt-check": lambda: do_adopt_check(args, root),
        "locate": lambda: do_locate(args, root),
        "list": lambda: do_list(args, root),
        "read": lambda: do_read(args, root),
        "write": lambda: do_write(args, root),
        "append": lambda: do_append(args, root),
        "stale": lambda: do_stale(args, root),
        "state": lambda: do_state(args, root),
    }
    try:
        result = handlers[args.action]()
    except (OSError, ValueError) as e:
        result = fail("io_error", [f"{type(e).__name__}: {e}"])
    out(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
