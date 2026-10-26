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
    return {
        "index": os.path.join(root, "projects.json"),
        "projects": os.path.join(root, "projects"),
    }


def project_dir(root: str, project_id: str) -> str:
    return os.path.join(root, "projects", project_id)


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
    return {"owner": owner, "repo": repo, "projectId": owner + "__" + repo}


def cmd_parse_url(args: argparse.Namespace) -> None:
    r = parse_one_url(args.url)
    if r is None:
        out({"ok": False, "issues": ["无法识别的 GitHub 地址（仅支持 github.com/owner/repo 或 owner/repo）: " + (args.url or "")[:120]]})
        return
    out({"ok": True, **r})


# ── 子命令：detect-duplicate ─────────────────────────────

def find_existing(root: str, owner: str, repo: str) -> Optional[Dict[str, Any]]:
    """按 owner__repo 大小写不敏感查重；返回索引条目（含 projectId），未命中 None。"""
    want = (owner + "__" + repo).lower()
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
    else:
        out({
            "ok": True, "exists": True, "projectId": hit["projectId"],
            "projectDir": project_dir(args.root, hit["projectId"]),
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


def cmd_fetch(args: argparse.Namespace) -> None:
    r = parse_one_url(args.url)
    if r is None:
        out({"ok": False, "issues": ["无法识别的 GitHub 地址"]})
        return
    owner, repo, pid = r["owner"], r["repo"], r["projectId"]

    # 目标目录：force 更新走暂存目录（4.1：完整构建新版本，验证通过才替换）
    if args.force and os.path.isdir(project_dir(args.root, pid)):
        target = os.path.join(args.root, "projects", ".staging-%s-%d" % (pid, int(time.time())))
        os.makedirs(os.path.join(target, "raw"), exist_ok=True)
    else:
        target = project_dir(args.root, pid)
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
        "staging": bool(args.force and target != project_dir(args.root, pid)),
    })


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


def build_project_json_from(workdir: str, pid: str, meta: Dict[str, Any]) -> Dict[str, Any]:
    """从指定目录（正式或 staging）的 raw 组装 project.json 内容（camelCase，3.3 契约）。"""
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


def articles_of(idx: Dict[str, Any], pid: str) -> List[Dict[str, Any]]:
    for p in idx.get("projects", []):
        if p.get("projectId") == pid:
            return p.setdefault("articles", [])
    return []


def cmd_archive(args: argparse.Namespace) -> None:
    pid = args.project_id
    root = args.root
    pdir = project_dir(root, pid)
    workdir = args.staging or pdir

    # staging 内 raw 从真实项目目录软引用不可靠——要求 staging 自带完整 raw（fetch --force 已写入）
    issues: List[str] = []
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
        # 校验失败：staging 整目录清除，原档案分毫未动（T-C）
        if args.staging:
            shutil.rmtree(args.staging, ignore_errors=True)
        out({"ok": False, "issues": ["归档校验失败"] + issues, "stagingRemoved": bool(args.staging)})
        return

    # 崩溃恢复：上次 swap 中断（目录被挪去 .bak 后进程死）→ 先还原
    bak = pdir + ".bak"
    if not os.path.isdir(pdir) and os.path.isdir(bak):
        os.rename(bak, pdir)

    # 档案文件统一写入 workdir（staging 场景 = 暂存目录，验证通过后整体 swap）
    pj = build_project_json_from(workdir, pid, meta)
    atomic_write(os.path.join(workdir, "analysis.md"), analysis_md if analysis_md.endswith("\n") else analysis_md + "\n")
    write_json(os.path.join(workdir, "evidence.json"), evidence)
    write_json(os.path.join(workdir, "project.json"), pj)

    # force 暂存替换：旧 → .bak → staging → 正式 → 删 .bak（4.1）
    # 同路径（rename 场景 fetch 未走 staging）时跳过 swap，只做原地归档
    if args.staging and os.path.realpath(args.staging) != os.path.realpath(pdir):
        if os.path.isdir(pdir):
            os.rename(pdir, bak)
        os.rename(args.staging, pdir)
        if os.path.isdir(bak):
            shutil.rmtree(bak, ignore_errors=True)

    with KbLock(root):
        # 索引更新（保留已有 articles 关联；repoId 二次匹配防改名重复建档，3.3.1）
        idx = load_index(root)
        entry = next((p for p in idx.get("projects", []) if p.get("projectId") == pid), None)
        if entry is None and pj.get("repoId") is not None:
            same = next((p for p in idx.get("projects", []) if p.get("repoId") == pj.get("repoId")), None)
            if same is not None:
                # 仓库改名/迁移：档案目录以新 projectId 为准，旧目录移除，条目改指新档案（articles 关联保留）
                old_dir = project_dir(root, same["projectId"])
                if os.path.isdir(old_dir) and old_dir != pdir:
                    shutil.rmtree(old_dir, ignore_errors=True)
                same["projectId"] = pid
                entry = same
        if entry is None:
            entry = {"projectId": pid, "articles": []}
            idx.setdefault("projects", []).append(entry)
        first_archived = entry.get("firstArchived")
        entry.update({k: v for k, v in pj.items() if k != "articles"})
        if first_archived:
            entry["firstArchived"] = first_archived  # 重研究不重置首次归档时间
        save_index(root, idx)
        # articles.json 派生镜像（权威源 projects.json，3.3.1）
        write_json(os.path.join(pdir, "articles.json"), {"projectId": pid, "articles": entry.get("articles", [])})

    out({"ok": True, "projectId": pid, "projectDir": pdir, "status": "researched"})


# ── 子命令：locate ───────────────────────────────────────

def cmd_locate(args: argparse.Namespace) -> None:
    pid = args.project_id
    if not pid and args.url:
        r = parse_one_url(args.url)
        if r is None:
            out({"ok": False, "issues": ["无法识别的 GitHub 地址"]})
            return
        pid = r["projectId"]
    pdir = project_dir(args.root, pid)
    if not os.path.isdir(pdir):
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
    pdir = project_dir(root, pid)
    if not os.path.isfile(os.path.join(pdir, "project.json")):
        out({"ok": False, "issues": ["项目档案不存在: " + pid]})
        return
    with KbLock(root):
        idx = load_index(root)
        entry = next((p for p in idx.get("projects", []) if p.get("projectId") == pid), None)
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
    proot = root_layout(root)["projects"]
    if not os.path.isdir(proot):
        out({"ok": False, "issues": ["知识库目录不存在: " + proot]})
        return
    entries: List[Dict[str, Any]] = []
    for name in sorted(os.listdir(proot)):
        if name.startswith("."):
            continue
        pdir = os.path.join(proot, name)
        pj_path = os.path.join(pdir, "project.json")
        if not os.path.isfile(pj_path):
            continue
        try:
            pj = read_json(pj_path)
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
    workdir = args.staging or project_dir(root, pid)
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
