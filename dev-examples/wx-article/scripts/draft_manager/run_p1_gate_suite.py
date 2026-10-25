#!/usr/bin/env python3
"""P1 Gate 测试套件：article pipeline 确定性主干（check_state + 插图脚本 + publish v2，无 LLM）。

覆盖 V1.2 第八节强制场景：B 多 md 歧义 / D 插画重生成 / E inspect 零副作用，
及 P1-CLI Gate：缺图补图、同内容复用、变更更新不产生第二份草稿、元数据不丢失。
工作流编排层（article_prepare.js 等）由 pi-workflow validate + 真机冒烟覆盖（见 P1 报告）。

运行：python3 run_p1_gate_suite.py [--keep]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHECK = HERE / "check_state.py"
PUBLISH = HERE / "publish.py"
INSERT = HERE.parent / "references" / "article_insert_images_meta" / "scripts" / "insert_images.py"

MD = """---
title: 测试文章P1
description: P1 套件摘要
---

# 测试文章P1

开场段落保证转换后的 HTML 长度超过短内容门禁，内容真实自然。

## 一、上篇

第一章正文，保持足够长度确保 HTML 字符数达标，验证插图定位与发布链路正常。

## 二、下篇

第二章正文，同样保持长度，配合两章各自的配图完成语义匹配插图场景。

