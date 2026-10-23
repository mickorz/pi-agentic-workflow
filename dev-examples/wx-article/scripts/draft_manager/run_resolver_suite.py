#!/usr/bin/env python3
"""vault_resolver.py 门禁套件（执行方案 V1.2 §S5 用例 1–17）。

用法：python3 run_resolver_suite.py
输出契约：逐用例 [PASS]/[FAIL]/[SKIP]，结尾汇总 + `=== ALL DONE === PASS=x FAIL=y SKIP=z`；
退出码 0=全过/SKIP，1=存在 FAIL。fixture 幂等自动创建；symlink 在 Windows 创建受限时显式 SKIP。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
RESOLVER = HERE / "vault_resolver.py"
FIXTURE = HERE / "test-fixture" / "vault"

FIXTURE_FILES = {
    "公众号/AI入门/Prompt.md": "fixture 正文 Prompt",
    "公众号/AI入门/稿子.md": "fixture 正文 稿子",
    "公众号/AI入门/CASE.md": "fixture 正文 CASE（大小写陷阱）",
    "公众号/AI入门/单篇/唯一.md": "fixture 正文 唯一",
    "newsky/AI提问技巧/从零学AI.md": "fixture 正文 从零学AI",
    "dup/A/笔记.md": "fixture 正文 笔记A",
    "dup/B/笔记.md": "fixture 正文 笔记B",
}
ESCAPE_LINK = FIXTURE / "公众号" / "escape"
REAL_MAC_ROOT = Path.home() / "Downloads" / "同步空间" / "Obsidian"


class Skip(Exception):
    pass


def ensure_fixture() -> None:
    for rel, text in FIXTURE_FILES.items():
        p = FIXTURE / rel
        if not p.is_file():
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
    # 越界符号链接（Windows 无特权创建 symlink → 用例内 SKIP）
    if os.name != "nt" and not ESCAPE_LINK.is_symlink():
        try:
            ESCAPE_LINK.symlink_to(tempfile.gettempdir(), target_is_directory=True)
        except OSError:
            pass


def run_resolver(extra_args: list[str], env_overrides: dict | None = None,
                 env_clear: tuple[str, ...] = ("OBSIDIAN_VAULT_ROOT",), cwd: Path | None = None) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in env_clear}
    if env_overrides:
        env.update(env_overrides)
    proc = subprocess.run(
        [sys.executable, str(RESOLVER), *extra_args],
        capture_output=True, text=True, encoding="utf-8", env=env,
        cwd=str(cwd) if cwd else None, timeout=60,
    )
    try:
        return json.loads(proc.stdout)
    except ValueError:
        raise AssertionError(f"stdout 非法 JSON（rc={proc.returncode}）: {proc.stdout[:200]!r} stderr={proc.stderr[:200]!r}")


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def flag_ok(res: dict) -> dict:
    """通用健全性：ok=true 时必须有 resolved_path/resolved_rel/path_type；ok=false 时必须有 issues 或 candidates。"""
    if res.get("ok"):
        expect(bool(res.get("resolved_path")) and bool(res.get("resolved_rel")), f"ok=true 缺 resolved_*: {res}")
        expect(res.get("path_type") in ("dir", "file"), f"path_type 非法: {res}")
    else:
        expect(bool(res.get("issues")) or bool(res.get("candidates")), f"ok=false 缺 issues/candidates: {res}")
    return res


# ── 用例（对应 V1.2 §S5 表 1–17）──

def case_01():
    res = flag_ok(run_resolver(["--ref", "公众号/AI入门/Prompt.md", "--vault-root", str(FIXTURE)]))
    expect(res["ok"] and res["match"] == "exact_path" and res["path_type"] == "file", f"期望 exact_path+file: {res}")


def case_02():
    res = flag_ok(run_resolver(["--ref", "AI提问技巧", "--vault-root", str(FIXTURE)]))
    expect(res["ok"] and res["resolved_rel"] == "newsky/AI提问技巧" and res["path_type"] == "dir", f"期望唯一目录: {res}")


def case_03():
    res = flag_ok(run_resolver(["--ref", "AI入门", "--vault-root", str(FIXTURE)]))
    expect(res["ok"] and res["match"] == "exact_name", f"期望 exact_name: {res}")


def case_04():
    res = flag_ok(run_resolver(["--ref", "笔记", "--vault-root", str(FIXTURE)]))
    expect(not res["ok"] and len(res.get("candidates", [])) == 2, f"期望 2 候选绝不猜: {res}")


def case_05():
    res = flag_ok(run_resolver(["--ref", "不存在", "--vault-root", str(FIXTURE)]))
    expect(not res["ok"] and not res.get("candidates"), f"期望零命中: {res}")


def case_06():
    res = flag_ok(run_resolver(["--ref", "公众号/不存在路径", "--vault-root", str(FIXTURE)]))
    expect(not res["ok"] and any("精确匹配" in i for i in res["issues"]), f"期望不退化名称搜索: {res}")


def case_07():
    res = flag_ok(run_resolver(["--ref", "../outside", "--vault-root", str(FIXTURE)]))
    expect(not res["ok"] and any("越界" in i or "非法段" in i for i in res["issues"]), f"期望拒越界: {res}")
    if os.name == "nt" or not ESCAPE_LINK.is_symlink():
        raise Skip("symlink 不可创建（Windows 无特权），符号链接逃逸子断言跳过")
    res2 = flag_ok(run_resolver(["--ref", "公众号/escape", "--vault-root", str(FIXTURE)]))
    expect(not res2["ok"] and any("越界" in i for i in res2["issues"]), f"期望符号链接逃逸拒绝: {res2}")


def case_08():
    res = flag_ok(run_resolver(["--ref", "Prompt", "--want", "dir", "--vault-root", str(FIXTURE)]))
    expect(not res["ok"] and any("want=dir" in i and "Prompt.md" in i for i in res["issues"]), f"期望提示命中文件: {res}")


def case_09():
    res = flag_ok(run_resolver(["--ref", "Prompt", "--want", "article", "--vault-root", str(FIXTURE)]))
    mds = res.get("candidates", [])
    expect(not res["ok"] and len(mds) >= 2 and "Prompt.md" in mds, f"期望列 md 候选不自动选: {res}")


def case_10():
    res = flag_ok(run_resolver(["--ref", "唯一", "--want", "article", "--vault-root", str(FIXTURE)]))
    expect(res["ok"] and res["path_type"] == "dir" and res["md"] == "唯一.md"
            and res["resolved_rel"] == "公众号/AI入门/单篇", f"期望父目录+md: {res}")


def case_11():
    res = flag_ok(run_resolver(["--ref", "公众号/AI入门/Prompt.md", "--scope", "公众号/AI入门",
                                "--vault-root", str(FIXTURE)]))
    expect(res["ok"], f"期望 scope 内通过: {res}")


def case_12():
    res = flag_ok(run_resolver(["--ref", "公众号/AI入门/Prompt.md", "--scope", "newsky",
                                "--vault-root", str(FIXTURE)]))
    expect(not res["ok"] and any("scope 硬约束" in i for i in res["issues"]), f"期望精确路径也受 scope 硬约束: {res}")


def case_13():
    res = flag_ok(run_resolver(["--ref", "公众号/AI入门/prompt.md", "--vault-root", str(FIXTURE)]))
    expect(not res["ok"] and any("大小写" in i and "Prompt.md" in i for i in res["issues"]), f"期望大小写提示: {res}")


def case_14():
    # (a) --vault-root 优先于环境变量
    res = run_resolver(["--ref", "AI提问技巧", "--vault-root", str(FIXTURE)],
                       env_overrides={"OBSIDIAN_VAULT_ROOT": "/nonexistent-vault-xyz"})
    expect(res["ok"] and res["vault_root"] == str(FIXTURE.resolve()), f"期望 flag 优先: {res}")
    # (b) 环境变量单独生效（且指向不存在目录时报错）
    res = run_resolver(["--ref", "AI提问技巧"], env_overrides={"OBSIDIAN_VAULT_ROOT": "/nonexistent-vault-xyz"})
    expect(not res["ok"] and any("不存在" in i for i in res["issues"]), f"期望坏根报错: {res}")
    # (c) 环境变量指向 fixture 生效
    res = run_resolver(["--ref", "AI提问技巧"], env_overrides={"OBSIDIAN_VAULT_ROOT": str(FIXTURE)})
    expect(res["ok"], f"期望 env 生效: {res}")
    # (d) config.json 兜底：临时 cwd 下 .aws-article/config.json
    with tempfile.TemporaryDirectory() as td:
        cfg_dir = Path(td) / ".aws-article"
        cfg_dir.mkdir()
        (cfg_dir / "config.json").write_text(json.dumps({"vault_root": str(FIXTURE)}), encoding="utf-8")
        res = run_resolver(["--ref", "AI提问技巧"], cwd=Path(td))
        expect(res["ok"] and res["vault_root"] == str(FIXTURE.resolve()), f"期望 config 兜底: {res}")


def case_15():
    for poison in ['a";rm -rf /', "$(echo x)", "空格 中文 名"]:
        res = flag_ok(run_resolver(["--ref", poison, "--vault-root", str(FIXTURE)]))
        expect(not res["ok"] and not res.get("resolved_path"), f"特殊字符必须字面量失败: {poison} -> {res}")


def case_16():
    with tempfile.TemporaryDirectory() as td:
        res = flag_ok(run_resolver(["--ref", "AI提问技巧"], cwd=Path(td)))
    expect(not res["ok"] and any("OBSIDIAN_VAULT_ROOT" in i for i in res["issues"])
            and any("--print-vaults" in i for i in res["issues"]), f"期望配置指引: {res}")


def case_17():
    if sys.platform != "darwin" or not REAL_MAC_ROOT.is_dir():
        raise Skip("非 Mac 或真实 vault 不存在")
    res = flag_ok(run_resolver(["--ref", "AI生图", "--vault-root", str(REAL_MAC_ROOT)]))
    expect(res["ok"] and res["match"] in ("exact_name", "unique_partial"), f"期望真实 vault 唯一定位: {res}")


CASES = [case_01, case_02, case_03, case_04, case_05, case_06, case_07, case_08, case_09,
         case_10, case_11, case_12, case_13, case_14, case_15, case_16, case_17]


def main() -> int:
    ensure_fixture()
    passed = failed = skipped = 0
    for fn in CASES:
        name = fn.__name__.replace("case_", "用例 ")
        try:
            fn()
            passed += 1
            print(f"[PASS] {name}")
        except Skip as s:
            skipped += 1
            print(f"[SKIP] {name} — {s}")
        except AssertionError as e:
            failed += 1
            print(f"[FAIL] {name} — {e}")
    print(f"汇总: PASS={passed} FAIL={failed} SKIP={skipped}")
    print(f"=== ALL DONE === PASS={passed} FAIL={failed} SKIP={skipped}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
