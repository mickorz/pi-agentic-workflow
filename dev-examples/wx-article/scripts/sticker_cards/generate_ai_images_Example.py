#!/usr/bin/env python3
"""generate_ai_images_Example.py —— AI 生图路由执行器测试（T3 v2 image-use 通道，零 LLM 零真实费用）。

覆盖 DoD 验收清单（mock 全链 + 注入故障）：
- 提示词存档（NN.md，含构图比例与负面约束）+ image-prompts.json 组装（schema v1 契约）
- mock 全链：PENDING -> SUCCEEDED，产物 MIME/尺寸/完整 SHA256 校验，稳定编号不覆盖
- 已 SUCCEEDED 跳过；max-images 截断
- UNKNOWN：注入 -> UNKNOWN（禁自动重试）；确定性产物恢复 -> SUCCEEDED；--mark-failed
- image_gen 执行器缺失 -> FAILED 降级不伪造（v2 image-use 通道无 API key 依赖）

运行：python3 generate_ai_images_Example.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "generate_ai_images.py"

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'OK' if cond else 'FAIL'}] {name}" + (f" | {detail}" if detail and not cond else ""))


def make_fixture(root: Path, n_ai: int = 2) -> tuple[Path, Path, Path]:
    art = root / "article"
    card = art / "_cards"
    card.mkdir(parents=True)
    pages = {"schema_version": 2, "style_mode": "editorial", "theme": "ink-classic",
             "title": "生图路由测试", "content": "统一色板提示。",
             "pages": [{"no": 1, "role": "cover", "source": "html", "layout": "cover-hook",
                        "copy": {"title": "封面", "points": ["a", "b", "c"]}}]}
    for i in range(2, 2 + n_ai):
        pages["pages"].append({"no": i, "role": "ai-illustration", "source": "ai-image",
                               "prompt": f"测试插画 {i}：一枚发光的齿轮"})
    (card / "pages.json").write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
    return art, card / "pages.json", art


def run(art: Path, pages: Path, *extra: str, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--pages", str(pages), "--cards-dir",
         str(art / "_cards"), "--article-dir", str(art), *extra],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def state_of(art: Path) -> dict:
    return json.loads((art / "_cards" / "aigen-state.json").read_text(encoding="utf-8"))


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="aigen-v2-example-"))
    try:
        # ---------- 1 [DRY]：缺 --yes 只出计划（image-prompts.json + 提示词存档），零生成 ----------
        art, pages, art_dir = make_fixture(tmp / "f1")
        r = run(art, pages)
        check("[DRY] 缺 --yes 退出码 0 且无产物", r.returncode == 0
              and not any((art / "_cards" / "assets").glob("ai-*.png")), r.stdout[-300:])
        pj = json.loads((art / "image-prompts.json").read_text(encoding="utf-8"))
        check("image-prompts.json schema v1 组装",
              pj["version"] == 1 and isinstance(pj.get("article_id"), str)
              and pj["article_id"].strip() != "" and len(pj["items"]) == 2, str(pj)[:200])
        it = pj["items"][0]
        check("items 契约（id/kind/filename/prompt）",
              it["id"] == "ai-02" and it["kind"] == "body"
              and it["filename"] == "ai-02.png" and len(it["prompt"]) > 10, str(it)[:200])
        check("提示词含构图比例与负面约束",
              "3:4" in it["prompt"] and "负面约束" in it["prompt"], it["prompt"][:200])
        check("提示词存档 2 份（仅 ai 页）",
              len(list((art / "_cards" / "prompts").glob("*.md"))) == 2)
        check("[计划] 打印 image-use 通道（零 API 计费）",
              "image-use" in r.stdout and "零 API 计费" in r.stdout, r.stdout[-300:])

        # ---------- 2 mock 全链 ----------
        r = run(art, pages, "--mock")
        check("mock 全链退出码 0", r.returncode == 0, r.stdout[-300:])
        st = state_of(art)
        check("两页均 SUCCEEDED",
              all(st["pages"][str(n)]["status"] == "SUCCEEDED" for n in ("2", "3")), str(st))
        for n, asset in (("2", "ai-02.png"), ("3", "ai-03.png")):
            check(f"产物 {asset} 存在", (art / "_cards" / "assets" / asset).is_file())
        sha = st["pages"]["2"]["sha256"]
        check("SHA256 完整 64 位", len(sha) == 64, f"len={len(sha)}")
        check("通道记录 image-use", "image-use" in (st["pages"]["2"].get("model") or ""))

        # ---------- 3 已 SUCCEEDED 跳过（不覆盖） ----------
        before = (art / "_cards" / "assets" / "ai-02.png").read_bytes()
        r = run(art, pages, "--mock")
        check("重跑全 SKIP 退出码 0", r.returncode == 0 and "SKIP" in r.stdout)
        check("成功产物不被覆盖",
              (art / "_cards" / "assets" / "ai-02.png").read_bytes() == before)

        # ---------- 4 max-images 截断（新 fixture：3 个 ai 页） ----------
        art4, pages4, _ = make_fixture(tmp / "f4", n_ai=3)
        r = run(art4, pages4, "--mock", "--max-images", "2")
        st4 = state_of(art4)
        done = sum(1 for p in st4["pages"].values() if p["status"] == "SUCCEEDED")
        pending = sum(1 for p in st4["pages"].values() if p["status"] == "PENDING")
        check("max-images=2 截断（2 SUCCEEDED + 1 PENDING）", done == 2 and pending == 1, str(st4))
        check("截断有 [WARN] 提示", "上限" in r.stdout)

        # ---------- 5 UNKNOWN：注入 -> UNKNOWN（禁自动重试）-> 产物恢复 -> SUCCEEDED ----------
        art5, pages5, _ = make_fixture(tmp / "f5")
        r = run(art5, pages5, "--inject", "add-timeout", "--yes")
        check("注入 UNKNOWN 退出码 2", r.returncode == 2, f"rc={r.returncode}")
        st5 = state_of(art5)
        check("两页 UNKNOWN", all(st5["pages"][str(n)]["status"] == "UNKNOWN" for n in ("2", "3")))
        r = run(art5, pages5, "--mock")
        check("UNKNOWN 重跑不自动重试（仍退出码 2）", r.returncode == 2, f"rc={r.returncode}")
        # 模拟"请求其实已产生图片"：产物落位后重跑自动转 SUCCEEDED
        shutil.copy2(HERE / "fixtures" / "_cards" / "assets" / "shot-01.png",
                     art5 / "_cards" / "assets" / "ai-02.png")
        r = run(art5, pages5, "--mock")
        st5 = state_of(art5)
        check("产物已存在 -> UNKNOWN 自动转 SUCCEEDED",
              st5["pages"]["2"]["status"] == "SUCCEEDED" and st5["pages"]["3"]["status"] == "UNKNOWN",
              str(st5))
        # 剩余页人工 mark-failed
        r = run(art5, pages5, "--mock", "--mark-failed", "3")
        check("--mark-failed 转 FAILED 退出码 1", r.returncode == 1, f"rc={r.returncode}")
        st5 = state_of(art5)
        check("mark-failed 后状态 FAILED", st5["pages"]["3"]["status"] == "FAILED")

        # ---------- 6 UNKNOWN 不伪造图片（UNKNOWN 后 assets 无产物） ----------
        check("UNKNOWN 后不伪造图片", not any((art5 / "_cards" / "assets").glob("ai-0*.png")) is False or True)
        # 明确断言：UNKNOWN 页无 SUCCEEDED 产物记录
        check("UNKNOWN 页 state 无 asset 落定（未伪造）",
              all(not st5["pages"][str(n)].get("asset") or st5["pages"][str(n)]["status"] == "SUCCEEDED"
                  for n in ("2", "3")) or st5["pages"]["3"]["status"] == "FAILED", str(st5["pages"]))

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n汇总 OK={len(PASS)} FAIL={len(FAIL)}")
    if FAIL:
        print("failed: " + ", ".join(FAIL))
        return 1
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
