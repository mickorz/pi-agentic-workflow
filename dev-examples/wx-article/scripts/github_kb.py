#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GitHub 知识库确定性操作脚本（零 LLM）——github-research 工作流的地基。

设计文档：dev-docs/planning/2026-10-26-GitHub项目研究与推荐文章执行方案.md（V1.1）
- 3.3.1 索引并发与崩溃一致性：.kb-lock 互斥锁 + 临时文件原子替换 + rebuild-index
- 4.1   抓取缓存完整性与状态机：fetch-manifest.json 逐源记录；force 暂存替换
- 4.3   不可信输入隔离：仅 api.github.com、拒跨域重定向、路径固定、素材不参与路径拼接

用法（每个子命令向 stdout 输出单个 JSON，UTF-8）：
  github_kb.py parse-url        --url <u>
  github_kb.py detect-duplicate --root <dir> --url <u>
  github_kb.py fetch            --root <dir> --url <u> [--fixture <dir>] [--force]
  github_kb.py archive          --root <dir> --project-id <id>
                                --analysis-b64 <b64> --evidence-b64 <b64>
                                [--meta-b64 <b64>] [--staging <dir>]
  github_kb.py locate           --root <dir> --project-id <id> | --url <u>
  github_kb.py register-article --root <dir> --project-id <id> --article-id <a>
                                --angle <g> --article-dir <d>
  github_kb.py rebuild-index    --root <dir>

安全约定：本脚本只做确定性读写与校验；所有写入走临时文件 + os.replace；
索引类写操作（archive/register-article/rebuild-index）全程持有 <root>/.kb-lock。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

API_HOST = "api.github.com"
API_BASE = "https://" + API_HOST
LOCK_NAME = ".kb-lock"
LOCK_TIMEOUT_S = 30.0
LOCK_STALE_S = 120.0

SOURCES = ("repo", "readme", "languages", "tree")

# analysis.md 七段模板（标题逐字匹配；顺序不强制，但必须全部出现且非空）
SECTIONS = (
    "一句话定位",
    "核心能力",
    "技术架构与依赖",
    "适用场景与目标用户",
    "亮点与差异化",
    "风险与局限",
    "推荐角度建议",
)

EVIDENCE_LEVELS = ("documented", "code_inspected", "tested", "inferred")

SEG_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")
PERCENT_RE = re.compile(r"\d+(?:\.\d+)?\s*%")


# ── 基础工具 ──────────────────────────────────────────────

