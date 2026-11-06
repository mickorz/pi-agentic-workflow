#!/usr/bin/env python3
"""validate_pages_Example.py —— validate_pages.py 确定性测试（零 LLM，可重复）。

覆盖 T1 验收清单的校验侧用例：
合法通过 / schema_version 错 / 缺必填字段 / 未知 layout / 重复页号 / 页号不递增 /
page1 非 cover / points 长度越界 / screenshot 禁 cover / ai-image 缺 prompt /
ai-image asset 的 plan 与 build 模式差异 / asset 路径穿越与前缀违规与文件缺失 / title 超长。

运行：python3 validate_pages_Example.py
输出契约：逐项 [OK]/[FAIL]，结尾汇总；全过退出码 0。
"""
from __future__ import annotations

import copy
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_pages import validate_pages  # noqa: E402

PASS: list[str] = []
FAIL: list[str] = []

HERE = Path(__file__).resolve().parent
FIXTURE = json.loads((HERE / "fixtures" / "_cards" / "pages-fixture.json").read_text(encoding="utf-8"))


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'OK' if cond else 'FAIL'}] {name}" + (f" | {detail}" if detail and not cond else ""))


def errs_of(data: dict, root: Path | None = None, build_mode: bool = False) -> list[str]:
    return validate_pages(copy.deepcopy(data), article_root=root, build_mode=build_mode)


def main() -> int:
    # 1 合法 fixture 通过
    check("合法 fixture 通过", errs_of(FIXTURE, HERE / "fixtures") == [])

    # 2 schema_version 错误
    bad = copy.deepcopy(FIXTURE); bad["schema_version"] = 1
    check("schema_version=1 拒绝", any("schema_version" in e for e in errs_of(bad)))

    # 3 缺必填字段（封面缺 copy.points）
    bad = copy.deepcopy(FIXTURE); del bad["pages"][0]["copy"]["points"]
    check("缺必填字段 copy.points 拒绝", any("copy.points" in e for e in errs_of(bad)))

    # 4 未知 layout
    bad = copy.deepcopy(FIXTURE); bad["pages"][0]["layout"] = "magic-hero"
    check("未知 layout 拒绝", any("未知 layout" in e for e in errs_of(bad)))

    # 5 重复页号
    bad = copy.deepcopy(FIXTURE); bad["pages"][1]["no"] = 1
    check("重复页号拒绝", any("页号重复" in e for e in errs_of(bad)))

    # 6 页号不递增
    bad = copy.deepcopy(FIXTURE); bad["pages"][1]["no"] = 0
    check("页号不递增拒绝", any("递增" in e for e in errs_of(bad)))

    # 7 page1 非 cover
    bad = copy.deepcopy(FIXTURE); bad["pages"][0]["role"] = "point"
    check("page1 非 cover 拒绝", any("page 1 必须 role=cover" in e for e in errs_of(bad)))

    # 8 points 长度越界（cover 3~5，给 2 个）
    bad = copy.deepcopy(FIXTURE); bad["pages"][0]["copy"]["points"] = ["只有一条", "两条"]
    check("points 长度越界拒绝", any("长度须在" in e for e in errs_of(bad)))

    # 9 screenshot 组件禁 cover（image_fit_allow 只含 contain）
    bad = copy.deepcopy(FIXTURE); bad["pages"][1]["image_fit"] = "cover"
    check("screenshot image_fit=cover 拒绝", any("image_fit" in e or "cover" in e for e in errs_of(bad)))

    # 10 ai-image 缺 prompt
    bad = copy.deepcopy(FIXTURE)
    bad["pages"].append({"no": 3, "role": "ai-illustration", "source": "ai-image"})
    check("ai-image 缺 prompt 拒绝", any("prompt" in e for e in errs_of(bad)))

    # 11 ai-image asset：plan 模式可缺，build 模式必须
    ok_data = copy.deepcopy(bad); ok_data["pages"][2]["prompt"] = "3:4 竖版配图"
    check("ai-image plan 模式允许缺 asset", errs_of(ok_data) == [])
    check("ai-image build 模式缺 asset 拒绝", errs_of(ok_data, build_mode=True) != [])

    # 12 asset 路径穿越
    bad = copy.deepcopy(FIXTURE)
    bad["pages"][1]["asset"] = "_cards/assets/../../secret.png"
    root = Path(tempfile.mkdtemp(prefix="vp-example-"))
    (root / "_cards" / "assets").mkdir(parents=True)
    check("asset 路径穿越拒绝", any("非法路径" in e for e in errs_of(bad, root)))

    # 13 asset 前缀违规（不在 _cards/assets/ 白名单内）
    bad = copy.deepcopy(FIXTURE); bad["pages"][1]["asset"] = "assets/shot-01.png"
    check("asset 前缀违规拒绝", any("开头" in e for e in errs_of(bad, root)))

    # 14 asset 文件缺失
    bad = copy.deepcopy(FIXTURE); bad["pages"][1]["asset"] = "_cards/assets/not-exist.png"
    check("asset 文件缺失拒绝", any("不存在" in e for e in errs_of(bad, root)))

    # 15 title 超长
    bad = copy.deepcopy(FIXTURE); bad["title"] = "超" * 33
    check("title 超 32 字拒绝", any("title 超" in e for e in errs_of(bad)))

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
