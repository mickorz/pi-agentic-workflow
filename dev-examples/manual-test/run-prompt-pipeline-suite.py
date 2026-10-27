#!/usr/bin/env python3
"""生图提示词流水线离线自动验收（P0-C T10，方案 V2.1 第十节第一层验收）

覆盖：schema 闸 / prompt 组合 / 缓存差异矩阵（含规则分桶）/ 稳定 ID 分级匹配 /
meta 配套校验 / convert 源变更检测 / 执行器 dry-run 联通。
全程零付费：只用 validate-plan、compile、convert、stable-ids 离线脚本与 fake provider dry-run，
不调用任何真实生图 Provider（结构自证，无付费路径）。

说明：
  - Prepare 本体（article_image_prompt_prepare.js）是 workflow DSL，需 pi-workflow 运行时与
    agent 能力，不在本套件范围（标 SKIP；其核心组件 stable-ids/validate-plan 在此直接测）。
  - 真实效果验收（第二层）需人工 + 付费，见方案第十节，不在本套件。

用法：python run-prompt-pipeline-suite.py（在本目录执行；需要 node 在 PATH）
（逐断言 PASS/FAIL/SKIP + 结尾汇总计数，风格对齐 run-stop-signal-suite.py）
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
WX = HERE.parent / "wx-article"
GEN = WX / "scripts" / "image_gen"

PASS = 0
FAIL = 0
SKIP = 0


def ok(msg: str) -> None:
    global PASS
    PASS += 1
    print(f"[PASS] {msg}", flush=True)


def bad(msg: str) -> None:
    global FAIL
    FAIL += 1
    print(f"[FAIL] {msg}", flush=True)


def skip(msg: str) -> None:
    global SKIP
    SKIP += 1
    print(f"[SKIP] {msg}", flush=True)


def check(cond: bool, pass_msg: str, fail_msg: str) -> bool:
    if cond:
        ok(pass_msg)
    else:
        bad(fail_msg)
    return cond


def run(cmd: list[str]) -> tuple[int, str]:
    r = subprocess.run(cmd, capture_output=True, text="utf-8", errors="replace")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def node(script: Path, *args: str) -> tuple[int, str]:
    return run(["node", str(script), *args])


def tag_line(stdout: str, tag: str) -> str | None:
    for line in reversed(stdout.splitlines()):
        if line.startswith(tag):
            return line[len(tag):]
    return None


def load_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def write_json(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def base_plan(article_id: str = "suite-article") -> dict:
    return {
        "version": 1,
        "article_id": article_id,
        "visual_profile": "ai-knowledge",
        "source_article_hash": "a" * 64,
        "items": [
            {"id": "cv-01", "type": "cover", "heading": "", "concept": "Agent 从聊天走向执行",
             "layout": "左侧标题安全区，右侧核心主体", "aspect_ratio": "2.35:1", "source_facts": []},
            {"id": "ig-01", "type": "infographic", "heading": "## Agent 是怎么工作的",
             "concept": "Agent 工作循环", "layout": "四阶段横向流程图", "aspect_ratio": "16:9",
             "source_facts": ["接收任务", "制定计划", "调用工具", "返回结果"]},
            {"id": "il-01", "type": "illustration", "heading": "## 什么是 MCP",
             "concept": "MCP 像通用插座连接工具", "layout": "中心插座与四周设备连线",
             "aspect_ratio": "16:9", "source_facts": []},
        ],
    }


def main() -> int:
    if shutil.which("node") is None:
        print("[FAIL] node 不在 PATH")
        return 2

    work = Path(tempfile.mkdtemp(prefix="genimg-suite-"))
    art = work / "article"
    art.mkdir(parents=True)
    plan_path = art / "image-design-plan.json"
    json_path = art / "image-prompts.json"
    meta_path = art / "image-prompts.meta.json"
    write_json(plan_path, base_plan())

    try:
        # ============ A. schema 闸 ============
        print("\n===== A. validate-plan schema 闸 =====")
        rc, out = node(GEN / "validate-plan.mjs", str(plan_path))
        check(rc == 0 and "[VALID] ok items=3" in out, "A1 合法 plan 过闸", f"A1 exit={rc} out={out[:200]}")

        cases = [
            ("A2 非法 type", lambda p: p["items"][1].__setitem__("type", "chart")),
            ("A3 infographic 无 source_facts", lambda p: p["items"][1].__setitem__("source_facts", [])),
            ("A4 重复 id", lambda p: p["items"][2].__setitem__("id", "ig-01")),
            ("A5 双 cover", lambda p: p["items"][2].__setitem__("type", "cover")),
            ("A6 坏 aspect_ratio", lambda p: p["items"][1].__setitem__("aspect_ratio", "wide")),
            ("A7 非法 id 字符", lambda p: p["items"][1].__setitem__("id", "IG_01")),
        ]
        for name, mutate in cases:
            p = work / "bad.json"
            doc = base_plan()
            mutate(doc)
            write_json(p, doc)
            rc, out = node(GEN / "validate-plan.mjs", str(p))
            check(rc == 2 and "[VALID] errors=" in out, f"{name} 拒绝(exit 2)", f"{name} exit={rc} out={out[:200]}")

        # ============ B. 编译组合 ============
        print("\n===== B. compile 确定性编译与组合 =====")
        rc, out = node(GEN / "compile.mjs", "--article-dir", str(art))
        compile_ok = rc == 0 and "[COMPILE] items=3" in out
        check(compile_ok, "B1 编译成功 items=3", f"B1 exit={rc} out={out[:300]}")
        diff1 = tag_line(out, "[DIFF] ") or ""
        check("added=cv-01,ig-01,il-01" in diff1, "B5 首次编译全量 added", f"B5 diff={diff1}")

        doc = load_json(json_path)
        check("柔和水彩" in doc["style_prefix"], "B2 style 含账号规则", "B2 style 缺账号规则")
        check("童话感" in doc["style_prefix"], "B2 style 含栏目规则", "B2 style 缺栏目规则")
        ig = next(it for it in doc["items"] if it["id"] == "ig-01")
        check("信息图构图" in ig["prompt"] and "接收任务" in ig["prompt"], "B3 ig prompt=类型规则+事实", "B3 ig prompt 组装缺失")
        check(doc["items"][0]["kind"] == "cover" and doc["items"][0]["filename"] == "cover.png",
              "B4 cover 映射与缺省名", "B4 cover 映射错误")
        check(ig["kind"] == "body" and ig["filename"] == "01-ig-01.png", "B4 body 映射与 filename", "B4 body 映射错误")

        meta = load_json(meta_path)
        rh = meta.get("rules_hash", {})
        check(rh.get("account") and set(rh.get("types", {})) == {"cover", "infographic", "data-chart", "illustration"}
              and rh.get("series", {}).get("ai-knowledge"), "B6 规则分桶哈希齐全", f"B6 rules_hash={list(rh)}")
        check(bool(meta.get("plan_hash")) and bool(meta.get("json_content_hash")), "B6 plan/json 哈希落盘", "B6 哈希缺失")

        rc, out = node(GEN / "compile.mjs", "--validate-only", str(json_path))
        check(rc == 0 and "[VALID] ok" in out, "B7 产物过 D6 闸", f"B7 exit={rc} out={out[:200]}")

        rc, out = node(GEN / "compile.mjs", "--check-meta", str(art))
        check(rc == 0 and "[META] ok" in out, "C4 check-meta 配套通过", f"C4 exit={rc} out={out[:200]}")

        eff_before = meta["items_effective_hash"]

        # ============ C. 缓存差异矩阵 ============
        print("\n===== C. 缓存差异矩阵（无误失效 / 精确失效） =====")
        rc, out = node(GEN / "compile.mjs", "--article-dir", str(art))
        diff2 = tag_line(out, "[DIFF] ") or ""
        check("changed=- added=- removed=-" in diff2, "C1 内容不变重编译无失效", f"C1 diff={diff2}")

        # C2 改某条 heading（id 不变）-> 仅该条 changed，其他条目 hash 不变
        plan = load_json(plan_path)
        plan["items"][1]["heading"] = "## Agent 的工作循环"  # ig-01
        write_json(plan_path, plan)
        rc, out = node(GEN / "compile.mjs", "--article-dir", str(art))
        diff3 = tag_line(out, "[DIFF] ") or ""
        check("changed=ig-01" in diff3 and "cv-01" not in diff3 and "il-01" not in diff3,
              "C2 改一条 heading 仅该条失效", f"C2 diff={diff3}")
        eff_now = load_json(meta_path)["items_effective_hash"]
        check(eff_now["cv-01"] == eff_before["cv-01"] and eff_now["il-01"] == eff_before["il-01"],
              "C2 未改条目 effective hash 不变（manifest 将复用已付费图）", "C2 未改条目 hash 漂移")

        # C3 改类型规则（infographic.md）-> 仅 ig 条目失效；分桶哈希只动 types.infographic
        visual_tmp = work / "visual"
        shutil.copytree(WX / "visual", visual_tmp)
        ig_rule = visual_tmp / "types" / "infographic.md"
        # 在 prompt-block 段内改一行（若追加到文件尾则落在 checklist 段，promptBlock 提取不到，无法触发 prompt 变化）
        ig_rule.write_text(ig_rule.read_text(encoding="utf-8").replace(
            "条目数量：步骤或节点不超过五个", "条目数量：步骤或节点不超过四个（套件修改触发规则变更）"), encoding="utf-8")
        rc, out = node(GEN / "compile.mjs", "--article-dir", str(art), "--visual-dir", str(visual_tmp))
        diff4 = tag_line(out, "[DIFF] ") or ""
        check("changed=ig-01" in diff4 and "cv-01" not in diff4 and "il-01" not in diff4,
              "C3 改信息图规则仅信息图条目失效", f"C3 diff={diff4}")
        rh_now = load_json(meta_path)["rules_hash"]
        check(rh_now["types"]["infographic"] != rh["types"]["infographic"]
              and rh_now["account"] == rh["account"]
              and rh_now["types"]["cover"] == rh["types"]["cover"]
              and rh_now["series"]["ai-knowledge"] == rh["series"]["ai-knowledge"],
              "C3 rules_hash 仅 infographic 桶变化", "C3 分桶哈希漂移范围错误")

        # C5/C6 meta 残缺拒绝复用
        meta_path.unlink()
        rc, out = node(GEN / "compile.mjs", "--check-meta", str(art))
        check(rc == 2 and "meta-missing" in out, "C5 缺 meta 拒绝复用", f"C5 exit={rc} out={out[:120]}")
        node(GEN / "compile.mjs", "--article-dir", str(art))  # 恢复配套
        jp = json_path.read_text(encoding="utf-8")
        json_path.write_text(jp + "\n", encoding="utf-8")  # 篡改内容（模拟两次 rename 之间中断）
        rc, out = node(GEN / "compile.mjs", "--check-meta", str(art))
        check(rc == 2 and "content-hash" in out, "C6 json 篡改被内容哈希检出", f"C6 exit={rc} out={out[:120]}")

        # ============ D. 稳定 ID 分级匹配 ============
        print("\n===== D. stable-ids 分级匹配（V2.1 第七节） =====")
        sid = GEN / "lib" / "stable-ids.mjs"
        old_p = work / "old-plan.json"
        new_p = work / "new-designed.json"
        write_json(old_p, {"items": [
            {"id": "cv-01", "type": "cover", "heading": "", "filename": "cover.png"},
            {"id": "ig-01", "type": "infographic", "heading": "## 什么是 Agent", "filename": "01-ig-01.png"},
            {"id": "ig-02", "type": "infographic", "heading": "## 什么是 MCP", "filename": "02-ig-02.png"},
            {"id": "il-01", "type": "illustration", "heading": "## 什么是 Skill", "filename": "03-il-01.png"},
        ]})
        write_json(new_p, {"items": [
            {"type": "cover", "heading": "", "concept": "c", "layout": "l", "aspect_ratio": "2.35:1", "source_facts": []},
            {"type": "infographic", "heading": "## 什么是 Agent", "concept": "c", "layout": "l", "aspect_ratio": "16:9", "source_facts": ["a"]},
            {"type": "infographic", "heading": "## 什么是 RAG", "concept": "c", "layout": "l", "aspect_ratio": "16:9", "source_facts": ["r"]},
            {"type": "infographic", "heading": "## 什么是 MCP", "concept": "c", "layout": "l", "aspect_ratio": "16:9", "source_facts": ["m"]},
            {"type": "illustration", "heading": "## 什么是 Skill", "concept": "c", "layout": "l", "aspect_ratio": "16:9", "source_facts": []},
        ]})
        rc, out = node(sid, "--new", str(new_p), "--old", str(old_p))
        m = json.loads(tag_line(out, "[MATCH] ") or "{}")
        ids = {it["heading"] or "cover": it["id"] for it in m.get("items", [])}
        check(rc == 0 and ids.get("cover") == "cv-01" and ids.get("## 什么是 Agent") == "ig-01"
              and ids.get("## 什么是 MCP") == "ig-02" and ids.get("## 什么是 Skill") == "il-01",
              "D1 RAG 中段插入：既有条目身份全部保留", f"D1 ids={ids}")
        check(m.get("new_ids") == ["ig-03"] and m["items"][2]["id"] == "ig-03",
              "D1 新增 RAG 新建 ig-03（不抢占/不误绑 MCP 的 ig-02）", f"D1 new_ids={m.get('new_ids')}")

        write_json(old_p, {"items": [
            {"id": "ig-01", "type": "infographic", "heading": "## 重复章节", "filename": "01.png"},
            {"id": "ig-02", "type": "infographic", "heading": "## 重复章节", "filename": "02.png"},
        ]})
        write_json(new_p, {"items": [
            {"type": "infographic", "heading": "## 重复章节", "concept": "c", "layout": "l", "aspect_ratio": "16:9", "source_facts": ["x"]},
        ]})
        rc, out = node(sid, "--new", str(new_p), "--old", str(old_p))
        c = tag_line(out, "[CONFLICT] ") or ""
        check(rc == 3 and "多候选" in c and "ig-01" in c and "ig-02" in c,
              "D2 多候选不自动继承，冲突报告列候选", f"D2 rc={rc} out={out[:200]}")
        rc, out = node(sid, "--new", str(new_p), "--old", str(old_p), "--resolve-new")
        m = json.loads(tag_line(out, "[MATCH] ") or "{}")
        check(rc == 0 and len(m.get("new_ids", [])) == 1, "D3 resolve-new 强制新建", f"D3 rc={rc} out={out[:200]}")

        # ============ E. convert 源变更检测 ============
        print("\n===== E. convert 源变更检测 =====")
        mart = work / "md-article"
        mart.mkdir()
        md = mart / "image-prompts.md"
        md.write_text("## 封面\n\n提示词：小王子站在星球上眺望 AI 星系，柔和水彩\n\n## 什么是 Agent\n\n提示词：机器人助手接收信件整理任务的水彩插画\n", encoding="utf-8")
        rc, out = node(GEN / "convert.mjs", "--article-dir", str(mart))
        check(rc == 0 and "[RESULT]" in out and "items=2" in out, "E1 首次编译", f"E1 rc={rc} out={out[:200]}")
        rc, out = node(GEN / "convert.mjs", "--article-dir", str(mart))
        check(rc == 0 and "[SKIP]" in out and "未变化" in out, "E2 未变化复用", f"E2 rc={rc} out={out[:200]}")
        md.write_text(md.read_text(encoding="utf-8") + "\n## Agent 工具\n\n提示词：机器人用扳手修理水管的水彩插画\n", encoding="utf-8")
        rc, out = node(GEN / "convert.mjs", "--article-dir", str(mart))
        diff5 = tag_line(out, "[DIFF] ") or ""
        check("[STALE]" in out and "added=" in diff5 and "agent-" in diff5,
              "E3 md 变更重编译并报差异", f"E3 out={out[:200]}")
        mjson = load_json(mart / "image-prompts.json")
        first = next(it for it in mjson["items"] if "小王子" in it["prompt"])
        eff_md = load_json(mart / "image-prompts.meta.json")["items_effective_hash"]
        check(diff5.startswith("changed=- ") or "changed=-" in diff5.split("added=")[0],
              "E3 未改动条目不在 changed（继续复用）", f"E3 changed 异常: {diff5}")
        (mart / "image-design-plan.json").write_text("{}", encoding="utf-8")
        rc, out = node(GEN / "convert.mjs", "--article-dir", str(mart))
        check(rc == 0 and "[SKIP]" in out and "compile.mjs" in out, "E4 plan 存在时 md 链路让路", f"E4 rc={rc} out={out[:200]}")
        (mart / "image-design-plan.json").unlink()
        (mart / "image-prompts.meta.json").unlink()
        rc, out = node(GEN / "convert.mjs", "--article-dir", str(mart))
        check(rc == 0 and "[STALE]" in out and "meta-missing" in out and "[RESULT]" in out,
              "E5 meta 残缺重编译（不静默沿用）", f"E5 rc={rc} out={out[:200]}")

        # ============ F. 执行器联通（零付费 dry-run） ============
        print("\n===== F. 执行器联通（fake provider dry-run） =====")
        rc, out = node(WX / "scripts" / "image_gen" / "generate.mjs",
                       "--article-dir", str(art), "--provider", "fake", "--mode", "preview", "--dry-run")
        plan_line = tag_line(out, "[PLAN] ")
        check(rc == 0 and plan_line is not None, "F1 执行器接受 Compiler 产物（dry-run 出计划）", f"F1 rc={rc} out={out[:300]}")
        if plan_line:
            try:
                plan_obj = json.loads(plan_line)
                check(isinstance(plan_obj.get("items"), list) and len(plan_obj["items"]) >= 1,
                      "F2 计划条目可解析", "F2 items 解析失败")
            except json.JSONDecodeError:
                bad("F2 [PLAN] 非法 JSON")

        # ============ H. 栏目媒介接管（medium-override，ai-landing） ============
        print("\n===== H. medium-override 媒介接管 =====")
        lart = work / "landing-article"
        lart.mkdir()
        lplan = base_plan("landing-article")
        lplan["visual_profile"] = "ai-landing"
        write_json(lart / "image-design-plan.json", lplan)
        rc, out = node(GEN / "compile.mjs", "--article-dir", str(lart))
        check(rc == 0 and "[COMPILE]" in out, "H1 ai-landing 编译成功", f"H1 rc={rc} out={out[:200]}")
        ldoc = load_json(lart / "image-prompts.json")
        check("柔和水彩" not in ldoc["style_prefix"], "H2 override 后 style 不含账号水彩段", "H2 style 仍含水彩段")
        check("Business AI 3D Infographic" in ldoc["style_prefix"] and "#142B49" in ldoc["style_prefix"],
              "H2 style 含栏目 3D 风格与色板", "H2 style 缺栏目风格核心")
        check("水彩" in doc["style_prefix"], "H3 对照组 ai-knowledge 仍叠加账号水彩段", "H3 对照组水彩段丢失")
        lmeta = load_json(lart / "image-prompts.meta.json")
        check("ai-landing" in lmeta["rules_hash"].get("series", {}), "H4 分桶哈希含 ai-landing", "H4 series 桶缺失")
        # override 后改账号规则不应影响 ai-landing 产物：用干净副本（只改 visual-rules.md prompt-block）
        visual_ovr = work / "visual-override"
        shutil.copytree(WX / "visual", visual_ovr)
        vr = visual_ovr / "visual-rules.md"
        vr.write_text(vr.read_text(encoding="utf-8").replace(
            "充足留白，画面密度低到中，单一视觉焦点，主体清晰突出。",
            "充足留白，画面密度低到中，单一视觉焦点，主体清晰突出。\n画面统一采用轻型纸张纹理边框装饰。"), encoding="utf-8")
        l_eff_before = lmeta["items_effective_hash"]
        rc, out = node(GEN / "compile.mjs", "--article-dir", str(lart), "--visual-dir", str(visual_ovr))
        l_eff_after = load_json(lart / "image-prompts.meta.json")["items_effective_hash"]
        diff6 = tag_line(out, "[DIFF] ") or ""
        check(l_eff_before == l_eff_after and "changed=-" in diff6.split("added=")[0],
              "H5 改水彩账号规则对 override 栏目零影响", f"H5 diff={diff6}")
        # 对照组：先恢复配套（C6 曾故意篡改 json），再同副本编译，应全量变化
        node(GEN / "compile.mjs", "--article-dir", str(art))
        rc, out = node(GEN / "compile.mjs", "--article-dir", str(art), "--visual-dir", str(visual_ovr))
        diff7 = tag_line(out, "[DIFF] ") or ""
        check("changed=cv-01,ig-01,il-01" in diff7,
              "H6 对照组（水彩栏目）同规则变化全量失效", f"H6 diff={diff7}")

        # ============ Prepare 本体说明 ============
        print("\n===== G. Prepare 本体（需 pi-workflow 运行时） =====")
        skip("G Prepare 是 workflow DSL（需 pi-workflow + agent），其组件 stable-ids/validate-plan 已在 A/D 覆盖；"
             "本体 e2e 待真实文章两篇基线时手动执行")

    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(f"\n===== 汇总: PASS={PASS} FAIL={FAIL} SKIP={SKIP} =====")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
