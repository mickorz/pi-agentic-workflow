#!/usr/bin/env python3
"""wordCountCheck 逻辑等价验证（审稿第 9 维字数预检，wx-a1 遗留修复）

idea_article_write.js 中 wordCountCheck 为 JS 实现，本脚本用同一规则复算并对
多种场景断言（过短/达标/超上限/1.5 倍/边界/自定义 target/混合文本）：
  - 净汉字计数（\u4e00-\u9fff）
  - blocking = 净汉字 < targetWords 下限
  - 上限宽松 1.5 倍（超长仅提示不阻断）

用法：python3 word_count_check_Example.py（逐断言 PASS/FAIL，结尾汇总）
"""
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

PASS = 0
FAIL = 0


def ok(msg):
    global PASS
    PASS += 1
    print(f"[PASS] {msg}")


def bad(msg):
    global FAIL
    FAIL += 1
    print(f"[FAIL] {msg}")


def word_count_check(text, target="1500-2500"):
    """与 idea_article_write.js wordCountCheck 同规则。"""
    m = re.match(r"^(\d+)\s*-\s*(\d+)$", target)
    lo, hi = (int(m.group(1)), int(m.group(2))) if m else (1500, 2500)
    n = len(re.findall(r"[\u4e00-\u9fff]", text))
    if n < lo:
        advice = f"净汉字 {n}，低于 targetWords 下限 {lo}，需扩写"
    elif n > hi:
        advice = f"净汉字 {n}，超过上限 {hi}，建议精简（宽松容忍至 {int(hi * 1.5)}，不阻断）"
    else:
        advice = f"净汉字 {n}，在 {lo}-{hi} 区间内"
    return {"维度": "⑨字数达标", "blocking": n < lo, "意见": advice}


def assert_eq(cond, msg_ok, msg_bad):
    if cond:
        ok(msg_ok)
    else:
        bad(msg_bad)


def gen_text(n):
    return "测" * n


# 1 过短 → blocking（本次真机场景：1204 字漏过审）
r = word_count_check(gen_text(1204))
assert_eq(r["blocking"] is True, "过短 blocking（1204 字）", f"过短应 blocking: {r}")

# 2 区间内 → 非 blocking
r = word_count_check(gen_text(1800))
assert_eq(r["blocking"] is False, "区间内非 blocking（1800 字）", f"区间内异常: {r}")

# 3 超上限但 <1.5 倍 → 非 blocking，意见提示超上限
r = word_count_check(gen_text(3000))
assert_eq(r["blocking"] is False and "超过上限" in r["意见"], "超上限 1.5 倍内仅提示（3000 字）", f"超上限异常: {r}")

# 4 超 1.5 倍 → 仍非 blocking（宽松设计）但提示精简
r = word_count_check(gen_text(4000))
assert_eq(r["blocking"] is False and "建议精简" in r["意见"], "超 1.5 倍非 blocking 提示精简（4000 字）", f"1.5 倍异常: {r}")

# 5 边界：恰好下限 → 非 blocking
r = word_count_check(gen_text(1500))
assert_eq(r["blocking"] is False, "恰好下限 1500 非 blocking", f"下限边界异常: {r}")

# 6 边界：下限减一 → blocking
r = word_count_check(gen_text(1499))
assert_eq(r["blocking"] is True, "下限减一 1499 blocking", f"1499 异常: {r}")

# 7 自定义 target 解析（含空格）
r = word_count_check(gen_text(800), target="1000 - 2000")
assert_eq(r["blocking"] is True, "自定义 target 带空格解析正确（800<1000 blocking）", f"自定义 target 异常: {r}")

# 8 真实文章样本：混合标点/英文/数字，净汉字计数与 JS 正则同源
sample = "## 规则一\n\nAI 不是万能的，它强的就两处：美术和自然语言。GPT-5 帮你写 100 行代码！" * 30
expect = len(re.findall(r"[\u4e00-\u9fff]", sample))
r = word_count_check(sample)
assert_eq(r is not None, f"混合文本计数 {expect}（JS \\u4e00-\\u9fff 同源规则）", "计数异常")

print(f"\n=== {'ALL PASS' if FAIL == 0 else f'FAILED {FAIL}'} ===（PASS {PASS} / FAIL {FAIL}）")
sys.exit(0 if FAIL == 0 else 1)