"""

YAML_PRESET = """title: 测试文章P1
author: Tester
digest: P1 套件摘要
publish_completed: true
content_source: 正文.md
image_medium: AI生成插画（正文 2 张）
custom_keep_field: keepme-p1
"""

PNG_A = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050201f34a24d50000000049454e44ae426082")
PNG_B = PNG_A[:-1] + b"0"  # 不同字节，模拟另一张图

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" | {detail}" if not cond and detail else ""))


def run_py(script: Path, *extra: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(script), *extra],
                          capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def run_pub(article_dir: Path, cfg: Path, *extra: str) -> subprocess.CompletedProcess:
    return run_py(PUBLISH, "--article-dir", str(article_dir), "--cover", "cover.png",
                  "--config-dir", str(cfg), "--mock", *extra)


def drafts_of(article_dir: Path, appid: str = "wxaaa") -> dict:
    f = article_dir / "publish-mock-store.json"
    if not f.is_file():
        return {}
    d = json.loads(f.read_text(encoding="utf-8"))["drafts"]
    return {k: v for k, v in d.items() if v.get("appid") == appid and not v.get("deleted")}


def make_fixture(root: Path) -> tuple[Path, Path]:
    art = root / "P1文章"
    (art / "imgs").mkdir(parents=True)
    (art / "imgs" / "一.png").write_bytes(PNG_A)
    (art / "imgs" / "二.png").write_bytes(PNG_B)
    (art / "cover.png").write_bytes(PNG_A)
    (art / "正文.md").write_text(MD, encoding="utf-8")  # 注意：正文未引用 imgs，制造"缺图"场景
    (art / "article.yaml").write_text(YAML_PRESET, encoding="utf-8")
    cfg = root / "cfg"
    (cfg / ".aws-article").mkdir(parents=True)
    (cfg / "aws.env").write_text("WECHAT_1_APPID=wxaaa\nWECHAT_1_APPSECRET=s1\n", encoding="utf-8")
    (cfg / ".aws-article" / "config.json").write_text(
        json.dumps({"default_author": "Tester", "need_open_comment": 1, "only_fans_can_comment": 0}),
        encoding="utf-8")
    return art, cfg


def make_workspace(root: Path) -> tuple[Path, Path]:
    ws = root / "WS"
    for n in ("第一篇", "第一篇备份"):
        d = ws / n
        d.mkdir(parents=True)
        (d / "正文.md").write_text(MD, encoding="utf-8")
    return ws, ws / "第一篇"


def snapshot_dir(d: Path) -> dict:
    out = {}
    for p in sorted(d.rglob("*")):
        if p.is_file():
            st = p.stat()
            out[str(p.relative_to(d))] = (st.st_size, st.st_mtime_ns,
                                          hashlib.sha256(p.read_bytes()).hexdigest()[:16])
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    root = Path(tempfile.mkdtemp(prefix="p1gate-"))
    print(f"[suite] workdir={root}")

    # ============ B: 名称定位规则（唯一命中/多候选/零命中） ============
    ws, hit = make_workspace(root)
    r = run_py(CHECK, "--locate", "第一篇", "--workspace", str(ws))
    j = json.loads(r.stdout)
    check("B.multi-candidates-stop", j["ok"] is False and len(j["candidates"]) == 2, r.stdout)
    r = run_py(CHECK, "--locate", "第一篇备份", "--workspace", str(ws))
    j = json.loads(r.stdout)
    check("B.unique-hit-full-check", j["ok"] is True and j["article_dir"] == str(ws / "第一篇备份"), r.stdout)
    r = run_py(CHECK, "--locate", "不存在", "--workspace", str(ws))
    j = json.loads(r.stdout)
    check("B.zero-hit", j["ok"] is False and j["candidates"] == [])

    # ============ B2: 多 md 歧义（check_state 层） ============
    art, cfg = make_fixture(root)
    (art / "正文备份.md").write_text(MD, encoding="utf-8")
    r = run_py(CHECK, "--article-dir", str(art))
    j = json.loads(r.stdout)
    check("B2.ambiguous-reported", len(j["issues"]) > 0 and "md candidates" in j["issues"][0], r.stdout)
    check("B2.not-ready", j["prepare_ready"] is False)
    (art / "正文备份.md").unlink()

    # ============ E: inspect 只读零副作用 ============
    before = snapshot_dir(art)
    run_py(CHECK, "--article-dir", str(art))
    run_py(CHECK, "--locate", "P1文章", "--workspace", str(root))
    check("E.read-only-untouched", snapshot_dir(art) == before)

    # ============ 缺图补图主干（check -> insert py -> check -> publish） ============
    r = run_py(CHECK, "--article-dir", str(art))
    j = json.loads(r.stdout)
    check("INSERT.needs-insert-detected", j["needs_insert"] is True and j["imgs"]["files"] == 2, r.stdout)
    check("INSERT.cover-imgs-state", j["cover"]["state"] == "root", str(j.get("cover")))

    mapping = [
        {"image": "imgs/一.png", "heading": "## 一、上篇", "alt": "术语插画：上篇"},
        {"image": "imgs/二.png", "heading": "## 二、下篇", "alt": "术语插画：下篇"},
    ]
    map_path = art / "_mapping.json"
    map_path.write_text(json.dumps(mapping, ensure_ascii=False), encoding="utf-8")
    r = run_py(INSERT, "--article-dir", str(art), "--md-file", str(art / "正文.md"),
               "--mapping-path", str(map_path), "--cover-image", "cover.png")
    check("INSERT.py-exit0", r.returncode == 0 and "ALL DONE" in r.stdout, r.stdout + r.stderr)
    map_path.unlink(missing_ok=True)

    yaml_before = (art / "article.yaml").read_bytes()
    r = run_py(CHECK, "--article-dir", str(art))
    j = json.loads(r.stdout)
    check("INSERT.after-insert-referenced", j["imgs"]["referenced"] >= 2 and j["needs_insert"] is False, r.stdout)
    check("INSERT.prepare-ready", j["prepare_ready"] is True, str(j.get("issues")))

    # ============ I2: 插图幂等 / 错图替换 / 序号确定性映射（2026-10-24 修复回归） ============
    map_path.write_text(json.dumps(mapping, ensure_ascii=False), encoding="utf-8")
    md_before = (art / "正文.md").read_bytes()
    r = run_py(INSERT, "--article-dir", str(art), "--md-file", str(art / "正文.md"),
               "--mapping-path", str(map_path), "--cover-image", "cover.png")
    check("I2.rerun-idempotent", r.returncode == 0 and "skipped: 2" in r.stdout
          and "inserted 0 / 2" in r.stdout
          and (art / "正文.md").read_bytes() == md_before, r.stdout)

    t = (art / "正文.md").read_text(encoding="utf-8-sig")
    (art / "正文.md").write_text(t.replace("imgs/一.png", "imgs/错图.png"), encoding="utf-8-sig")
    r = run_py(INSERT, "--article-dir", str(art), "--md-file", str(art / "正文.md"),
               "--mapping-path", str(map_path), "--cover-image", "cover.png")
    t2 = (art / "正文.md").read_text(encoding="utf-8-sig")
    check("I2.wrong-img-replaced", r.returncode == 0 and "replaced: 1" in r.stdout
          and "imgs/错图.png" not in t2 and "imgs/一.png" in t2, r.stdout)
    map_path.unlink(missing_ok=True)

    # numbered 模式：无 mapping 扫 imgs 按序号映射；mapping 带序号时服务端覆盖乱写的 heading
    nart = root / "P1编号文章"
    (nart / "imgs").mkdir(parents=True)
    (nart / "imgs" / "01-上.png").write_bytes(PNG_A)
    (nart / "imgs" / "02-下.png").write_bytes(PNG_B)
    (nart / "正文.md").write_text(MD, encoding="utf-8")
    r = run_py(INSERT, "--article-dir", str(nart), "--mode", "numbered")
    t3 = (nart / "正文.md").read_text(encoding="utf-8-sig")
    i1, i2 = t3.find("## 一、上篇"), t3.find("## 二、下篇")
    check("I2.numbered-mapping", r.returncode == 0 and "inserted 2 / 2" in r.stdout
          and 0 < t3.find("imgs/01-上.png") < i2 and t3.find("imgs/02-下.png") > i2 > i1 > 0, r.stdout)

    bogus = [{"image": "imgs/01-上.png", "heading": "## 乱写的章节", "alt": "x"},
             {"image": "imgs/02-下.png", "heading": "## 也是乱写", "alt": "y"}]
    (nart / "_bogus.json").write_text(json.dumps(bogus, ensure_ascii=False), encoding="utf-8")
    r = run_py(INSERT, "--article-dir", str(nart), "--mode", "mapping", "--mapping-path", str(nart / "_bogus.json"))
    check("I2.numbered-override-bogus-heading", r.returncode == 0 and "[NUMBER]" in r.stdout
          and "skipped: 2" in r.stdout and "heading not found" not in r.stdout, r.stdout)
    (nart / "_bogus.json").unlink(missing_ok=True)

    # ============ 首次发布（add）+ 复用（reuse）+ 变更更新（update，场景 D） ============
    r = run_pub(art, cfg)
    check("PUB.add-exit0", r.returncode == 0 and "=== ALL DONE" in r.stdout, r.stdout + r.stderr)
    m1 = [ln for ln in r.stdout.splitlines() if "ALL DONE" in ln][0].split("draft_media_id=")[-1]
    check("PUB.yaml-untouched", (art / "article.yaml").read_bytes() == yaml_before)

    r = run_pub(art, cfg)
    check("PUB.reuse-no-new-draft", r.returncode == 0 and "(reuse" in r.stdout
          and len(drafts_of(art)) == 1, r.stdout)

    # 场景 D：插画重生成（正文未变，图片字节变） => Hash 变化走 update，不产生第二份
    (art / "imgs" / "二.png").write_bytes(PNG_B[::-1])
    r = run_pub(art, cfg)
    check("D.update-exit0", r.returncode == 0 and "(updated)" in r.stdout, r.stdout + r.stderr)
    m2 = [ln for ln in r.stdout.splitlines() if "ALL DONE" in ln][0].split("draft_media_id=")[-1]
    check("D.same-media-no-dup", m1 == m2 and len(drafts_of(art)) == 1, f"{m1} vs {m2}")
    check("D.yaml-still-untouched", (art / "article.yaml").read_bytes() == yaml_before)

    # ============ 汇总 ============
    print(f"\n===== SUITE SUMMARY: PASS {len(PASS)} / FAIL {len(FAIL)} =====")
    if FAIL:
        print("failed items:")
        for f in FAIL:
            print(f"  - {f}")
    if not args.keep:
        shutil.rmtree(root, ignore_errors=True)
    else:
        print(f"[suite] kept workdir: {root}")
    print("=== ALL DONE ===" if not FAIL else "=== SUITE FAILED ===")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
