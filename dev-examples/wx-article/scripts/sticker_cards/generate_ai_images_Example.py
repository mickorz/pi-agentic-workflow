#!/usr/bin/env python3
"""generate_ai_images_Example.py —— AI 生图路由执行器测试（T3，零 LLM 零真实费用）。

覆盖 DoD 验收清单（mock 全链 + 注入故障）：
- 提示词存档（NN.md，含构图比例与负面约束）；
- mock 全链：PENDING -> SUCCEEDED，产物 MIME/尺寸/SHA256 校验，稳定编号不覆盖；
- 已 SUCCEEDED 跳过；
- 无配置降级：FAILED + 失败原因存档，不伪造图片；
- [DRY]：真实配置缺 --yes 不发请求；
- UNKNOWN：注入超时 -> UNKNOWN；重跑仍 UNKNOWN（禁自动重试）；产物已存在 -> 自动转
  SUCCEEDED；--mark-failed -> FAILED -> 重跑重试；
- 明确失败注入：FAILED，其他页不受影响（单张失败隔离）；
- max-images 截断。

运行：python3 generate_ai_images_Example.py
"""
from __future__ import annotations

import json
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "generate_ai_images.py"

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'OK' if cond else 'FAIL'}] {name}" + (f" | {detail}" if detail and not cond else ""))


def make_png(path: Path, w: int = 900, h: int = 1200, color: tuple = (40, 60, 90)) -> None:
    raw = b"".join(b"\x00" + bytes(color) * w for _ in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def make_fixture(root: Path, n_ai: int = 2, with_cfg: bool = True) -> tuple[Path, Path, Path]:
    """文章目录 + pages.json（含 n_ai 个 ai-image 页）+ 配置目录。"""
    art = root / "article"
    card = art / "_cards"
    card.mkdir(parents=True)
    pages = {"schema_version": 2, "style_mode": "editorial", "theme": "ink-classic",
             "title": "生图路由测试", "content": "",
             "pages": [{"no": 1, "role": "cover", "source": "html", "layout": "cover-hook",
                        "copy": {"title": "封面", "points": ["a", "b", "c"]}}]}
    for i in range(2, 2 + n_ai):
        pages["pages"].append({"no": i, "role": "ai-illustration", "source": "ai-image",
                               "prompt": f"测试插画 {i}：一枚发光的齿轮"})
    (card / "pages.json").write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
    cfg = root / "cfg"
    if with_cfg:
        (cfg / ".aws-article").mkdir(parents=True)
        (cfg / "aws.env").write_text(
            "IMAGE_MODEL_API_KEY=sk-test\n", encoding="utf-8")
        (cfg / ".aws-article" / "config.json").write_text(json.dumps(
            {"image_model": {"base_url": "https://api.example.com/v1/images/generations",
                             "model": "test-image-model"}}), encoding="utf-8")
    return art, card / "pages.json", cfg


def run(script_args: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *script_args],
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout)


