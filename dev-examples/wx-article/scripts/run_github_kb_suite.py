#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""github_kb.py 测试套件——P0 验收（执行方案 V1.1 十一节 + 评审用例 T-A/T-B/T-C/T-D）。

布局契约（用户定版 2026-10-26）：<知识库根>/<分类>/<repo 名>/（无 owner 前缀），
元数据 project.md（YAML frontmatter），抓取暂存 .incoming/<repo>/。
逐用例输出 PASS/FAIL/SKIP，结尾汇总计数。fixture 沙盒零网络；真实网络冒烟单列。

用法：
  python run_github_kb_suite.py [--kb SCRIPT] [--skip-network]
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KB = os.path.join(HERE, "github_kb.py")
FIXTURE = os.path.join(HERE, "fixtures", "github", "demo-repo")
EVIL_FIXTURE = os.path.join(HERE, "fixtures", "github", "evil-readme")

RESULTS = []

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, HERE)  # 复用 kb 的 frontmatter 解析器做断言


def run(*cli_args):
    """运行 github_kb.py 子命令，返回解析后的 JSON（崩溃时返回 {ok:False, issues:[...]}）。"""
    p = subprocess.run([sys.executable, KB] + list(cli_args),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    try:
        return json.loads(p.stdout)
    except ValueError:
        return {"ok": False, "issues": ["bad_output: " + (p.stdout or p.stderr)[:200]]}


def case(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print("[%s] %s%s" % ("PASS" if ok else "FAIL", name, (" — " + detail) if detail else ""))


ANALYSIS = """# demo-repo 项目研究档案

## 一句话定位
一个基于配置文件的轻量任务编排工具，主打失败重试与超时控制的自动化场景覆盖。

## 核心能力
- 基于配置文件定义任务流程
- 支持失败重试与超时控制
- 提供 CLI 与 HTTP 两种触发方式
- 测试覆盖率达 87%

## 技术架构与依赖
以 Python 为主（约 21000 行），辅以 Shell 与 JavaScript；配置驱动，入口为 CLI 命令。

## 适用场景与目标用户
批量数据处理、定时任务编排、轻量 CI 流水线；适合个人开发者与小团队。

## 亮点与差异化
配置即流程，测试覆盖率 87%（CI 报告），双触发方式（CLI/HTTP）开箱可用。

## 风险与局限
生态较新，star 数不高（42），社区规模待观察。

## 推荐角度建议
- recommend：面向效率工具读者的入门推荐（配置即流程的直观卖点）
- compare：与 cron/Make/轻量 CI 的对比评测
"""

META = {"tags": ["自动化", "任务编排"], "category": "游戏UI工作流", "useScenes": ["批量处理", "定时编排"]}


def evidence_ok():
    return {
        "version": 1,
        "claims": [
            {"claim": "基于配置文件定义任务流程", "source": "README.md", "reference": "", "evidenceLevel": "documented"},
            {"claim": "支持失败重试与超时控制", "source": "README.md", "reference": "", "evidenceLevel": "documented"},
            {"claim": "提供 CLI 与 HTTP 两种触发方式", "source": "README.md", "reference": "", "evidenceLevel": "documented"},
            {"claim": "测试覆盖率达 87%", "source": "README.md", "reference": "", "evidenceLevel": "documented"},
            {"claim": "以 Python 为主（约 21000 行）", "source": "languages.json", "reference": "", "evidenceLevel": "code_inspected"},
            {"claim": "定位为轻量任务编排", "source": "README.md", "reference": "", "evidenceLevel": "inferred"},
        ],
    }


def b64(text):
    import base64
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def archive_args(pid, analysis=None, ev=None, meta=None, staging=""):
    a = ["archive", "--root", ROOT, "--project-id", pid,
         "--analysis-b64", b64(analysis if analysis is not None else ANALYSIS),
         "--evidence-b64", b64(json.dumps(ev if ev is not None else evidence_ok()))]
    if meta is not None:
        a += ["--meta-b64", b64(json.dumps(meta))]
    if staging:
        a += ["--staging", staging]
    return a


ROOT = ""


def main():
    global KB, ROOT
    ap = argparse.ArgumentParser()
    ap.add_argument("--kb", default=KB)
    ap.add_argument("--skip-network", action="store_true")
    args = ap.parse_args()
    KB = args.kb

    tmp = tempfile.mkdtemp(prefix="gh-kb-suite-")
    root = os.path.join(tmp, "kb")
    os.makedirs(root)
    ROOT = root
    url = "https://github.com/example/demo-repo"
    pid = "demo-repo"                                   # 无 owner 前缀
    incoming = os.path.join(root, ".incoming", pid)     # 抓取暂存
    pdir = os.path.join(root, "游戏UI工作流", pid)        # 归档后（受控分类，meta.category=游戏UI工作流）

    try:
        # ── 1. URL 解析 ──
        r = run("parse-url", "--url", url)
        case("URL 解析: 标准形态", r.get("ok") and r.get("projectId") == pid, json.dumps(r, ensure_ascii=False)[:120])
        r = run("parse-url", "--url", "https://github.com/example/demo-repo/tree/main/docs?tab=readme")
        case("URL 解析: 子路径与 query", r.get("ok") and r.get("projectId") == pid, json.dumps(r, ensure_ascii=False)[:120])
        r = run("parse-url", "--url", "git@github.com:example/demo-repo.git")
        case("URL 解析: ssh 形态拒绝（V1 仅 https/裸路径）", not r.get("ok"))
        r = run("parse-url", "--url", "https://gitlab.com/example/demo-repo")
        case("URL 解析: 非 github 主机拒绝", not r.get("ok"))
        r = run("parse-url", "--url", "https://github.com/../etc/passwd")
        case("URL 解析: 穿越段拒绝", not r.get("ok"))

        # ── 2. fixture 抓取（先进 .incoming） ──
        r = run("fetch", "--root", root, "--url", url, "--fixture", FIXTURE)
        case("fixture 抓取: 四源完整落 .incoming", r.get("ok") and r.get("complete") and len(r.get("fetched", [])) == 4
             and os.path.isfile(os.path.join(incoming, "raw", "fetch-manifest.json")),
             json.dumps(r, ensure_ascii=False)[:160])

        # ── T-B: 抓取中断续传 ──
        os.unlink(os.path.join(incoming, "raw", "README.md"))
        mf_path = os.path.join(incoming, "raw", "fetch-manifest.json")
        mf = json.load(open(mf_path, encoding="utf-8"))
        mf["sources"]["readme"]["status"] = "failed"
        mf["complete"] = False
        json.dump(mf, open(mf_path, "w", encoding="utf-8"))
        r = run("fetch", "--root", root, "--url", url, "--fixture", FIXTURE)
        case("T-B 中断续传: 只补 readme", r.get("ok") and r.get("fetched") == ["readme"]
             and r.get("skipped") == ["repo", "languages", "tree"], json.dumps(r, ensure_ascii=False)[:160])

        # ── 2b. README 图片本地化 ──
        r = run("fetch", "--root", os.path.join(tmp, "kb-img"), "--url", url, "--fixture", FIXTURE)
        img_raw = os.path.join(tmp, "kb-img", ".incoming", pid, "raw")
        case("图片本地化: 相对路径图下载到 imgs/",
             r.get("ok") and r.get("images", {}).get("downloaded", 0) >= 1
             and os.path.isfile(os.path.join(img_raw, "imgs", "001-arch.png")),
             json.dumps(r.get("images", {}), ensure_ascii=False))
        rd = open(os.path.join(img_raw, "README.md"), encoding="utf-8").read()
        case("图片本地化: 引用改写为本地相对路径",
             "![架构图](imgs/001-arch.png)" in rd and "docs/arch.png" not in rd)
        case("图片本地化: 绝对 URL 保留远程引用",
             "https://example-cdn.example.com/banner.png" in rd)
        r2 = run("download-images", "--root", os.path.join(tmp, "kb-img"), "--project-id", pid, "--fixture", FIXTURE)
        case("download-images: 未归档项目明确报错（索引无此档案）", not r2.get("ok"))

        # ── 2c. 图片本地化总时间预算（慢滴流防拖死：单图 socket 超时挡不住限速慢传） ──
        # 单图 2.5s 慢下载×4 图，预算 1s：第 1 图在预算内启动，其余全部跳过且快速返回；
        # 预算需在 env 现读（_image_budget_s），monkeypatch _http_download 不碰网络。
        import github_kb as gkb
        import time as _time
        os.environ["GITHUB_KB_IMG_BUDGET_S"] = "1"
        orig_dl = gkb._http_download
        def _slow_download(url, cap):
            _time.sleep(2.5)
            return b"PNGDATA", ""
        gkb._http_download = _slow_download
        try:
            budget_raw = os.path.join(tmp, "kb-budget", "raw")
            os.makedirs(budget_raw, exist_ok=True)
            with open(os.path.join(budget_raw, "README.md"), "w", encoding="utf-8") as f:
                f.write("# t\n" + "\n".join(
                    "![i%d](https://img.example.com/slow-%d.png)" % (i, i) for i in range(4)))
            t0 = _time.monotonic()
            bstats = gkb.download_readme_images(budget_raw, "o", "r", "main")
            bdt = _time.monotonic() - t0
            case("图片预算: 超预算剩余图跳过且快速收敛",
                 bstats.get("downloaded") == 1 and bstats.get("skipped") == 3 and bdt < 6,
                 "stats=%s dt=%.1fs" % (json.dumps({k: bstats.get(k) for k in ("downloaded", "failed", "skipped", "rewritten")}), bdt))
        finally:
            gkb._http_download = orig_dl
            del os.environ["GITHUB_KB_IMG_BUDGET_S"]

        # ── 2d. 单图下载墙钟上限（慢滴流：每块都在读但整体无限拖长） ──
        # 真实网络下 raw.githubusercontent 被限速 ~3KB/s 时，socket timeout=30 只限单次阻塞读，
        # 持续慢传可无限拖长；墙钟上限需分块读逐块检查。monkeypatch urlopen 模拟慢滴流。
        os.environ["GITHUB_KB_IMG_PER_IMAGE_S"] = "1"
        orig_urlopen = gkb.urllib.request.urlopen
        class _TrickleResp:
            def __init__(self, *a, **k):
                self.headers = {}
            def read(self, n=-1):
                _time.sleep(0.4)
                return b"X" * 1024  # 每块 1KB，永不 EOF → 只能靠墙钟截止
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
        def _trickle_urlopen(req, timeout=30):
            return _TrickleResp()
        gkb.urllib.request.urlopen = _trickle_urlopen
        try:
            wall_raw = os.path.join(tmp, "kb-wall", "raw")
            os.makedirs(wall_raw, exist_ok=True)
            with open(os.path.join(wall_raw, "README.md"), "w", encoding="utf-8") as f:
                f.write("# t\n![slow](https://img.example.com/trickle.png)")
            t0 = _time.monotonic()
            wstats = gkb.download_readme_images(wall_raw, "o", "r", "main")
            wdt = _time.monotonic() - t0
            case("单图墙钟: 慢滴流被墙钟截止且标记 failed",
                 wstats.get("failed") == 1 and wdt < 6,
                 "stats=%s dt=%.1fs" % (json.dumps({k: wstats.get(k) for k in ("downloaded", "failed", "skipped")}), wdt))
        finally:
            gkb.urllib.request.urlopen = orig_urlopen
            del os.environ["GITHUB_KB_IMG_PER_IMAGE_S"]

        # ── 3. 查重（归档前不存在） ──
        r = run("detect-duplicate", "--root", root, "--url", "https://github.com/EXAMPLE/DEMO-REPO")
        case("查重: 尚未归档时不存在", r.get("ok") and not r.get("exists"))

        # ── 4. 归档校验 ──
        bad = ANALYSIS.replace("## 风险与局限\n", "")
        r = run(*archive_args(pid, analysis=bad))
        case("归档校验: 缺段拒绝", not r.get("ok") and any("风险与局限" in i for i in r.get("issues", [])))
        case("归档校验失败: .incoming raw 保留（重试不重抓）",
             os.path.isfile(os.path.join(incoming, "raw", "repo.json")))
        ev = evidence_ok()
        ev["claims"] = ev["claims"][:3]
        r = run(*archive_args(pid, ev=ev))
        case("归档校验: 证据不足拒绝", not r.get("ok") and any("证据" in i or "evidence" in i for i in r.get("issues", [])))
        no_ev_num = ANALYSIS.replace("87", "99.9")
        r = run(*archive_args(pid, analysis=no_ev_num))
        case("归档校验: 无证据百分号拒绝", not r.get("ok") and any("99.9" in i for i in r.get("issues", [])))

        # ── 5. 合法归档：落分类目录 + project.md ──
        r = run(*archive_args(pid, meta=META))
        case("归档: 落分类目录 <分类>/<repo>", r.get("ok") and os.path.normcase(r.get("projectDir", "")) == os.path.normcase(pdir)
             and r.get("category") == "游戏UI工作流", json.dumps(r, ensure_ascii=False)[:140])
        case("归档: .incoming 已清空", not os.path.exists(incoming))
        case("归档: project.md 存在", os.path.isfile(os.path.join(pdir, "project.md")))

        import github_kb
        md = github_kb.load_project_md(os.path.join(pdir, "project.md"))
        case("project.md: frontmatter 解析（repoId/category/tags 类型正确）",
             md.get("projectId") == pid and md.get("repoId") == 100200300 and md.get("category") == "游戏UI工作流"
             and md.get("tags") == META["tags"] and md.get("archived") is False and md.get("stars") == 42,
             json.dumps({k: md.get(k) for k in ("projectId", "repoId", "category", "tags", "archived", "stars")}, ensure_ascii=False))
        # ── 5b. 受控分类列表 + recategorize ──
        r = run("list-categories", "--root", root)
        case("受控分类: 种子词表可读", r.get("ok") and "游戏UI工作流" in r.get("categories", [])
             and os.path.isfile(os.path.join(root, "categories.json")))
        bad_root = os.path.join(tmp, "kb-badcat")
        os.makedirs(bad_root)
        run("fetch", "--root", bad_root, "--url", url, "--fixture", FIXTURE)
        rb = run("archive", "--root", bad_root, "--project-id", pid,
                 "--analysis-b64", b64(ANALYSIS), "--evidence-b64", b64(json.dumps(evidence_ok())),
                 "--meta-b64", b64(json.dumps({"category": "乱七八糟不存在分类"})))
        case("受控分类: 列表外分类归未分类并提示", rb.get("ok") and rb.get("category") == "未分类"
             and os.path.isdir(os.path.join(bad_root, "未分类", pid))
             and any("受控列表" in i for i in rb.get("issues", [])))
        r = run("recategorize", "--root", bad_root, "--project-id", pid, "--category", "游戏UI工作流")
        md2 = github_kb.load_project_md(os.path.join(bad_root, "游戏UI工作流", pid, "project.md"))
        idx2 = json.load(open(os.path.join(bad_root, "projects.json"), encoding="utf-8"))
        case("recategorize: 目录移动+frontmatter+索引同步",
             r.get("ok") and md2.get("category") == "游戏UI工作流"
             and idx2["projects"][0]["path"] == "游戏UI工作流/demo-repo"
             and not os.path.isdir(os.path.join(bad_root, "未分类", pid))
             and not os.path.isdir(os.path.join(bad_root, "未分类")))
        r2 = run("recategorize", "--root", bad_root, "--project-id", pid, "--category", "游戏UI工作流")
        case("recategorize: 幂等（同分类零移动）", r2.get("ok") and r2.get("moved") is False)
        # ── 5c. add-category（用户预指定/批准建议时自动追加词表） ──
        r = run("add-category", "--root", bad_root, "--name", "前端组件库")
        r2 = run("add-category", "--root", bad_root, "--name", "前端组件库")
        r3 = run("add-category", "--root", bad_root, "--name", "未分类")
        case("add-category: 追加与去重", r.get("ok") and not r.get("alreadyExists")
             and "前端组件库" in r.get("categories", []))
        case("add-category: 重复追加幂等", r2.get("ok") and r2.get("alreadyExists"))
        case("add-category: 保留字拒绝", not r3.get("ok"))
        r = run("recategorize", "--root", bad_root, "--project-id", pid, "--category", "前端组件库")
        case("recategorize: 词表内新分类改派", r.get("ok") and r.get("moved") is True)
        idx = json.load(open(os.path.join(root, "projects.json"), encoding="utf-8"))
        ent = idx["projects"][0]
        case("归档: 索引字段完整（含 path）",
             all(k in ent for k in ("repoId", "treeSha", "license", "archived", "pushedAt", "tags", "category", "path"))
             and ent["path"] == "游戏UI工作流/demo-repo")
        case("归档: 索引 owner/repo 保留完整身份", ent.get("owner") == "example" and ent.get("repo") == "demo-repo")

        r = run("detect-duplicate", "--root", root, "--url", "https://github.com/EXAMPLE/DEMO-REPO")
        case("查重: 归档后命中（repo 名大小写不敏感）", r.get("ok") and r.get("exists") and r.get("projectId") == pid)
        r = run("locate", "--root", root, "--project-id", pid)
        case("定位: analysisReady", r.get("ok") and r.get("analysisReady")
             and os.path.normcase(r.get("projectDir", "")) == os.path.normcase(pdir))

        # ── 6. 同名冲突守卫（不同作者同名仓库） ──
        clash = os.path.join(tmp, "kb-clash")
        os.makedirs(clash)
        run("fetch", "--root", clash, "--url", url, "--fixture", FIXTURE)
        ROOT = clash
        run(*archive_args(pid, meta=META))  # 首次归档成功（repoId 100200300）
        # 同名不同作者：detect-duplicate 报 nameClash 不误报复用
        r = run("detect-duplicate", "--root", clash, "--url", "https://github.com/other-owner/demo-repo")
        case("同名冲突: 查重报 nameClash 不误报 exists",
             r.get("ok") and not r.get("exists") and r.get("nameClash") and r.get("existingOwner") == "example")
        # force 重抓 → 篡改 repoId 模拟另一作者 → 归档被 repoId 守卫拒绝
        r = run("fetch", "--root", clash, "--url", "https://github.com/other-owner/demo-repo", "--fixture", FIXTURE, "--force")
        staging = r.get("projectDir", "")
        rj = json.load(open(os.path.join(staging, "raw", "repo.json"), encoding="utf-8"))
        rj["id"] = 987654321
        rj["owner"]["login"] = "other-owner"
        json.dump(rj, open(os.path.join(staging, "raw", "repo.json"), "w", encoding="utf-8"))
        r = run(*archive_args(pid, meta=META, staging=staging))
        case("同名冲突守卫: repoId 不一致拒绝且原档案完好",
             not r.get("ok") and any("冲突" in i for i in r.get("issues", []))
             and os.path.isfile(os.path.join(clash, "游戏UI工作流", pid, "project.md")),
             json.dumps(r.get("issues", []), ensure_ascii=False)[:160])
        ROOT = root

        # ── 7. register-article 幂等 + 一对多 ──
        r1 = run("register-article", "--root", root, "--project-id", pid, "--article-id", "gh20261026-demorepo-recommend",
                 "--angle", "recommend", "--article-dir", "E:/tmp/demo-repo-推荐")
        r2 = run("register-article", "--root", root, "--project-id", pid, "--article-id", "gh20261026-demorepo-recommend",
                 "--angle", "recommend", "--article-dir", "E:/tmp/demo-repo-推荐")
        case("关联登记: 幂等", r1.get("ok") and r2.get("ok") and r2.get("alreadyRegistered"))
        r3 = run("register-article", "--root", root, "--project-id", pid, "--article-id", "gh20261026-demorepo-compare",
                 "--angle", "compare", "--article-dir", "E:/tmp/demo-repo-对比")
        idx = json.load(open(os.path.join(root, "projects.json"), encoding="utf-8"))
        case("T-E 一对多: 同项目两篇文章", r3.get("ok") and len(idx["projects"][0]["articles"]) == 2)
        mirror = json.load(open(os.path.join(pdir, "articles.json"), encoding="utf-8"))
        case("关联镜像: articles.json 同步", len(mirror["articles"]) == 2)

        # ── 8. force 更新（.incoming 暂存 → 替换分类目录） ──
        old_analysis = open(os.path.join(pdir, "analysis.md"), encoding="utf-8").read()
        r = run("fetch", "--root", root, "--url", url, "--fixture", FIXTURE, "--force")
        case("force 抓取: 进 .incoming", r.get("ok") and r.get("staging"), json.dumps(r, ensure_ascii=False)[:160])
        staging = r.get("projectDir", "")
        bad2 = ANALYSIS.replace("## 推荐角度建议", "## 推荐角度（改名）")
        r = run(*archive_args(pid, analysis=bad2, meta=META, staging=staging))
        now_analysis = open(os.path.join(pdir, "analysis.md"), encoding="utf-8").read()
        case("T-C force 失败: 原档案完好", not r.get("ok") and now_analysis == old_analysis)
        idx = json.load(open(os.path.join(root, "projects.json"), encoding="utf-8"))
        case("T-C force 失败: 关联不丢", len(idx["projects"][0]["articles"]) == 2)

        fa = idx["projects"][0].get("firstArchived")
        r = run("fetch", "--root", root, "--url", url, "--fixture", FIXTURE, "--force")
        r2 = run(*archive_args(pid, analysis=ANALYSIS + "\n（force 更新版）", meta=META, staging=r.get("projectDir", "")))
        idx = json.load(open(os.path.join(root, "projects.json"), encoding="utf-8"))
        case("force 成功: 替换且保留关联与 firstArchived",
             r2.get("ok") and len(idx["projects"][0]["articles"]) == 2
             and idx["projects"][0].get("firstArchived") == fa
             and "force 更新版" in open(os.path.join(pdir, "analysis.md"), encoding="utf-8").read())

        # ── 9. rebuild-index 崩溃恢复 ──
        os.unlink(os.path.join(root, "projects.json"))
        r = run("rebuild-index", "--root", root)
        idx = json.load(open(os.path.join(root, "projects.json"), encoding="utf-8"))
        case("rebuild-index: 无损重建（含 path）", r.get("ok") and len(idx["projects"]) == 1
             and len(idx["projects"][0]["articles"]) == 2 and idx["projects"][0]["path"] == "游戏UI工作流/demo-repo")

        # ── 10. 仓库改名迁移（repoId 匹配） ──
        root2 = os.path.join(tmp, "kb2")
        os.makedirs(root2)
        run("fetch", "--root", root2, "--url", "https://github.com/example/demo-repo", "--fixture", FIXTURE)
        ROOT = root2
        run(*archive_args(pid, meta=META))
        run("register-article", "--root", root2, "--project-id", pid,
            "--article-id", "gh20261026-x", "--angle", "recommend", "--article-dir", "E:/tmp/x")
        # 同 repoId 新 owner/repo 名 → 归档时 repoId 二次匹配合并
        r = run("fetch", "--root", root2, "--url", "https://github.com/example2/demo-renamed", "--fixture", FIXTURE)
        r = run(*archive_args("demo-renamed", meta=META, staging=r.get("projectDir", "")))
        idx = json.load(open(os.path.join(root2, "projects.json"), encoding="utf-8"))
        pids = [p["projectId"] for p in idx["projects"]]
        arts = idx["projects"][0].get("articles", []) if idx["projects"] else []
        case("改名迁移: repoId 命中合并且关联保留",
             r.get("ok") and pids == ["demo-renamed"] and len(arts) == 1
             and idx["projects"][0]["path"] == "游戏UI工作流/demo-renamed",
             json.dumps({"pids": pids, "path": idx["projects"][0].get("path")}, ensure_ascii=False))
        case("改名迁移: 旧目录已清理", not os.path.isdir(os.path.join(root2, "游戏UI工作流", "demo-repo")))
        ROOT = root

        # ── 11. resolve-root 回退链（70_KnowlegeBase/01_Github） ──
        vault = os.path.join(tmp, "vault")
        ws = os.path.join(vault, "60_Workspace", "写作", "单篇")
        os.makedirs(os.path.join(ws, ".aws-article"))
        json.dump({"article_workspace": ws}, open(os.path.join(ws, ".aws-article", "config.json"), "w", encoding="utf-8"))
        os.makedirs(os.path.join(vault, "70_KnowlegeBase"))
        r = run("resolve-root", "--from", ws)
        want = os.path.join(vault, "70_KnowlegeBase", "01_Github")
        case("resolve-root 回退: vault 级 70_KnowlegeBase/01_Github",
             r.get("ok") and os.path.normcase(r.get("root", "")) == os.path.normcase(want)
             and os.path.isdir(want), json.dumps(r, ensure_ascii=False)[:120])
        json.dump({"article_workspace": ws, "github_knowledge_root": os.path.join(tmp, "explicit-kb")},
                  open(os.path.join(ws, ".aws-article", "config.json"), "w", encoding="utf-8"))
        r = run("resolve-root", "--from", ws)
        case("resolve-root 优先级: 显式 github_knowledge_root 胜出",
             r.get("ok") and os.path.normcase(r.get("root", "")) == os.path.normcase(os.path.join(tmp, "explicit-kb")))
        vault2 = os.path.join(tmp, "vault2")
        ws2 = os.path.join(vault2, "60_Workspace", "单篇")
        os.makedirs(os.path.join(ws2, ".aws-article"))
        json.dump({"article_workspace": ws2}, open(os.path.join(ws2, ".aws-article", "config.json"), "w", encoding="utf-8"))
        r = run("resolve-root", "--from", ws2)
        case("resolve-root 回退: 无 70_KnowlegeBase 时明确报错", not r.get("ok"))

        # ── P1: plan-article 幂等与 force 另一篇（T-E kb 层） ──
        r = run("plan-article", "--root", root, "--project-id", pid, "--angle", "recommend")
        case("T-E plan-article: 同角度幂等返回已有", r.get("ok") and r.get("exists")
             and r.get("articleId") == "gh20261026-demorepo-recommend", json.dumps(r, ensure_ascii=False)[:140])
        r2 = run("plan-article", "--root", root, "--project-id", pid, "--angle", "deep")
        case("T-E plan-article: 新角度新 id", r2.get("ok") and not r2.get("exists") and r2["articleId"] != r["articleId"])
        r3 = run("plan-article", "--root", root, "--project-id", pid, "--angle", "recommend", "--force")
        case("T-E plan-article: force 另一篇（id 唯一）", r3.get("ok") and not r3.get("exists")
             and r3["articleId"] != r["articleId"] and r3["articleId"] != r2["articleId"])
        r4 = run("plan-article", "--root", root, "--project-id", "no-such", "--angle", "recommend")
        case("plan-article: 未研究项目拒绝", not r4.get("ok"))

        # ── P1: article-write 三件套 + check_state 兼容（T-F） ──
        ws_t = os.path.join(tmp, "ws")
        adir = os.path.join(ws_t, "测试推荐文")
        MD = "# 测试推荐文\n\n正文。" * 1 + "\n" * 1 + ("这是一段足够长的正文内容，用来通过长度相关校验。" * 30) + "\n"
        YML = "title: 测试推荐文\nauthor: AI奇点\ndigest: 一句话摘要测试。\ncontent_source: 测试推荐文.md\n"
        r = run("article-write", "--dir", adir, "--md-name", "测试推荐文.md",
                "--md-b64", b64(MD), "--yaml-b64", b64(YML),
                "--advice-b64", b64("# 配图建议\n封面: 抽象科技感"), "--review-b64", b64("# 审稿记录\npass"))
        case("article-write: 三件套落盘", r.get("ok") and all(os.path.isfile(os.path.join(adir, f)) for f in ("测试推荐文.md", "article.yaml", "配图建议.md", "审稿.md")))
        r = run("article-write", "--dir", adir, "--md-b64", b64(MD), "--yaml-b64", b64(YML))
        case("article-write: 已存在目录拒绝（O_EXCL）", not r.get("ok"))
        # T-F: check_state 只读复检——缺封面 → article_ready（不裸 ok）
        cs = subprocess.run([sys.executable, os.path.join(HERE, "draft_manager", "check_state.py"), "--article-dir", adir],
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        csj = json.loads(cs.stdout)
        case("T-F check_state: 结构合规且报缺封面（article_ready 语义）",
             csj.get("ok") and csj.get("prepare_ready") is False and csj.get("cover", {}).get("state") == "none"
             and any("封面" in i for i in csj.get("issues", [])),
             json.dumps({k: csj.get(k) for k in ("ok", "prepare_ready", "issues")}, ensure_ascii=False)[:160])
        # 加封面后 → prepare_ready
        import base64 as _b64
        open(os.path.join(adir, "cover.png"), "wb").write(_b64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))
        cs2 = subprocess.run([sys.executable, os.path.join(HERE, "draft_manager", "check_state.py"), "--article-dir", adir],
                             capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        cs2j = json.loads(cs2.stdout)
        case("T-F check_state: 封面就绪后 prepare_ready", cs2j.get("ok") and cs2j.get("prepare_ready") is True)
        # resolve-workspace
        r = run("resolve-workspace", "--workspace", "E:/tmp/ws")
        case("resolve-workspace: 显式参数直通", r.get("ok") and r.get("workspace") == "E:/tmp/ws")

        # ── T-A: 并发归档不丢索引 ──
        root3 = os.path.join(tmp, "kb3")
        os.makedirs(root3)
        procs = []
        for i, name in enumerate(("projA", "projB")):
            pd_ = os.path.join(root3, ".incoming", name, "raw")
            os.makedirs(pd_, exist_ok=True)
            for fn in ("repo.json", "README.md", "languages.json", "tree.json"):
                shutil.copy(os.path.join(FIXTURE, fn), os.path.join(pd_, fn))
            # 两个不同仓库必须用不同 repoId（否则被 repoId 改名合并逻辑正确合并）
            rj = json.load(open(os.path.join(pd_, "repo.json"), encoding="utf-8"))
            rj["id"] = 100200300 + i
            rj["name"] = name
            json.dump(rj, open(os.path.join(pd_, "repo.json"), "w", encoding="utf-8"), ensure_ascii=False)
            mf = {"version": 1, "sources": {s: {"status": "ok", "fetchedAt": "t", "sha256": "x"} for s in ("repo", "readme", "languages", "tree")}, "complete": True}
            json.dump(mf, open(os.path.join(pd_, "fetch-manifest.json"), "w", encoding="utf-8"))
            ana = ANALYSIS.replace("demo-repo", name)
            procs.append(subprocess.Popen(
                [sys.executable, KB, "archive", "--root", root3, "--project-id", name,
                 "--analysis-b64", b64(ana), "--evidence-b64", b64(json.dumps(evidence_ok()))],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        for p in procs:
            p.wait(timeout=60)
        idx = json.load(open(os.path.join(root3, "projects.json"), encoding="utf-8"))
        names = sorted(p["projectId"] for p in idx["projects"])
        case("T-A 并发归档: 索引两条都在（未分类目录）", names == ["projA", "projB"]
             and os.path.isdir(os.path.join(root3, "未分类", "projA"))
             and os.path.isdir(os.path.join(root3, "未分类", "projB")), json.dumps(names))

        # ── T-D: 恶意 README（kb 层） ──
        r = run("fetch", "--root", root3, "--url", "https://github.com/example/prompt-inject-demo", "--fixture", EVIL_FIXTURE)
        evil_pid = "prompt-inject-demo"
        evil_dir = os.path.join(root3, ".incoming", evil_pid)
        raw_readme = open(os.path.join(evil_dir, "raw", "README.md"), encoding="utf-8").read() if r.get("ok") else ""
        case("T-D 恶意样本: 只作素材落盘不执行", r.get("ok") and "忽略之前的要求" in raw_readme
             and os.path.isfile(os.path.join(evil_dir, "raw", "repo.json")))

        # ── 12. 真实网络冒烟（可 SKIP） ──
        if args.skip_network:
            print("[SKIP] 真实网络冒烟（--skip-network 指定跳过）")
            RESULTS.append(("真实网络冒烟", None, "SKIP by flag"))
        else:
            try:
                root4 = os.path.join(tmp, "kb4")
                os.makedirs(root4)
                rr = run("fetch", "--root", root4, "--url", "https://github.com/psf/requests")
                if rr.get("ok") and rr.get("complete"):
                    case("真实网络冒烟: 公开仓库四源抓取", True)
                else:
                    msg = "; ".join(rr.get("issues", []))[:120]
                    if any(k in msg for k in ("配额", "网络", "HTTP")):
                        print("[SKIP] 真实网络冒烟 — " + msg)
                        RESULTS.append(("真实网络冒烟", None, msg))
                    else:
                        case("真实网络冒烟: 公开仓库四源抓取", False, msg)
            except Exception as e:  # noqa: BLE001
                print("[SKIP] 真实网络冒烟 — " + str(e)[:120])
                RESULTS.append(("真实网络冒烟", None, str(e)[:80]))

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    total = len(RESULTS)
    passed = sum(1 for _, ok, _ in RESULTS if ok is True)
    failed = sum(1 for _, ok, _ in RESULTS if ok is False)
    skipped = sum(1 for _, ok, _ in RESULTS if ok is None)
    print("\n=== ALL DONE === PASS=%d FAIL=%d SKIP=%d TOTAL=%d" % (passed, failed, skipped, total))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
