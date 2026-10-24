#!/usr/bin/env python3
"""archive_inspire.py —— 灵感区归档写入器（设计V2 §6.2/§4，Python stdlib）

职责（输入：提炼后的结构化字段；输出：素材 md 相对路径）：
  1. 定位 vault root（--vault-root > OBSIDIAN_VAULT_ROOT > .aws-article/config.json vault_root）
  2. 硬约束：所有写入必须位于 <vault>/<inspire_dir>/ 前缀内（commonpath 校验 + 目标段不得含符号链接）
  3. 安全创建子目录：素材文件夹名 = sanitize(标题)；不同视频撞标题 → 序号后缀「 (2)」「 (3)」（确定性，不用时间戳）
  4. 原子写入：<file>.tmp-<pid> + os.replace；frontmatter 由本脚本拼装（LLM 输出只进正文受控字段，杜绝元数据注入）
  5. 幂等与锁：frontmatter 扫查（sourceKey 比对）+ .vd/locks/<sourceKey>.lock open(wx) 原子占位（30min 陈锁接管）

子命令（命名参数，stdout 纯 JSON，exit 0=ok / 1=fail）：
  check   --source-key K            已归档？锁占用？→ {ok, archived, title, rel_dir, locked, lock_stale}
  lock    --source-key K            原子占位 → {ok, locked, busy?} / 陈锁接管 {ok, locked, took_over}
  unlock  --source-key K            释放锁（尽力而为）→ {ok}
  archive --title T --summary-file F --source-platform P --source-id I --source-url U
          --uploader W --duration D [--core-point X ...] [--inspiration X ...] [--research X ...]
          [--to-verify X ...] [--tag X ...] [--transcript-file F]
          归档 → {ok, duplicate?, title, rel_dir, file_rel, vault_root}

summary-file 为 JSON（{title, core_points[], wechat_inspirations[], further_research[], to_verify[], tags[]}），
文章=整理排版后的逐字稿（0-raw.md，仅插入换行零内容修改，reflow()）；transcript-file 为完整逐字稿文本。
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

INSPIRE_DIR_DEFAULT = "60_Workspace/写作/灵感"
LOCK_STALE_SEC = 30 * 60  # §4.2：30 分钟陈锁接管
TITLE_MAX = 20  # §7.2：标题 ≤20 字，代码侧双保险

OUTPUT_CONTRACT = "[OK]"  # 兼容仓库脚本协议：stdout 首行 JSON；人读时含 ok 字段即可


def out(payload: dict, code: int) -> int:
    payload.setdefault("ok", code == 0)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return code


def fail(message: str, **extra) -> int:
    payload = {"ok": False, "error": message}
    payload.update(extra)
    return out(payload, 1)


# ── vault root 发现链（§6.1，与 vault_resolver.py 同链） ──

def find_config(start: Path) -> Path | None:
    for cur in [start, *start.parents]:
        candidate = cur / ".aws-article" / "config.json"
        if candidate.is_file():
            return candidate
    return None


def discover_vault_root(cli_value: str | None) -> tuple[str | None, str]:
    if cli_value:
        return cli_value, "cli"
    env = os.environ.get("OBSIDIAN_VAULT_ROOT", "").strip()
    if env:
        return env, "env"
    for anchor in (Path.cwd(), Path(__file__).resolve().parent):
        cfg = find_config(anchor)
        if cfg:
            try:
                vault = json.loads(cfg.read_text(encoding="utf-8")).get("vault_root", "")
            except (OSError, ValueError):
                continue
            if isinstance(vault, str) and vault.strip():
                return vault.strip(), f"config:{cfg}"
    return None, "none"


def inspire_dir_from_config() -> str:
    cfg = find_config(Path.cwd()) or find_config(Path(__file__).resolve().parent)
    if cfg:
        try:
            d = json.loads(cfg.read_text(encoding="utf-8")).get("inspire_dir", "")
            if isinstance(d, str) and d.strip():
                return d.strip().strip("/")
        except (OSError, ValueError):
            pass
    return INSPIRE_DIR_DEFAULT


# ── 路径安全（§6.2 硬约束） ──

def ensure_under(child: Path, root: Path) -> bool:
    """child 必须位于 root 内且中间路径段不含符号链接。"""
    try:
        resolved_child = child.resolve()
        resolved_root = root.resolve()
        if os.path.commonpath([str(resolved_child), str(resolved_root)]) != str(resolved_root):
            return False
    except (OSError, ValueError):
        return False
    cur = resolved_root
    for part in resolved_child.relative_to(resolved_root).parts:
        cur = cur / part
        if cur.is_symlink():
            return False
    return True


TITLE_SEPS = " ，。！？；：、，,!?~·|-—｜|/　"  # 词边界分隔符（空格/标点/破折号等）


def smart_truncate(t: str, cap: int = TITLE_MAX, floor: int = 8) -> str:
    """超长标题词边界截断（用户要求 2026-10-24：不切在词中间）。

    优先级：①≤cap 直接返回；②ASCII 词内不切（往回退到词首）；
    ③窗口 [floor, cap) 内最后一个分隔符处切（切后去尾部分隔符）；
    ④均不适用 → 硬截（纯 CJK 无分隔符时不可避免）。floor 保证不退化成过短目录名。
    """
    if len(t) <= cap:
        return t
    cut = t[:cap]
    # ② ASCII 字母数字串内不切（cut 恰好在词尾、下一字符已非同词时无需回退）
    if (
        len(cut) >= 2
        and cut[-1].isascii() and cut[-1].isalnum()
        and cut[-2].isascii() and cut[-2].isalnum()
        and cap < len(t) and t[cap].isascii() and t[cap].isalnum()
    ):
        i = len(cut) - 1
        while i > floor and cut[i - 1].isascii() and cut[i - 1].isalnum():
            i -= 1
        trimmed = cut[:i].rstrip(TITLE_SEPS)
        if len(trimmed) >= floor:
            return trimmed
    # ③ 窗口内最后一个分隔符处切
    best = -1
    for i in range(floor, cap):
        if cut[i] in TITLE_SEPS:
            best = i
    if best >= 0:
        trimmed = cut[:best].rstrip(TITLE_SEPS)
        if len(trimmed) >= floor:
            return trimmed
    # ④ 硬截
    return cut.rstrip(TITLE_SEPS) or cut


def sanitize_title(raw: str) -> str:
    """§7.2：去路径/文件系统危险字符与控制字符，压缩空白，词边界截断 20 字（不切在词中间）。"""
    banned = '/\\:*?"<>|'
    cleaned = "".join(ch for ch in raw if ch not in banned and ord(ch) >= 32)
    cleaned = " ".join(cleaned.split())
    cleaned = smart_truncate(cleaned)
    return cleaned

SENT_END = "。！？；!?;"  # 句末标点（含全半角），断句依据


def reflow(text: str, sentences_per_para: int = 4) -> str:
    """逐字稿排版整理（用户流程调整 2026-10-24）：只插入换行，零内容修改。

    - 先压平既有换行（原文无换行，此步为多行输入兼容；内容字符不增不减）
    - 句末标点后断句；每 N 句聚成一段，段间空行
    - 不变式：reflow(t) 去掉换行后与原文逐字符相等
    """
    t = text.replace("\r", "").replace("\n", "")
    if not t.strip():
        return t
    sentences: list[str] = []
    buf: list[str] = []
    for ch in t:
        buf.append(ch)
        if ch in SENT_END:
            sentences.append("".join(buf))
            buf = []
    if buf:
        sentences.append("".join(buf))
    paras = ["".join(sentences[i:i + sentences_per_para]) for i in range(0, len(sentences), sentences_per_para)]
    return "\n\n".join(paras)


def safe_source_key(sk: str) -> str:
    """sourceKey 文件名化（douyin:738... → douyin_738...；同 adapter workdir 规则）。"""
    return "".join(ch if (ch.isalnum() or ch in "-_") else "_" for ch in sk)


# ── frontmatter 扫查（§4.1 幂等索引：frontmatter 即唯一事实源） ──

def scan_frontmatter(md_file: Path) -> dict:
    try:
        text = md_file.read_text(encoding="utf-8")
    except OSError:
        return {}
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    meta = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if ":" in line:
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip()
    return meta


def find_archived(inspire_root: Path, source_platform: str, source_id: str) -> tuple[str, Path] | None:
    """扫描灵感根各 <标题>/*.md frontmatter，拼 sourceKey 比对（百级目录全扫描成本可忽略）。"""
    if not inspire_root.is_dir():
        return None
    for sub in sorted(inspire_root.iterdir()):
        if not sub.is_dir() or sub.name.startswith("."):
            continue
        for md in sorted(sub.glob("*.md")):
            meta = scan_frontmatter(md)
            if meta.get("source_platform") == source_platform and meta.get("source_id") == source_id:
                return sub.name, md
    return None


# ── 锁（§4.2 原子占位） ──

def lock_path(inspire_root: Path, source_key: str) -> Path:
    return inspire_root / ".vd" / "locks" / (safe_source_key(source_key) + ".lock")


def read_lock(p: Path) -> dict | None:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def cmd_lock(inspire_root: Path, source_key: str, claimer: str) -> int:
    lp = lock_path(inspire_root, source_key)
    lp.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"startedAt": time.time(), "startedAtIso": time.strftime("%Y-%m-%dT%H:%M:%S"), "claimer": claimer}, ensure_ascii=False)
    try:
        with open(lp, "x", encoding="utf-8") as f:  # O_EXCL：POSIX 原子
            f.write(payload + "\n")
        return out({"ok": True, "locked": True, "lockFile": str(lp)}, 0)
    except FileExistsError:
        existing = read_lock(lp)
        if existing is None:  # 损坏锁：视同陈锁接管
            lp.write_text(payload + "\n", encoding="utf-8")
            return out({"ok": True, "locked": True, "took_over": True, "reason": "损坏锁重写"}, 0)
        age = time.time() - float(existing.get("startedAt", 0) or 0)
        if age >= LOCK_STALE_SEC:
            lp.write_text(payload + "\n", encoding="utf-8")
            return out({"ok": True, "locked": True, "took_over": True, "previousAgeSec": round(age)}, 0)
        return out({"ok": True, "locked": False, "busy": True, "ageSec": round(age)}, 0)
    except OSError as e:
        return fail(f"锁创建失败：{e}")


def cmd_unlock(inspire_root: Path, source_key: str) -> int:
    lp = lock_path(inspire_root, source_key)
    try:
        lp.unlink(missing_ok=True)
        return out({"ok": True, "unlocked": True}, 0)
    except OSError as e:
        return fail(f"锁删除失败：{e}")


def cmd_check(inspire_root: Path, source_platform: str, source_id: str, source_key: str) -> int:
    hit = find_archived(inspire_root, source_platform, source_id)
    lp = lock_path(inspire_root, source_key)
    lock_state = {"locked": False, "lock_stale": False}
    if lp.exists():
        existing = read_lock(lp)
        age = time.time() - float((existing or {}).get("startedAt", 0) or 0)
        lock_state = {"locked": True, "lock_stale": age >= LOCK_STALE_SEC, "ageSec": round(max(age, 0))}
    if hit:
        return out({"ok": True, "archived": True, "title": hit[0], "rel_dir": hit[1].parent.name,
                    "file_rel": str(hit[1].relative_to(inspire_root)), **lock_state}, 0)
    return out({"ok": True, "archived": False, **lock_state}, 0)


# ── 归档（§6.2/§7.1） ──

def yaml_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')



def dedupe_dir(inspire_root: Path, title: str) -> Path:
    """不同视频撞标题 → 序号后缀确定性递增（§4.1）。"""
    candidate = inspire_root / title
    n = 2
    while candidate.exists():
        candidate = inspire_root / f"{title} ({n})"
        n += 1
    return candidate


def cmd_archive(args) -> int:
    vault_root_raw, source = discover_vault_root(args.vault_root)
    if not vault_root_raw:
        return fail("vault root 未定位（--vault-root / OBSIDIAN_VAULT_ROOT / .aws-article/config.json 均无）", discovered=source)
    vault = Path(vault_root_raw).expanduser()
    if not vault.is_dir():
        return fail(f"vault root 不是目录：{vault}")
    inspire = vault / inspire_dir_from_config()
    inspire.mkdir(parents=True, exist_ok=True)

    # 幂等命中：同 sourceKey 已归档 → 返回既有路径，不建新目录不重写（§4.1）
    hit = find_archived(inspire, args.source_platform, args.source_id)
    if hit:
        return out({"ok": True, "duplicate": True, "title": hit[0], "rel_dir": hit[1].parent.name,
                    "file_rel": str(hit[1].relative_to(inspire)), "vault_root": str(vault)}, 0)

    # 标题（用户新流程 2026-10-24：标题=视频页面原标题，非 AI 生成）：目录名 sanitize（≤20字），frontmatter 存完整原题
    full_title = " ".join(str(args.title or "").split())
    title = sanitize_title(full_title)
    if not title:
        return fail("标题 sanitize 后为空")

    # 先解析全部输入（逐字稿/摘要），成功后才建目录——失败不留半成品目录（踩坑：transcript 解析失败曾残留空目录导致后续归档被 dedupe 成 (2)）
    transcript = ""
    if args.transcript_file:
        try:
            transcript = Path(args.transcript_file).read_text(encoding="utf-8")
        except OSError as e:
            return fail(f"逐字稿文件不可读：{e}")
    elif args.transcript_json:
        # adapter 落盘的 transcript.json（Transcript 结构）：取 text 字段，无则拼接 segments
        try:
            tdata = json.loads(Path(args.transcript_json).read_text(encoding="utf-8"))
            if isinstance(tdata, dict):
                transcript = tdata.get("text") or "".join(
                    seg.get("text", "") for seg in tdata.get("segments", []) if isinstance(seg, dict)
                )
            elif isinstance(tdata, list):
                # 根节点直接是 segments 数组（transcribeAudio 写 segments）
                transcript = "".join(
                    seg.get("text", "") for seg in tdata if isinstance(seg, dict)
                )
            else:
                return fail("transcript-json 根节点既不是对象也不是数组")
        except (OSError, ValueError) as e:
            return fail(f"transcript.json 不可读：{e}")

    target_dir = dedupe_dir(inspire, title)
    # 硬约束：写入路径必须位于灵感根前缀内（防 ../ 逃逸；sanitize 已去 /，双保险）
    if not ensure_under(target_dir / (title + ".md"), inspire):
        return fail(f"目标路径越界（必须在 {inspire} 内）：{target_dir}")
    target_dir.mkdir(parents=True, exist_ok=False)
    md_file = target_dir / "0-raw.md"  # 用户流程调整 2026-10-24：文章=整理排版后的逐字稿，固定文件名，零 AI 评论

    tags = [t for t in (args.source_platform, args.uploader) if t]
    fm_lines = [
        "---",
        f'title: "{yaml_escape(full_title)}"',
        f"source_platform: {args.source_platform}",
        f"source_id: {args.source_id}",
        f'source_url: "{yaml_escape(args.source_url)}"',
        f'uploader: "{yaml_escape(args.uploader or "")}"',
        f"duration: {int(args.duration) if args.duration is not None else 'null'}",
        "status: 待消化",
        f"tags: [{', '.join(tags)}]",
        f"created_at: {time.strftime('%Y-%m-%dT%H:%M:%S')}",
        "---",
    ]
    body: list[str] = []
    body.append(f"# {full_title}")
    body.append("")
    # 整理排版后的逐字稿：仅插入换行（句末标点后断句、每 4 句成段），零内容修改
    body.append(reflow(transcript) if transcript.strip() else "（转写结果为空）")
    body.append("")

    content = "\n".join(fm_lines) + "\n\n" + "\n".join(body)

    # 原子写入：tmp + os.replace
    tmp = md_file.with_name(md_file.name + f".tmp-{os.getpid()}")
    try:
        tmp.write_text(content, encoding="utf-8")
        os.replace(tmp, md_file)
    except OSError as e:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return fail(f"写入失败：{e}", target=str(md_file))

    return out({"ok": True, "duplicate": False, "title": title,
                "rel_dir": target_dir.name,
                "file_rel": str(md_file.relative_to(inspire)),
                "vault_root": str(vault), "inspire_root": str(inspire)}, 0)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="灵感区归档写入器（设计V2 §6.2）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_check = sub.add_parser("check", help="幂等查重 + 锁状态")
    p_check.add_argument("--source-key", required=True)
    p_check.add_argument("--source-platform", default="")
    p_check.add_argument("--source-id", default="")
    p_check.add_argument("--vault-root", default=None)

    p_lock = sub.add_parser("lock", help="原子占位锁")
    p_lock.add_argument("--source-key", required=True)
    p_lock.add_argument("--claimer", default="workflow")
    p_lock.add_argument("--vault-root", default=None)

    p_unlock = sub.add_parser("unlock", help="释放锁")
    p_unlock.add_argument("--source-key", required=True)
    p_unlock.add_argument("--vault-root", default=None)

    p_arch = sub.add_parser("archive", help="归档素材 md")
    p_arch.add_argument("--title", required=True)
    p_arch.add_argument("--source-platform", required=True)
    p_arch.add_argument("--source-id", required=True)
    p_arch.add_argument("--source-url", required=True)
    p_arch.add_argument("--uploader", default="")
    p_arch.add_argument("--duration", default=None, type=float)
# duration 整数化: 984.0 -> 984, 避免时间戳写成浮点
    p_arch.add_argument("--transcript-file", default=None)
    p_arch.add_argument("--transcript-json", default=None)
    p_arch.add_argument("--vault-root", default=None)

    args = parser.parse_args(argv)
    vault_root_raw, _ = discover_vault_root(getattr(args, "vault_root", None))
    if args.cmd in ("check", "lock", "unlock") and not vault_root_raw:
        return fail("vault root 未定位（--vault-root / OBSIDIAN_VAULT_ROOT / .aws-article/config.json 均无）")

    if args.cmd == "archive":
        return cmd_archive(args)

    vault = Path(vault_root_raw).expanduser()  # type: ignore[arg-type]
    if args.cmd in ("check", "lock") and not vault.is_dir():
        return fail(f"vault root 不是目录：{vault}")
    inspire = vault / inspire_dir_from_config()
    if args.cmd == "check":
        platform = args.source_platform or (args.source_key.split(":", 1)[0] if ":" in args.source_key else "")
        vid = args.source_id or (args.source_key.split(":", 1)[1] if ":" in args.source_key else "")
        return cmd_check(inspire, platform, vid, args.source_key)
    if args.cmd == "lock":
        return cmd_lock(inspire, args.source_key, args.claimer)
    return cmd_unlock(inspire, args.source_key)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