def state_of(cards_dir: Path) -> dict:
    return json.loads((cards_dir / "aigen-state.json").read_text(encoding="utf-8"))


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="aigen-example-"))
    try:
        # ---------- 1 mock 全链：PENDING -> SUCCEEDED + 校验 + 编号 ----------
        art, pages, cfg = make_fixture(tmp / "f1")
        card = art / "_cards"
        r = run(["--pages", str(pages), "--cards-dir", str(card), "--config-dir", str(cfg), "--mock"])
        check("mock 全链退出码 0", r.returncode == 0, f"rc={r.returncode} {r.stdout[-300:]}")
        st = state_of(card)
        check("两页均 SUCCEEDED",
              all(st["pages"][str(n)]["status"] == "SUCCEEDED" for n in ("2", "3")), str(st))
        for n, asset in (("2", "ai-02.png"), ("3", "ai-03.png")):
            p = art / "_cards" / "assets" / asset
            check(f"产物 {asset} 存在", p.is_file())
        first_sha = st["pages"]["2"]["sha256"]
        check("SHA256 已记录", bool(first_sha))
        check("提示词存档 2 份(仅 ai 页)", len(list((card / "prompts").glob("*.md"))) == 2)
        prompt_2 = (card / "prompts" / "02.md").read_text(encoding="utf-8")
        check("提示词含构图比例", "3:4" in prompt_2 and "1080x1440" in prompt_2, prompt_2[:200])
        check("提示词含负面约束", "负面约束" in prompt_2)

        # ---------- 2 已 SUCCEEDED 跳过（不覆盖） ----------
        before = (art / "_cards" / "assets" / "ai-02.png").read_bytes()
        r = run(["--pages", str(pages), "--cards-dir", str(card), "--config-dir", str(cfg), "--mock"])
        check("重跑全 SKIP 退出码 0", r.returncode == 0 and "SKIP" in r.stdout)
        check("成功产物不被覆盖",
              (art / "_cards" / "assets" / "ai-02.png").read_bytes() == before)

        # ---------- 3 无配置降级（不伪造图片） ----------
        art3, pages3, _ = make_fixture(tmp / "f3", with_cfg=False)
        card3 = art3 / "_cards"
        r = run(["--pages", str(pages3), "--cards-dir", str(card3),
                 "--config-dir", str(art3), "--yes"])
        check("无配置 FAILED 退出码 1", r.returncode == 1, f"rc={r.returncode}")
        st3 = state_of(card3)
        check("无配置状态 FAILED + 原因存档",
              all(st3["pages"][str(n)]["status"] == "FAILED" and "配置缺失" in (st3["pages"][str(n)].get("error") or "")
                  for n in ("2", "3")), str(st3))
        check("降级不伪造图片", not any((card3 / "assets").glob("ai-*.png")))

        # ---------- 4 [DRY]：有配置缺 --yes 不发请求 ----------
        art4, pages4, cfg4 = make_fixture(tmp / "f4")
        card4 = art4 / "_cards"
        r = run(["--pages", str(pages4), "--cards-dir", str(card4), "--config-dir", str(cfg4)])
        check("[DRY] 缺 --yes 退出码 0 且无产物", r.returncode == 0
              and not any((card4 / "assets").glob("ai-*.png")), r.stdout[-200:])

        # ---------- 5 UNKNOWN：超时注入 / 禁自动重试 / 产物存在恢复 / mark-failed ----------
        art5, pages5, cfg5 = make_fixture(tmp / "f5")
        card5 = art5 / "_cards"
        r = run(["--pages", str(pages5), "--cards-dir", str(card5), "--config-dir", str(cfg5),
                 "--inject", "add-timeout", "--yes"])
        check("超时进 UNKNOWN 退出码 2", r.returncode == 2, f"rc={r.returncode} {r.stdout[-300:]}")
        st5 = state_of(card5)
        check("两页 UNKNOWN", all(st5["pages"][str(n)]["status"] == "UNKNOWN" for n in ("2", "3")))
        r = run(["--pages", str(pages5), "--cards-dir", str(card5), "--config-dir", str(cfg5), "--yes"])
        check("UNKNOWN 重跑不自动重试（仍退出码 2）", r.returncode == 2
              and "UNKNOWN" in r.stdout, f"rc={r.returncode}")
        # 模拟"请求其实已产生图片"：产物落位后重跑自动转 SUCCEEDED
        shutil.copy2(HERE / "fixtures" / "_cards" / "assets" / "shot-01.png",
                     card5 / "assets" / "ai-02.png")
        r = run(["--pages", str(pages5), "--cards-dir", str(card5), "--config-dir", str(cfg5), "--yes"])
        st5 = state_of(card5)
        check("产物已存在 -> UNKNOWN 自动转 SUCCEEDED",
              st5["pages"]["2"]["status"] == "SUCCEEDED" and st5["pages"]["3"]["status"] == "UNKNOWN",
              str(st5))
        r = run(["--pages", str(pages5), "--cards-dir", str(card5), "--config-dir", str(cfg5),
                 "--mark-failed", "3"])
        check("--mark-failed 转 FAILED 退出码 1", r.returncode == 1, f"rc={r.returncode}")
        st5 = state_of(card5)
        check("mark-failed 后状态 FAILED", st5["pages"]["3"]["status"] == "FAILED")
        # FAILED 可重跑重试（修复后去掉注入）
        shutil.copy2(HERE / "fixtures" / "_cards" / "assets" / "shot-01.png",
                     card5 / "assets" / "ai-03.png")  # 预置产物模拟服务恢复
        r = run(["--pages", str(pages5), "--cards-dir", str(card5), "--config-dir", str(cfg5),
                 "--yes", "--inject", "add-timeout"])  # 页3 产物已存在会被恢复路径接住
        st5 = state_of(card5)
        check("FAILED 页重跑恢复", st5["pages"]["3"]["status"] in ("SUCCEEDED", "UNKNOWN"), str(st5))

        # ---------- 5b 完整 SHA256（T3 收口 P0-3） ----------
        check("SHA256 完整 64 位", len(first_sha) == 64, f"len={len(first_sha)}")

        # ---------- 5c GENERATING 崩溃恢复（T3 收口 P0-1） ----------
        art5c, pages5c, cfg5c = make_fixture(tmp / "f5c")
        card5c = art5c / "_cards"
        # 模拟上次进程崩溃：状态停在 GENERATING 且 run_id 是旧值
        st5c = {"pages": {"2": {"status": "GENERATING", "attempts": 1, "run_id": "rOLD-999"},
                          "3": {"status": "GENERATING", "attempts": 1, "run_id": "rOLD-999"}}}
        (card5c / "aigen-state.json").write_text(json.dumps(st5c, ensure_ascii=False), encoding="utf-8")
        # 页2 有产物（请求其实已成功），页3 无产物
        (card5c / "assets").mkdir(parents=True, exist_ok=True)
        shutil.copy2(HERE / "fixtures" / "_cards" / "assets" / "shot-01.png",
                     card5c / "assets" / "ai-02.png")
        r = run(["--pages", str(pages5c), "--cards-dir", str(card5c), "--config-dir", str(cfg5c), "--yes"])
        st5c = state_of(card5c)
        check("崩溃页有产物 -> SUCCEEDED（自动恢复）", st5c["pages"]["2"]["status"] == "SUCCEEDED", str(st5c["pages"]["2"]))
        check("崩溃页无产物 -> UNKNOWN（HOLD 禁重付费）", st5c["pages"]["3"]["status"] == "UNKNOWN", str(st5c["pages"]["3"]))
        check("崩溃恢复退出码 2", r.returncode == 2, f"rc={r.returncode}")

        # 5c-2 expected_sha256 不匹配 -> HOLD 不转 SUCCEEDED
        (card5c / "aigen-state.json").write_text(json.dumps({"pages": {
            "2": {"status": "GENERATING", "attempts": 1, "run_id": "rOLD-998",
                  "expected_sha256": "deadbeef" * 8}}}, ensure_ascii=False), encoding="utf-8")
        r = run(["--pages", str(pages5c), "--cards-dir", str(card5c), "--config-dir", str(cfg5c), "--yes"])
        st5c = state_of(card5c)
        check("expected SHA256 不匹配 -> 保持 UNKNOWN(HOLD)",
              st5c["pages"]["2"]["status"] == "UNKNOWN" and "不符" in (st5c["pages"]["2"].get("error") or ""),
              str(st5c["pages"]["2"]))

        # ---------- 5d 下载失败区分（T3 收口 P0-2）：UNKNOWN + download_url 保留，不重付费 ----------
        art5d, pages5d, cfg5d = make_fixture(tmp / "f5d")
        card5d = art5d / "_cards"
        r = run(["--pages", str(pages5d), "--cards-dir", str(card5d), "--config-dir", str(cfg5d),
                 "--inject", "dl-fail", "--yes"])
        check("下载失败进 UNKNOWN 退出码 2", r.returncode == 2, f"rc={r.returncode} {r.stdout[-200:]}")
        st5d = state_of(card5d)
        check("download_url 证据保留",
              all(st5d["pages"][str(n)].get("download_url") for n in ("2", "3")), str(st5d))
        r = run(["--pages", str(pages5d), "--cards-dir", str(card5d), "--config-dir", str(cfg5d), "--yes"])
        st5d = state_of(card5d)
        check("恢复重试下载仍失败 -> 保持 UNKNOWN（不重新付费）",
              all(st5d["pages"][str(n)]["status"] == "UNKNOWN" for n in ("2", "3"))
              and all(st5d["pages"][str(n)].get("download_url") for n in ("2", "3")), str(st5d))

        # ---------- 6 明确失败隔离：单张 FAILED 不影响其他页 ----------
        art6, pages6, cfg6 = make_fixture(tmp / "f6")
        card6 = art6 / "_cards"
        r = run(["--pages", str(pages6), "--cards-dir", str(card6), "--config-dir", str(cfg6),
                 "--inject", "add-errcode", "--yes"])
        check("明确失败退出码 1", r.returncode == 1, f"rc={r.returncode}")
        st6 = state_of(card6)
        check("失败页 FAILED + 原因", all(
            st6["pages"][str(n)]["status"] == "FAILED" and st6["pages"][str(n)].get("error")
            for n in ("2", "3")), str(st6))

        # ---------- 7 max-images 截断 ----------
        art7, pages7, cfg7 = make_fixture(tmp / "f7")
        card7 = art7 / "_cards"
        r = run(["--pages", str(pages7), "--cards-dir", str(card7), "--config-dir", str(cfg7),
                 "--mock", "--max-images", "1"])
        st7 = state_of(card7)
        check("max-images=1 只生成 1 张", st7["pages"]["2"]["status"] == "SUCCEEDED"
              and st7["pages"]["3"]["status"] == "PENDING", str(st7))
        check("截断有 [WARN] 提示", "上限" in r.stdout or "WARN" in r.stdout)

        # ---------- 8 真实模式示例提示词组装（DRY 输出计划含模型与张数） ----------
        r = run(["--pages", str(pages7), "--cards-dir", str(card7), "--config-dir", str(cfg7)])
        check("真实模式 [DRY] 打印模型与张数", "test-image-model" in r.stdout and "张数=" in r.stdout,
              r.stdout[-300:])

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