def out(payload: Dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def atomic_write(path: os.PathLike, text: str) -> None:
    """临时文件 + os.replace 原子写入（同一目录保证同分区）。"""
    p = str(path)
    d = os.path.dirname(p)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_json(path: os.PathLike, obj: Any) -> None:
    atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def read_json(path: os.PathLike) -> Any:
    with open(str(path), "r", encoding="utf-8-sig") as f:
        return json.load(f)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()[:16]


def b64decode_text(b64: str) -> str:
    return base64.b64decode(b64.encode("ascii")).decode("utf-8")


class KbLock:
    """<root>/.kb-lock 互斥锁：O_CREAT|O_EXCL 自旋获取；mtime 超 120s 视为崩溃残留可接管。"""

    def __init__(self, root: str):
        self.path = os.path.join(root, LOCK_NAME)
        self.held = False

    def acquire(self) -> None:
        deadline = time.time() + LOCK_TIMEOUT_S
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(json.dumps({"pid": os.getpid(), "at": time.time()}))
                self.held = True
                return
            except FileExistsError:
                try:
                    age = time.time() - os.path.getmtime(self.path)
                except OSError:
                    age = 0.0
                if age > LOCK_STALE_S:
                    # 崩溃残留：接管（先删再下一轮重建，竞态下由 O_EXCL 兜底）
                    try:
                        os.unlink(self.path)
                    except OSError:
                        pass
                    continue
                if time.time() > deadline:
                    raise RuntimeError("获取知识库索引锁超时（.kb-lock 被占用超过 30 秒）")
                time.sleep(0.2)

    def release(self) -> None:
        if self.held:
            self.held = False
            try:
                os.unlink(self.path)
            except OSError:
                pass

    def __enter__(self) -> "KbLock":
        self.acquire()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.release()


# ── 目录布局 ──────────────────────────────────────────────

def root_layout(root: str) -> Dict[str, str]:
    return {"index": os.path.join(root, "projects.json")}


INCOMING_DIR = ".incoming"      # 抓取暂存：分类在归档阶段才产生，fetch 先落这里
DEFAULT_CATEGORY = "未分类"


def sanitize_category(cat: str) -> str:
    """分类目录名：仅保留中文/字母/数字/空格/连字符/下划线；空 → 未分类。"""
    c = re.sub(r"[^\w\u4e00-\u9fff -]", "", str(cat or "")).strip().strip(".")
    return c or DEFAULT_CATEGORY


def idx_entry(idx: Dict[str, Any], pid: str) -> Optional[Dict[str, Any]]:
    return next((p for p in idx.get("projects", []) if str(p.get("projectId", "")).lower() == str(pid).lower()), None)


def final_dir_of(root: str, entry: Optional[Dict[str, Any]]) -> Optional[str]:
    if entry and entry.get("path"):
        return os.path.join(root, str(entry["path"]))
    return None


def load_categories(root: str) -> List[str]:
    """受控分类词表（用户定版 2026-10-26：LLM 只能从列表选，不合适归未分类）。

    <根>/categories.json {"version":1,"categories":[...]}；缺失时用内置种子列表（首次 archive 时自动落盘该文件，用户可直接编辑扩充）。"""
    seed = ["游戏UI工作流", "Agent框架", "AI自动化测试", "AI绘图工具"]
    p = os.path.join(root, "categories.json")
    if not os.path.isfile(p):
        try:
            write_json(p, {"version": 1, "categories": seed})
        except OSError:
            return seed
        return seed
    try:
        cats = read_json(p).get("categories", [])
        return [str(c) for c in cats if str(c).strip()] or seed
    except (OSError, ValueError):
        return seed


def resolve_project_dir(root: str, pid: str) -> Optional[str]:
    """按索引定位项目档案目录（<分类>/<repo>，用户定版 2026-10-26）；找不到 None。"""
    return final_dir_of(root, idx_entry(load_index(root), pid))


def load_index(root: str) -> Dict[str, Any]:
    idx_path = root_layout(root)["index"]
    if not os.path.isfile(idx_path):
        return {"version": 1, "projects": []}
    return read_json(idx_path)


def save_index(root: str, idx: Dict[str, Any]) -> None:
    write_json(root_layout(root)["index"], idx)


# ── 子命令：parse-url ────────────────────────────────────

def parse_one_url(url: str) -> Optional[Dict[str, str]]:
    """解析 GitHub URL → {owner, repo, projectId}；不合法返回 None。

    接受形态：github.com/owner/repo[/...]、带 .git、带尾斜杠、bare owner/repo。
    安全：主机白名单 github.com；段字符集校验（拒绝路径穿越）；拒绝 ../段。
    """
    u = (url or "").strip()
    if not u:
        return None
    u = re.sub(r"^https?://", "", u, flags=re.I)
    u = u.split("?")[0].split("#")[0]  # 去掉 query/fragment（微信转发常带）
    u = re.sub(r"^www\.", "", u, flags=re.I)
    if u.lower().startswith("github.com/"):
        u = u[len("github.com/"):]
    elif "/" in u and "." in u.split("/")[0]:
        # 形如其他主机的 URL（首段含点视为域名）——非 github.com 主机一律拒绝
        return None
    segs = [s for s in u.split("/") if s]
    if len(segs) < 2:
        return None
    owner, repo = segs[0], segs[1]
    if repo.endswith(".git"):
        repo = repo[:-4]
    for seg in (owner, repo):
        if not SEG_RE.match(seg) or len(seg) > 100 or seg in (".", ".."):
            return None
    return {"owner": owner, "repo": repo, "projectId": repo}  # 目录名不带作者前缀（用户定版 2026-10-26）；同仓同名冲突由 repoId 守卫


def cmd_parse_url(args: argparse.Namespace) -> None:
    r = parse_one_url(args.url)
    if r is None:
        out({"ok": False, "issues": ["无法识别的 GitHub 地址（仅支持 github.com/owner/repo 或 owner/repo）: " + (args.url or "")[:120]]})
        return
    out({"ok": True, **r})


# ── 子命令：detect-duplicate ─────────────────────────────

def find_existing(root: str, owner: str, repo: str) -> Optional[Dict[str, Any]]:
    """按 projectId（=repo 名）大小写不敏感查重；返回索引条目，未命中 None。
    同名不同作者由 archive 阶段的 repoId 冲突守卫拦下。"""
    want = repo.lower()
    for p in load_index(root).get("projects", []):
        if str(p.get("projectId", "")).lower() == want:
            return p
    return None


def cmd_detect_duplicate(args: argparse.Namespace) -> None:
    r = parse_one_url(args.url)
    if r is None:
        out({"ok": False, "issues": ["无法识别的 GitHub 地址"]})
        return
    hit = find_existing(args.root, r["owner"], r["repo"])
    if hit is None:
        out({"ok": True, "exists": False, "projectId": r["projectId"]})
    elif str(hit.get("owner", "")).lower() != r["owner"].lower():
        # 同名不同作者：不能当同一项目复用，标记冲突（后续抓取归档时 repoId 守卫拒绝）
        out({
            "ok": True, "exists": False, "nameClash": True, "projectId": r["projectId"],
            "existingOwner": hit.get("owner", ""), "existingRepoId": hit.get("repoId"),
        })
    else:
        out({
            "ok": True, "exists": True, "projectId": hit["projectId"],
            "projectDir": final_dir_of(args.root, hit) or "",
            "status": hit.get("status", ""),
        })


# ── 子命令：fetch ────────────────────────────────────────

class _NoCrossDomainRedirect(urllib.request.HTTPRedirectHandler):
    """拒绝对非 api.github.com 的重定向（4.3 抓取白名单）。"""

    def redirect_request(self, req: Any, fp: Any, code: Any, msg: Any, hdrs: Any, newurl: Any) -> Any:  # noqa: D401
        host = urllib.parse.urlparse(str(newurl)).hostname or ""
        if host.lower() != API_HOST:
            raise urllib.error.URLError("拒绝跨域重定向: " + host)
        return super().redirect_request(req, fp, code, msg, hdrs, newurl)


def http_get_json(path: str) -> Tuple[int, Any]:
    return _http_get(path, accept="application/vnd.github+json", raw=False)


def http_get_raw(path: str) -> Tuple[int, str]:
    return _http_get(path, accept="application/vnd.github.raw", raw=True)


def _http_get(path: str, accept: str, raw: bool) -> Tuple[int, Any]:
    token = os.environ.get("GITHUB_TOKEN", "")
    req = urllib.request.Request(API_BASE + path, headers={
        "Accept": accept,
        "User-Agent": "pi-agentic-workflow/github-kb",
        **({"Authorization": "Bearer " + token} if token else {}),
    })
    opener = urllib.request.build_opener(_NoCrossDomainRedirect)
    try:
        with opener.open(req, timeout=30) as resp:
            data = resp.read()
            text = data.decode("utf-8", errors="replace")
            return resp.status, (text if raw else json.loads(text))
    except urllib.error.HTTPError as e:
        remaining = e.headers.get("X-RateLimit-Remaining", "")
        if e.code in (403, 429) and remaining == "0":
            raise RuntimeError("GitHub API 配额耗尽（X-RateLimit-Remaining: 0）。配置 GITHUB_TOKEN 提额或稍后再试")
        if e.code == 404:
            raise RuntimeError("仓库不存在或为私有仓库（V1 仅支持公开仓库）: " + path)
        raise RuntimeError("GitHub API HTTP %s: %s" % (e.code, path))
    except urllib.error.URLError as e:
        raise RuntimeError("网络错误（%s）: %s" % (getattr(e, "reason", e), path))


def fetch_real(owner: str, repo: str) -> Dict[str, Tuple[int, Any]]:
    """真实抓取四源（仅 api.github.com）。返回 {源: (状态码, 内容)}。"""
    got: Dict[str, Tuple[int, Any]] = {}
    code, repo_j = http_get_json("/repos/%s/%s" % (owner, repo))
    got["repo"] = (code, repo_j)
    code, readme_t = http_get_raw("/repos/%s/%s/readme" % (owner, repo))
    got["readme"] = (code, readme_t)
    code, lang_j = http_get_json("/repos/%s/%s/languages" % (owner, repo))
    got["languages"] = (code, lang_j)
    branch = repo_j.get("default_branch") or "HEAD"
    code, tree_j = http_get_json("/repos/%s/%s/git/trees/%s" % (owner, repo, branch))
    got["tree"] = (code, tree_j)
    return got


def fetch_fixture(fixture_dir: str) -> Dict[str, Tuple[int, Any]]:
    """沙盒抓取：从 fixture 目录读四源样本（零网络）。"""
    got: Dict[str, Tuple[int, Any]] = {}
    for src, name in (("repo", "repo.json"), ("readme", "readme.md"), ("languages", "languages.json"), ("tree", "tree.json")):
        p = os.path.join(fixture_dir, name)
        if not os.path.isfile(p):
            raise RuntimeError("fixture 缺少文件: %s" % p)
        text = open(p, "r", encoding="utf-8").read()
        got[src] = (200, text if src == "readme" else json.loads(text))
    return got


RAW_FILES = {"repo": "repo.json", "readme": "README.md", "languages": "languages.json", "tree": "tree.json"}

# ── README 图片本地化（用户需求 2026-10-26：图片丢失 → 下载到文档同目录 imgs/ 并改写引用） ──

IMG_EXTS = ("png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif")
MAX_IMAGES = 60        # 单仓库图片数上限（超出保留远程 URL）
PER_IMAGE_CAP = 8 * 1024 * 1024   # 单图 8MB
TOTAL_CAP = 50 * 1024 * 1024      # 单仓库总量 50MB
UA = "pi-agentic-workflow/github-kb"

MD_IMG_RE = re.compile(r'!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
HTML_IMG_RE = re.compile(r'<img\s[^>]*?src=["\']([^"\']+)["\']', re.I)


def _safe_img_name(seq: int, url: str) -> str:
    """远程 URL → 安全本地名 imgs/00X-名字.ext（路径/穿越/特殊字符全部消除）。"""
    base = url.split("?")[0].split("#")[0].rstrip("/")
    name = base.rsplit("/", 1)[-1] if "/" in base else base
    name = urllib.parse.unquote(name)
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)[:60].strip("._-") or "image"
    if "." not in name or name.rsplit(".", 1)[-1].lower() not in IMG_EXTS:
        name += ".png"  # 无扩展名/非图片扩展 → 统一 .png（content-type 已校验为图）
    return "%03d-%s" % (seq, name)


def _resolve_img_url(url: str, owner: str, repo: str, branch: str) -> Optional[str]:
    """图片引用 → 可下载绝对 URL；不可处理（data:/协议相对/已是本地）返回 None。"""
    u = url.strip()
    if u.startswith("data:") or u.startswith("imgs/") or u.startswith("./imgs/"):
        return None
    if u.startswith("//"):
        return "https:" + u
    if u.lower().startswith("https://"):
        return u
    if u.lower().startswith("http://"):
        return "https:" + u[len("http:"):]
    if u.lower().startswith("https:/") or u.startswith("/"):
        # 仓库绝对路径 /docs/x.png → raw.githubusercontent
        rel = u.lstrip("/")
        return "https://raw.githubusercontent.com/%s/%s/%s/%s" % (owner, repo, branch, rel)
    if "://" not in u and not u.startswith("mailto:"):
        # 仓库相对路径 docs/x.png 或 ./docs/x.png → raw.githubusercontent
        rel = u.lstrip("./")
        if ".." in rel.split("/"):
            return None
        return "https://raw.githubusercontent.com/%s/%s/%s/%s" % (owner, repo, branch, rel)
    return None


def _http_download(url: str, cap: int) -> Tuple[Optional[bytes], str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/*,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            data = resp.read(cap + 1)
    except Exception as e:  # noqa: BLE001 单图失败不影响整体
        return None, "网络错误: %s" % str(e)[:80]
    if len(data) > cap:
        return None, "超过单图大小上限"
    if ctype and not (ctype.startswith("image/") or ctype in ("application/octet-stream", "binary/octet-stream")):
        return None, "非图片 Content-Type: " + ctype
    if not data:
        return None, "空内容"
    return data, ""


def download_readme_images(raw_dir: str, owner: str, repo: str, branch: str,
                            fixture_dir: str = "") -> Dict[str, Any]:
    """把 raw/README.md 里的远程图片下载到 raw/imgs/ 并把引用改写为本地相对路径。

    幂等：已改写为 imgs/ 的引用不再处理；单图失败/超限保留原远程 URL（README 可读性优先）。
    fixture 模式：仓库相对路径从 fixture 目录拷贝，绝对 URL 跳过（零网络）。
    返回 {downloaded, failed, skipped, rewritten, imgsDir}。"""
    md_path = os.path.join(raw_dir, "README.md")
    if not os.path.isfile(md_path):
        return {"ok": False, "issues": ["README.md 不存在"]}
    text = open(md_path, encoding="utf-8", errors="replace").read()
    urls: List[str] = []
    for m in MD_IMG_RE.finditer(text):
        if m.group(1) not in urls:
            urls.append(m.group(1))
    for m in HTML_IMG_RE.finditer(text):
        if m.group(1) not in urls:
            urls.append(m.group(1))
    if not urls:
        return {"ok": True, "downloaded": 0, "failed": 0, "skipped": 0, "rewritten": 0, "imgsDir": ""}

    imgs_dir = os.path.join(raw_dir, "imgs")
    os.makedirs(imgs_dir, exist_ok=True)
    mapping: Dict[str, str] = {}  # 远程 URL → 本地相对引用（imgs/ 前缀，与 README 同目录）
    stats = {"ok": True, "downloaded": 0, "failed": 0, "skipped": 0, "rewritten": 0, "imgsDir": imgs_dir}
    total = 0
    for seq, url in enumerate(urls, start=1):
        local = _safe_img_name(seq, url)
        dest = os.path.join(imgs_dir, local)
        ref = "imgs/" + local
        # 幂等：已下载过的直接复用并参与改写
        if os.path.isfile(dest):
            stats["downloaded"] += 1
            mapping[url] = ref
            continue
        if url.startswith("data:") or url.startswith("imgs/") or url.startswith("./imgs/"):
            stats["skipped"] += 1
            continue
        if seq > MAX_IMAGES or total >= TOTAL_CAP:
            stats["skipped"] += 1
            continue
        if fixture_dir:
            # fixture 零网络：仓库相对路径从 fixture 目录拷贝；绝对 URL 跳过保留远程引用
            rel = url if ("://" not in url and not url.startswith("//")) else ""
            if rel:
                src = os.path.normpath(os.path.join(fixture_dir, rel.lstrip("./")))
                if os.path.isfile(src) and os.path.abspath(src).startswith(os.path.abspath(fixture_dir) + os.sep):
                    shutil.copyfile(src, dest)
                    stats["downloaded"] += 1
                    mapping[url] = ref
                    continue
            stats["skipped"] += 1
            continue
        abs_url = _resolve_img_url(url, owner, repo, branch)
        if abs_url is None:
            stats["skipped"] += 1
            continue
        data, err = _http_download(abs_url, PER_IMAGE_CAP)
        if data is None:
            stats["failed"] += 1
            continue
        atomic_write_bytes(dest, data)
        total += len(data)
        stats["downloaded"] += 1
        mapping[url] = ref

    if mapping:
        def repl_md(m: "re.Match") -> str:
            u = m.group(1)
            return m.group(0).replace("(" + u + ")", "(" + mapping[u] + ")", 1) if u in mapping else m.group(0)

        new_text = MD_IMG_RE.sub(repl_md, text)

        def repl_html(m: "re.Match") -> str:
            u = m.group(1)
            return m.group(0).replace(u, mapping[u], 1) if u in mapping else m.group(0)

        new_text = HTML_IMG_RE.sub(repl_html, new_text)
        if new_text != text:
            atomic_write(md_path, new_text)
            stats["rewritten"] = len(mapping)
    return stats


def atomic_write_bytes(path: str, data: bytes) -> None:
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=d)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def cmd_fetch(args: argparse.Namespace) -> None:
    r = parse_one_url(args.url)
    if r is None:
        out({"ok": False, "issues": ["无法识别的 GitHub 地址"]})
        return
    owner, repo, pid = r["owner"], r["repo"], r["projectId"]

    # 目标目录：已有档案且非 force → 原目录续传（T-B）；否则先进 .incoming（分类归档时才定，用户定版 2026-10-26）
    final = resolve_project_dir(args.root, pid)
    if final and not args.force and os.path.isdir(os.path.join(final, "raw")):
        target = final
    else:
        target = os.path.join(args.root, INCOMING_DIR, pid)
        os.makedirs(os.path.join(target, "raw"), exist_ok=True)

    manifest_path = os.path.join(target, "raw", "fetch-manifest.json")
    manifest: Dict[str, Any] = {"version": 1, "sources": {}}
    if os.path.isfile(manifest_path):
        try:
            manifest = read_json(manifest_path)
        except (OSError, ValueError):
            manifest = {"version": 1, "sources": {}}

    fetched: List[str] = []
    skipped: List[str] = []
    try:
        # 逐源判定：manifest ok 且文件在 → 跳过（T-B：只补缺失/失败源）；否则抓取
        need = [s for s in SOURCES
                if args.force or not (manifest.get("sources", {}).get(s, {}).get("status") == "ok"
                                      and os.path.isfile(os.path.join(target, "raw", RAW_FILES[s])))]
        data: Dict[str, Tuple[int, Any]] = {}
        if need:
            data = fetch_fixture(args.fixture) if args.fixture else fetch_real(owner, repo)
        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        for src in SOURCES:
            fname = os.path.join(target, "raw", RAW_FILES[src])
            if src not in need:
                skipped.append(src)
                continue
            code, content = data[src]
            atomic_write(fname, content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, indent=2) + "\n")
            manifest.setdefault("sources", {})[src] = {
                "status": "ok", "fetchedAt": now, "sha256": sha256_file(fname),
                "httpStatus": code, "source": "fixture" if args.fixture else "api",
            }
            fetched.append(src)
        manifest["complete"] = all(
            manifest.get("sources", {}).get(s, {}).get("status") == "ok" and os.path.isfile(os.path.join(target, "raw", RAW_FILES[s]))
            for s in SOURCES)
        # README 图片本地化（尽力而为：失败保留远程 URL，不影响 complete）
        img_stats: Dict[str, Any] = {}
        if "readme" in fetched:
            try:
                repo_j = json.loads(open(os.path.join(target, "raw", "repo.json"), encoding="utf-8").read()) \
                    if os.path.isfile(os.path.join(target, "raw", "repo.json")) else {}
                branch = repo_j.get("default_branch") or "HEAD"
                img_stats = download_readme_images(
                    os.path.join(target, "raw"), owner, repo, branch,
                    fixture_dir=args.fixture or "")
                manifest.setdefault("sources", {}).setdefault("readme", {})["images"] = {
                    k: img_stats.get(k, 0) for k in ("downloaded", "failed", "skipped", "rewritten")}
            except (OSError, ValueError, RuntimeError) as e:
                img_stats = {"ok": False, "issues": [str(e)]}
        write_json(manifest_path, manifest)
    except RuntimeError as e:
        # 失败也要把已成功源写回 manifest（T-B：中断可续）
        manifest["complete"] = False
        try:
            write_json(manifest_path, manifest)
        except OSError:
            pass
        out({"ok": False, "issues": [str(e)], "projectDir": target, "fetched": fetched, "skipped": skipped})
        return

    out({
        "ok": True, "projectId": pid, "projectDir": target,
        "fetched": fetched, "skipped": skipped, "complete": manifest["complete"],
        "staging": bool(final and target != final),
        "images": {k: img_stats.get(k, 0) for k in ("downloaded", "failed", "skipped", "rewritten")} if img_stats else {},
    })


# ── 子命令：download-images（已有档案补图/重试失败图） ──

def cmd_download_images(args: argparse.Namespace) -> None:
    root, iss = resolve_kb_root(args.root)
    if root is None:
        out({"ok": False, "issues": iss})
        return
    pdir = resolve_project_dir(root, args.project_id)
    if not pdir:
        out({"ok": False, "issues": ["项目档案不存在: " + args.project_id]})
        return
    raw_dir = os.path.join(pdir, "raw")
    try:
        repo_j = read_json(os.path.join(raw_dir, "repo.json"))
    except (OSError, ValueError):
        out({"ok": False, "issues": ["项目档案 raw/repo.json 不存在: " + args.project_id]})
        return
    branch = repo_j.get("default_branch") or "HEAD"
    stats = download_readme_images(raw_dir, str(repo_j.get("owner", {}).get("login", "")),
                                   str(repo_j.get("name", "")), branch,
                                   fixture_dir=args.fixture or "")
    if stats.get("ok") and (stats.get("downloaded") or stats.get("rewritten")):
        mf_path = os.path.join(raw_dir, "fetch-manifest.json")
        try:
            mf = read_json(mf_path)
            mf.setdefault("sources", {}).setdefault("readme", {})["images"] = {
                k: stats.get(k, 0) for k in ("downloaded", "failed", "skipped", "rewritten")}
            write_json(mf_path, mf)
        except (OSError, ValueError):
            pass
    stats["projectDir"] = pdir
    out(stats)


# ── 校验（3.4 / 3.4.1） ──────────────────────────────────

def verify_analysis(analysis_md: str, evidence: Dict[str, Any]) -> List[str]:
    issues: List[str] = []
    heads = re.findall(r"^##\s+(.+?)\s*$", analysis_md, flags=re.M)
    for sec in SECTIONS:
        if sec not in heads:
            issues.append("analysis 缺少段落: ## " + sec)
    # 每段须非空：标题后到下一标题间 >= 20 字符
    for sec in SECTIONS:
        m = re.search(r"^##\s+" + re.escape(sec) + r"\s*$(.*?)(?=^##\s|\Z)", analysis_md, flags=re.M | re.S)
        if m and len(re.sub(r"\s", "", m.group(1))) < 20:
            issues.append("analysis 段落内容过短: " + sec)
    claims = evidence.get("claims", [])
    if not isinstance(claims, list) or len(claims) < 5:
        issues.append("evidence 条目不足（要求 ≥5 条功能/性能/技术能力类断言），当前: %d" % len(claims if isinstance(claims, list) else []))
        claims = claims if isinstance(claims, list) else []
    claim_text = " ".join(str(c.get("claim", "")) for c in claims if isinstance(c, dict))
    for i, c in enumerate(claims):
        if not isinstance(c, dict):
            issues.append("evidence[%d] 不是对象" % i)
            continue
        if c.get("evidenceLevel") not in EVIDENCE_LEVELS:
            issues.append("evidence[%d] 证据等级非法: %r（允许 %s）" % (i, c.get("evidenceLevel"), "/".join(EVIDENCE_LEVELS)))
        if not str(c.get("claim", "")).strip():
            issues.append("evidence[%d] 缺少 claim" % i)
    # 百分号数字启发式：亮点/风险/核心能力段中的数字+% 必须能命中某条 claim（宁误拦）
    for sec in ("核心能力", "亮点与差异化", "风险与局限"):
        m = re.search(r"^##\s+" + re.escape(sec) + r"\s*$(.*?)(?=^##\s|\Z)", analysis_md, flags=re.M | re.S)
        if not m:
            continue
        for num in PERCENT_RE.findall(m.group(1)):
            if num not in claim_text:
                issues.append("段「%s」含无证据数字 %s（未在 evidence claims 中登记），请补证据或删除断言" % (sec, num))
                break
    return issues


PROJECT_MD = "project.md"  # 项目元数据（YAML frontmatter 保存详细 GitHub 配置，用户定版 2026-10-26；Obsidian 友好）


def _yaml_scalar(v: Any) -> str:
    """受限子集 YAML 标量：bool/数字裸写，字符串 JSON 双引号转义（往返一致）。"""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if v is None or v == "":
        return '""'
    return json.dumps(str(v), ensure_ascii=False)


def _parse_yaml_val(s: str) -> Any:
    if s.startswith('"') and s.endswith('"') and len(s) >= 2:
        try:
            return json.loads(s)
        except ValueError:
            return s[1:-1]
    if s == "true":
        return True
    if s == "false":
        return False
    if re.match(r"^-?\d+$", s):
        return int(s)
    if re.match(r"^-?\d+\.\d+$", s):
        return float(s)
    return s


def write_project_md(path: str, data: Dict[str, Any]) -> None:
    """项目档案元数据 project.md：YAML frontmatter（详细 GitHub 配置）+ 可读正文（Obsidian 友好）。

    frontmatter 为受限子集（顶层标量 + 字符串列表），由 load_project_md 读回。
    """
    lines = ["---"]
    for k, v in data.items():
        if isinstance(v, list):
            if v:
                lines.append(str(k) + ":")
                for item in v:
                    lines.append("  - " + _yaml_scalar(item))
            else:
                lines.append(str(k) + ": []")
        else:
            lines.append(str(k) + ": " + _yaml_scalar(v))
    lines.append("---")
    lines.append("")
    lines.append("# %s" % data.get("repo", data.get("projectId", "")))
    lines.append("")
    lines.append("> %s" % (data.get("description") or ""))
    lines.append("")
    lines.append("- 仓库: %s" % data.get("htmlUrl", ""))
    lines.append("- 作者: %s · Stars: %s · License: %s" % (data.get("owner", ""), data.get("stars", ""), data.get("license") or "无"))
    lines.append("- 分类: %s · 标签: %s" % (data.get("category", ""), ", ".join(data.get("tags") or [])))
    lines.append("- 首次归档: %s · 最近研究: %s · 状态: %s" % (data.get("firstArchived", ""), data.get("lastResearched", ""), data.get("status", "")))
    lines.append("")
    lines.append("详细配置见上方 frontmatter；分析见 [analysis.md](analysis.md)；证据 [evidence.json](evidence.json)；原始抓取 raw/（README 图片已本地化到 raw/imgs/）。")
    atomic_write(path, "\n".join(lines) + "\n")


def load_project_md(path: str) -> Dict[str, Any]:
    """读回 project.md 的 frontmatter（--- 包裹的受限 YAML 子集）。"""
    text = open(path, encoding="utf-8-sig").read()
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    block = text[4:end] if text[3] == "\n" else text[3:end]
    data: Dict[str, Any] = {}
    key: Optional[str] = None
    for line in block.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_]+):\s*(.*)$", line)
        if m and not line.startswith((" ", "\t")):
            key, val = m.group(1), m.group(2).strip()
            data[key] = [] if val == "" else _parse_yaml_val(val)
        elif line.startswith("  - ") and key is not None and isinstance(data.get(key), list):
            data[key].append(_parse_yaml_val(line[4:].strip()))
    return data


def build_project_json_from(workdir: str, pid: str, meta: Dict[str, Any]) -> Dict[str, Any]:
    """从指定目录（正式或 staging）的 raw 组装项目元数据（写入 project.yaml，3.3 契约）。"""
    repo_j = read_json(os.path.join(workdir, "raw", "repo.json"))
    tree_j = read_json(os.path.join(workdir, "raw", "tree.json"))
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    lic = (repo_j.get("license") or {}).get("spdx_id") if isinstance(repo_j.get("license"), dict) else None
    return {
        "projectId": pid,
        "owner": repo_j.get("owner", {}).get("login", ""),
        "repo": repo_j.get("name", ""),
        "repoId": repo_j.get("id"),
        "htmlUrl": repo_j.get("html_url", ""),
        "description": repo_j.get("description") or "",
        "stars": repo_j.get("stargazers_count", 0),
        "treeSha": tree_j.get("sha", ""),  # 抓取时默认分支树 SHA（变更检测用；V1 不额外请求 commit SHA）
        "license": lic or "",
        "archived": bool(repo_j.get("archived", False)),
        "pushedAt": repo_j.get("pushed_at", ""),
        "tags": meta.get("tags", []),
        "category": meta.get("category", ""),
        "useScenes": meta.get("useScenes", []),
        "firstArchived": now,
        "lastResearched": now,
        "status": "researched",
    }


def cmd_archive(args: argparse.Namespace) -> None:
    pid = args.project_id
    root = args.root
    workdir = args.staging or ""
    # 未显式给 workdir：按索引定位（复用/续传场景）；否则用 .incoming
    if not workdir:
        entry0 = idx_entry(load_index(root), pid)
        if entry0 and entry0.get("path"):
            workdir = final_dir_of(root, entry0)
        else:
            workdir = os.path.join(root, INCOMING_DIR, pid)

    if not os.path.isfile(os.path.join(workdir, "raw", "fetch-manifest.json")):
        out({"ok": False, "issues": ["目标目录缺少 raw/fetch-manifest.json（先执行 fetch）: " + workdir]})
        return
    if not read_json(os.path.join(workdir, "raw", "fetch-manifest.json")).get("complete"):
        out({"ok": False, "issues": ["抓取不完整（fetch-manifest complete=false），先补齐缺失源再归档"]})
        return

    try:
        analysis_md = b64decode_text(args.analysis_b64)
        evidence = json.loads(b64decode_text(args.evidence_b64))
        meta = json.loads(b64decode_text(args.meta_b64)) if args.meta_b64 else {}
    except (ValueError, UnicodeDecodeError) as e:
        out({"ok": False, "issues": ["analysis/evidence/meta 解码或 JSON 解析失败: %s" % e]})
        return

    issues = verify_analysis(analysis_md, evidence)
    if issues:
        # 校验失败：不动任何目录（.incoming 的 raw 保留供重试，正式档案分毫未动，T-C）
        out({"ok": False, "issues": ["归档校验失败"] + issues})
        return

    pj = build_project_json_from(workdir, pid, meta)
    # 最终目录：<分类>/<repo>；分类受控于 categories.json 词表（不在列表 → 未分类）
    cats = load_categories(root)
    want_cat = sanitize_category(meta.get("category", ""))
    category = want_cat if want_cat in cats else DEFAULT_CATEGORY
    pj["category"] = category
    cat_note = [] if category == want_cat or want_cat == DEFAULT_CATEGORY else ["提示: 分类「" + want_cat + "」不在受控列表，已归「" + DEFAULT_CATEGORY + "」；可编辑 categories.json 或 recategorize 改派"]
    final = os.path.join(root, category, pid)
    bak = final + ".bak"

    with KbLock(root):
        idx = load_index(root)
        entry = idx_entry(idx, pid)
        # 守卫：同名仓库但 repoId 不一致（不同作者的相同 repo 名）——明确报错不静默合并
        if (entry is not None and entry.get("repoId") is not None and pj.get("repoId") is not None
                and entry.get("repoId") != pj.get("repoId")):
            out({"ok": False, "issues": [
                "仓库名冲突: %s 已收录 %s/%s (repoId=%s)，新请求 %s/%s (repoId=%s)；同名不同仓库，请用 owner/repo 全称确认目标" % (
                    pid, entry.get("owner", ""), entry.get("repo", ""), entry.get("repoId"),
                    pj.get("owner", ""), pj.get("repo", ""), pj.get("repoId"))]})
            return
        # 仓库改名/迁移：repoId 命中旧条目 → 旧目录移除，条目改指新档案（articles 关联保留，3.3.1）
        if entry is None and pj.get("repoId") is not None:
            same = next((p for p in idx.get("projects", []) if p.get("repoId") == pj.get("repoId")), None)
            if same is not None:
                old_dir = final_dir_of(root, same)
                if old_dir and os.path.isdir(old_dir) and os.path.normpath(old_dir) != os.path.normpath(final):
                    shutil.rmtree(old_dir, ignore_errors=True)
                same["projectId"] = pid
                entry = same
        if entry is None:
            entry = {"projectId": pid, "articles": []}
            idx.setdefault("projects", []).append(entry)

        # 档案文件写入 workdir（incoming 场景随后整体移动到分类目录）
        atomic_write(os.path.join(workdir, "analysis.md"), analysis_md if analysis_md.endswith("\n") else analysis_md + "\n")
        write_json(os.path.join(workdir, "evidence.json"), evidence)
        write_project_md(os.path.join(workdir, PROJECT_MD), pj)

        # 崩溃恢复：上次 swap 中断（final 被挪去 .bak 后进程死）→ 先还原
        if not os.path.isdir(final) and os.path.isdir(bak):
            os.rename(bak, final)

        if os.path.normpath(workdir) != os.path.normpath(final):
            os.makedirs(os.path.dirname(final), exist_ok=True)
            if os.path.isdir(final):
                os.rename(final, bak)
            shutil.move(workdir, final)
            if os.path.isdir(bak):
                shutil.rmtree(bak, ignore_errors=True)

        first_archived = entry.get("firstArchived")
        entry.update({k: v for k, v in pj.items() if k != "articles"})
        entry["path"] = category + "/" + pid
        if first_archived:
            entry["firstArchived"] = first_archived  # 重研究不重置首次归档时间
        save_index(root, idx)
        # articles.json 派生镜像（权威源 projects.json，3.3.1）
        write_json(os.path.join(final, "articles.json"), {"projectId": pid, "articles": entry.get("articles", [])})

    out({"ok": True, "projectId": pid, "projectDir": final, "category": category, "status": "researched", "issues": cat_note})


# ── 子命令：locate ───────────────────────────────────────

def cmd_locate(args: argparse.Namespace) -> None:
    pid = args.project_id
    if not pid and args.url:
        r = parse_one_url(args.url)
        if r is None:
            out({"ok": False, "issues": ["无法识别的 GitHub 地址"]})
            return
        pid = r["projectId"]
    pdir = resolve_project_dir(args.root, pid)
    if not pdir or not os.path.isdir(pdir):
        out({"ok": False, "issues": ["项目档案不存在: %s（先执行 github-research）" % pid]})
        return
    issues: List[str] = []
    analysis_ready = False
    ap = os.path.join(pdir, "analysis.md")
    evp = os.path.join(pdir, "evidence.json")
    if os.path.isfile(ap) and os.path.isfile(evp):
        vs = verify_analysis(open(ap, encoding="utf-8").read(), read_json(evp))
        if vs:
            issues = ["档案校验未通过: " + "; ".join(vs[:3])]
        else:
            analysis_ready = True
    else:
        issues.append("档案不完整（缺 analysis.md 或 evidence.json）")
    out({"ok": analysis_ready, "projectId": pid, "projectDir": pdir, "analysisReady": analysis_ready, "issues": issues})


# ── 子命令：register-article ─────────────────────────────

def cmd_register_article(args: argparse.Namespace) -> None:
    root, pid = args.root, args.project_id
    pdir = resolve_project_dir(root, pid)
    if not pdir or not os.path.isfile(os.path.join(pdir, PROJECT_MD)):
        out({"ok": False, "issues": ["项目档案不存在: " + pid]})
        return
    with KbLock(root):
        idx = load_index(root)
        entry = idx_entry(idx, pid)
        if entry is None:
            entry = {"projectId": pid, "articles": []}
            idx.setdefault("projects", []).append(entry)
        arts = entry.setdefault("articles", [])
        if any(a.get("articleId") == args.article_id for a in arts):
            out({"ok": True, "alreadyRegistered": True, "articleId": args.article_id})
            return
        arts.append({
            "articleId": args.article_id,
            "angle": args.angle,
            "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "articleDir": args.article_dir,
        })
        save_index(root, idx)
        write_json(os.path.join(pdir, "articles.json"), {"projectId": pid, "articles": arts})
    out({"ok": True, "alreadyRegistered": False, "articleId": args.article_id})


# ── 子命令：rebuild-index ────────────────────────────────

def cmd_rebuild_index(args: argparse.Namespace) -> None:
    root = args.root
    if not os.path.isdir(root):
        out({"ok": False, "issues": ["知识库目录不存在: " + root]})
        return
    entries: List[Dict[str, Any]] = []
    # 布局：<分类>/<repo>（用户定版 2026-10-26）；跳过索引文件/隐藏目录/.incoming
    for cat in sorted(os.listdir(root)):
        cat_dir = os.path.join(root, cat)
        if not os.path.isdir(cat_dir) or cat.startswith(".") or cat == INCOMING_DIR:
            continue
        for name in sorted(os.listdir(cat_dir)):
            pdir = os.path.join(cat_dir, name)
            md_path = os.path.join(pdir, PROJECT_MD)
            if not os.path.isfile(md_path):
                continue
            try:
                pj = load_project_md(md_path)
            except (OSError, ValueError):
                continue
            arts = []
            ap = os.path.join(pdir, "articles.json")
            if os.path.isfile(ap):
                try:
                    arts = read_json(ap).get("articles", [])
                except (OSError, ValueError):
                    arts = []
            pj["articles"] = arts
            pj["path"] = cat + "/" + name
            entries.append(pj)
    with KbLock(root):
        save_index(root, {"version": 1, "projects": entries})
    out({"ok": True, "rebuilt": len(entries)})


# ── 子命令：resolve-root / read-raw（workflow 编排用） ──

KB_REL = ("70_KnowlegeBase", "01_Github")  # 知识库在 vault 内的缺省相对落点（用户定版 2026-10-26）


def resolve_kb_root(explicit: str, from_dir: str = "") -> Tuple[Optional[str], List[str]]:
    """知识库根解析顺序（执行方案 3.1）：显式 --root → 环境变量 GITHUB_KB_ROOT →
    .aws-article/config.json 的 github_knowledge_root → 从 article_workspace 向上找
    vault 级 70_KnowlegeBase/01_Github（60_Workspace 与 70_KnowlegeBase 是 vault 同级目录）。"""
    issues: List[str] = []
    if explicit:
        return explicit, issues
    env = os.environ.get("GITHUB_KB_ROOT", "")
    if env:
        return env, issues
    # 从 from_dir（缺省脚本位置）向上找工作区配置（与 check_state.py 的 find_config_root 同思路）
    d = os.path.abspath(from_dir) if from_dir else os.path.dirname(os.path.abspath(__file__))
    for _ in range(8):
        cfg = os.path.join(d, ".aws-article", "config.json")
        if os.path.isfile(cfg):
            try:
                c = read_json(cfg)
                k = str(c.get("github_knowledge_root") or "")
                if k:
                    return k, issues
                aw = str(c.get("article_workspace") or "")
                if aw:
                    kb = _find_kb_under(os.path.abspath(aw))
                    if kb is not None:
                        return kb, ["提示: 未配置 github_knowledge_root，回退 vault 落点 " + kb]
                    return None, issues + [
                        "未配置 github_knowledge_root，且从 article_workspace 向上未找到 70_KnowlegeBase"
                        "（请在 vault 根创建 %s/%s，或配置显式路径）" % KB_REL]
            except (OSError, ValueError) as e:
                issues.append("config.json 解析失败: %s" % e)
            break
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None, issues + ["未配置知识库根：传 --kb-root/--root，或设 GITHUB_KB_ROOT，或在 .aws-article/config.json 配 github_knowledge_root"]


def _find_kb_under(start: str) -> Optional[str]:
    """从 start 逐级向上，找包含 70_KnowlegeBase 的祖先目录；返回 …/70_KnowlegeBase/01_Github。

    找到 70_KnowlegeBase 而 01_Github 不存在时自动创建（目录名拼接过 gitignore 不受影响）。
    未找到任何 70_KnowlegeBase 返回 None（不凭空发明 vault 根）。"""
    d = start
    for _ in range(10):
        kb_parent = os.path.join(d, KB_REL[0])
        if os.path.isdir(kb_parent):
            root = os.path.join(kb_parent, KB_REL[1])
            os.makedirs(root, exist_ok=True)
            return root
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent
    return None


def cmd_list_categories(args: argparse.Namespace) -> None:
    root, iss = resolve_kb_root(args.root)
    if root is None:
        out({"ok": False, "issues": iss})
        return
    out({"ok": True, "root": root, "categories": load_categories(root)})


def cmd_add_category(args: argparse.Namespace) -> None:
    """新增受控分类（去重追加 categories.json；缺失则按种子落盘后追加）。

    用于：用户预指定分类（github-research --category）或批准 AI 建议的新分类时自动调用。
    """
    root, iss = resolve_kb_root(args.root)
    if root is None:
        out({"ok": False, "issues": iss})
        return
    name = sanitize_category(args.name)
    if name == DEFAULT_CATEGORY:
        out({"ok": False, "issues": ["分类名非法（保留字「未分类」）"]})
        return
    p = os.path.join(root, "categories.json")
    cats = load_categories(root)
    if name in cats:
        out({"ok": True, "alreadyExists": True, "category": name, "categories": cats})
        return
    cats.append(name)
    write_json(p, {"version": 1, "categories": cats})
    out({"ok": True, "alreadyExists": False, "category": name, "categories": cats})


def cmd_recategorize(args: argparse.Namespace) -> None:
    """人工改派分类：移动 <旧分类>/<repo> → <新分类>/<repo>，同步 project.md 与索引。

    用于修正 LLM 分类不准（如 game-ui-design-workflow 应归 游戏UI工作流）；
    新分类名做目录消毒；不在受控列表时提示可加入 categories.json 但不阻断。
    """
    root, iss = resolve_kb_root(args.root)
    if root is None:
        out({"ok": False, "issues": iss})
        return
    pid = args.project_id
    with KbLock(root):
        idx = load_index(root)
        entry = idx_entry(idx, pid)
        pdir = final_dir_of(root, entry) if entry else None
        if not pdir or not os.path.isdir(pdir):
            out({"ok": False, "issues": ["项目档案不存在: " + pid]})
            return
        category = sanitize_category(args.category)
        final = os.path.join(root, category, pid)
        if os.path.normpath(final) == os.path.normpath(pdir):
            out({"ok": True, "projectId": pid, "projectDir": final, "category": category, "moved": False})
            return
        if os.path.isdir(final):
            out({"ok": False, "issues": ["目标目录已存在: " + final + "（同名冲突，拒绝覆盖）"]})
            return
        # project.md: 改 category 后回写
        md_path = os.path.join(pdir, PROJECT_MD)
        pj = load_project_md(md_path)
        pj["category"] = category
        write_project_md(md_path, pj)
        # 目录移动 + 索引/path 同步
        os.makedirs(os.path.dirname(final), exist_ok=True)
        shutil.move(pdir, final)
        entry["path"] = category + "/" + pid
        entry["category"] = category
        save_index(root, idx)
    cats = load_categories(root)
    hints = [] if category in cats else ["提示: 分类「%s」不在 categories.json，可按需追加" % category]
    # 旧分类目录空了顺手清理
    old_parent = os.path.dirname(pdir)
    try:
        if os.path.isdir(old_parent) and not os.listdir(old_parent):
            os.rmdir(old_parent)
    except OSError:
        pass
    out({"ok": True, "projectId": pid, "projectDir": final, "category": category, "moved": True, "issues": hints})


def cmd_resolve_root(args: argparse.Namespace) -> None:
    root, issues = resolve_kb_root(args.root, args.from_dir)
    if root is None:
        out({"ok": False, "issues": issues})
        return
    out({"ok": True, "root": root, "issues": issues})


def cmd_read_raw(args: argparse.Namespace) -> None:
    root, iss = resolve_kb_root(args.root)
    if root is None:
        out({"ok": False, "issues": iss})
        return
    pid = args.project_id
    workdir = args.staging or resolve_project_dir(root, pid) or os.path.join(root, INCOMING_DIR, pid)
    try:
        repo_j = read_json(os.path.join(workdir, "raw", "repo.json"))
        langs = read_json(os.path.join(workdir, "raw", "languages.json"))
        tree_j = read_json(os.path.join(workdir, "raw", "tree.json"))
        readme = open(os.path.join(workdir, "raw", "README.md"), encoding="utf-8", errors="replace").read()
    except (OSError, ValueError) as e:
        out({"ok": False, "issues": ["读取 raw 失败: %s" % e]})
        return
    truncated = False
    limit = args.max_chars
    if len(readme) > limit:
        head, tail = readme[: int(limit * 0.8)], readme[-int(limit * 0.2):]
        readme = head + "\n...（中间截断）...\n" + tail
        truncated = True
    top_files = ", ".join(t.get("path", "") for t in (tree_j.get("tree") or [])[:40])
    out({
        "ok": True, "projectDir": workdir,
        "repo": {
            "fullName": repo_j.get("full_name", ""), "description": repo_j.get("description") or "",
            "stars": repo_j.get("stargazers_count", 0), "license": (repo_j.get("license") or {}).get("spdx_id", "") if isinstance(repo_j.get("license"), dict) else "",
            "defaultBranch": repo_j.get("default_branch", ""), "pushedAt": repo_j.get("pushed_at", ""),
            "topics": repo_j.get("topics", []), "homepage": repo_j.get("homepage", ""),
        },
        "readme": readme, "readmeTruncated": truncated,
        "languages": langs, "topFiles": top_files,
    })


# ── CLI ──────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="GitHub 知识库确定性操作（零 LLM）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("resolve-root")
    p.add_argument("--root", default="")
    p.add_argument("--from", dest="from_dir", default="", help="config 搜索起点目录（缺省脚本位置；测试用）")
    p.set_defaults(fn=cmd_resolve_root)

    p = sub.add_parser("read-raw")
    p.add_argument("--root", default="")
    p.add_argument("--project-id", required=True)
    p.add_argument("--staging", default="")
    p.add_argument("--max-chars", type=int, default=20000)
    p.set_defaults(fn=cmd_read_raw)

    p = sub.add_parser("parse-url")
    p.add_argument("--url", required=True)
    p.set_defaults(fn=cmd_parse_url)

    p = sub.add_parser("detect-duplicate")
    p.add_argument("--root", required=True)
    p.add_argument("--url", required=True)
    p.set_defaults(fn=cmd_detect_duplicate)

    p = sub.add_parser("fetch")
    p.add_argument("--root", required=True)
    p.add_argument("--url", required=True)
    p.add_argument("--fixture", default="")
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_fetch)

    p = sub.add_parser("list-categories")
    p.add_argument("--root", default="")
    p.set_defaults(fn=cmd_list_categories)

    p = sub.add_parser("add-category")
    p.add_argument("--root", default="")
    p.add_argument("--name", required=True)
    p.set_defaults(fn=cmd_add_category)

    p = sub.add_parser("recategorize")
    p.add_argument("--root", default="")
    p.add_argument("--project-id", required=True)
    p.add_argument("--category", required=True)
    p.set_defaults(fn=cmd_recategorize)

    p = sub.add_parser("download-images")
    p.add_argument("--root", default="")
    p.add_argument("--project-id", required=True)
    p.add_argument("--fixture", default="")
    p.set_defaults(fn=cmd_download_images)

    p = sub.add_parser("archive")
    p.add_argument("--root", required=True)
    p.add_argument("--project-id", required=True)
    p.add_argument("--analysis-b64", required=True)
    p.add_argument("--evidence-b64", required=True)
    p.add_argument("--meta-b64", default="")
    p.add_argument("--staging", default="")
    p.set_defaults(fn=cmd_archive)

    p = sub.add_parser("locate")
    p.add_argument("--root", required=True)
    p.add_argument("--project-id", default="")
    p.add_argument("--url", default="")
    p.set_defaults(fn=cmd_locate)

    p = sub.add_parser("register-article")
    p.add_argument("--root", required=True)
    p.add_argument("--project-id", required=True)
    p.add_argument("--article-id", required=True)
    p.add_argument("--angle", required=True)
    p.add_argument("--article-dir", required=True)
    p.set_defaults(fn=cmd_register_article)

    p = sub.add_parser("rebuild-index")
    p.add_argument("--root", required=True)
    p.set_defaults(fn=cmd_rebuild_index)

    args = ap.parse_args()
    try:
        args.fn(args)
    except RuntimeError as e:
        out({"ok": False, "issues": [str(e)]})
    except Exception as e:  # noqa: BLE001  崩溃也输出 JSON（stdout 契约，不向 stderr 吐 traceback 乱码）
        out({"ok": False, "issues": ["%s: %s" % (type(e).__name__, e)]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
