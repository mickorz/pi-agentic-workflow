#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""github_kb.py 快速自检（Example）——一条链跑通核心契约。

与完整套件 run_github_kb_suite.py 的区别：本脚本只做冒烟（解析→抓取→归档→定位），
适合改动后 30 秒快速确认；完整回归跑套件。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KB = os.path.join(HERE, "github_kb.py")
FIXTURE = os.path.join(HERE, "fixtures", "github", "demo-repo")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ANALYSIS = """# demo-repo 项目研究档案

## 一句话定位
基于配置文件的轻量任务编排工具，主打失败重试与超时控制，适合自动化小场景。

## 核心能力
基于配置文件定义任务流程；支持失败重试与超时控制；提供 CLI 与 HTTP 两种触发方式。

## 技术架构与依赖
Python 为主（约 21000 行），辅以少量 Shell 与 JavaScript；配置驱动，pip 安装。

## 适用场景与目标用户
批量数据处理、定时任务编排、轻量 CI；适合个人开发者与小团队。

## 亮点与差异化
配置即流程，双触发入口开箱可用，上手成本低。

## 风险与局限
生态较新，star 数不高（42），社区规模待观察。

## 推荐角度建议
- recommend：入门推荐
- compare：与 cron/Make 对比
"""

EVIDENCE = {
    "version": 1,
    "claims": [
        {"claim": "基于配置文件定义任务流程", "source": "README.md", "reference": "", "evidenceLevel": "documented"},
        {"claim": "支持失败重试与超时控制", "source": "README.md", "reference": "", "evidenceLevel": "documented"},
        {"claim": "提供 CLI 与 HTTP 两种触发方式", "source": "README.md", "reference": "", "evidenceLevel": "documented"},
        {"claim": "Python 为主约 21000 行", "source": "languages.json", "reference": "", "evidenceLevel": "code_inspected"},
        {"claim": "适合批量数据处理与定时编排", "source": "README.md", "reference": "", "evidenceLevel": "inferred"},
    ],
}


def b64(t):
    import base64
    return base64.b64encode(t.encode("utf-8")).decode("ascii")


def kb(*a):
    p = subprocess.run([sys.executable, KB] + list(a), capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=60)
    return json.loads(p.stdout)


def main():
    tmp = tempfile.mkdtemp(prefix="gh-kb-example-")
    root = os.path.join(tmp, "kb")
    ok = True
    try:
        r = kb("parse-url", "--url", "https://github.com/example/demo-repo")
        assert r["ok"] and r["projectId"] == "example__demo-repo", r
        print("[OK] parse-url")

        r = kb("fetch", "--root", root, "--url", "https://github.com/example/demo-repo", "--fixture", FIXTURE)
        assert r["ok"] and r["complete"], r
        print("[OK] fetch (fixture)")

        r = kb("archive", "--root", root, "--project-id", "example__demo-repo",
               "--analysis-b64", b64(ANALYSIS), "--evidence-b64", b64(json.dumps(EVIDENCE)))
        assert r["ok"], r
        print("[OK] archive")

        r = kb("locate", "--root", root, "--project-id", "example__demo-repo")
        assert r["ok"] and r["analysisReady"], r
        print("[OK] locate (analysisReady)")
    except AssertionError as e:
        print("[FAIL] " + str(e)[:300])
        ok = False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("=== ALL DONE === " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
