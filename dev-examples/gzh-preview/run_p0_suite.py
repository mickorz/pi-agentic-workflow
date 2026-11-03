#!/usr/bin/env python3
"""GZH 排版工作台 P0 验收套件(T0.5,API 级;方案 V2 第七节)。

用法(仓库根):
    python dev-examples/gzh-preview/run_p0_suite.py

前提:已 npm run build(Server 走 dist);fixture 文章在 dev-examples/gzh-preview/fixture-vault。
输出契约:逐项 [OK]/[FAIL]/[SKIP] + 结尾 === P0 SUITE DONE PASS=n FAIL=m SKIP=k ===

覆盖:鉴权 401 / 文章列表 / 加载重写(真实中文文件名+GIF) / 签名图片 200+MIME /
     保存往返(签名 URL 还原) / 只切主题 md 字节不变 / baseHash 409 / 路径逃逸 403 /
     保存后 check_state.py 仍可正常跑(prepare_ready 判定不受 style 字段影响)。
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

REPO = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent / "fixture-vault" / "单篇" / "20261102-DeepSeek超级智能体"
PORT = 8941
BASE = f"http://127.0.0.1:{PORT}"

PASS = FAIL = SKIP = 0


def report(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    mark = "[OK]" if ok else "[FAIL]"
    if ok:
        PASS += 1
    else:
        FAIL += 1
    print(f"{mark} {name}" + (f" - {detail}" if detail else ""))


def skip(name: str, reason: str) -> None:
    global SKIP
    SKIP += 1
    print(f"[SKIP] {name} - {reason}")


def wait_server(proc: subprocess.Popen, timeout_s: float = 20.0) -> tuple[str, str] | None:
    """等 Server 起来并从 stdout 抓 token(banner 在 listen 成功后打印,health 可达时 banner 必已产出)。"""
    import threading

    lines: list[str] = []

    def drain() -> None:
        try:
            for line in proc.stdout or []:
                lines.append(line)
        except Exception:
            pass

    t = threading.Thread(target=drain, daemon=True)
    t.start()
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if proc.poll() is not None:
            print(f"[FAIL] Server 进程提前退出: {''.join(lines)[-500:]}")
            return None
        try:
            with urllib.request.urlopen(f"{BASE}/api/health", timeout=2) as r:
                if r.status == 200:
                    # health 可达后 banner 已打印,短暂等线程收完
                    sub_deadline = time.time() + 2
                    while time.time() < sub_deadline:
                        import re
                        for line in lines:
                            m = re.search(r"本次会话[）)]:?\s*([0-9a-f]{16,})", line) or re.search(r"Bearer\s+([0-9a-f]{16,})", line)
                            if m:
                                return m.group(1), "".join(lines)
                        time.sleep(0.1)
                    return "", "".join(lines)
        except Exception:
            time.sleep(0.2)
    return None


def api(method: str, path: str, token: str, body: dict | None = None) -> tuple[int, dict | bytes]:
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    if not FIXTURE.exists():
        gen = subprocess.run([sys.executable, str(Path(__file__).parent / "make_fixture.py")], capture_output=True, text=True)
        print(gen.stdout.strip())
        if not FIXTURE.exists():
            print(f"[FAIL] fixture 生成失败: {FIXTURE}")
            return 1
    md_fixture = FIXTURE / "一句话解释DeepSeek刚开源的超级智能体super-agent.md"
    md_backup = md_fixture.read_bytes()  # 套件会改 md,结束时还原保证可重复跑
    env = dict(os.environ)
    env["GZH_PREVIEW_VAULT_ROOT"] = str(FIXTURE.parent.parent)
    env["PI_WORKFLOW_WEB_PORT"] = str(PORT)
    proc = subprocess.Popen(
        ["node", str(REPO / "dist" / "cli" / "index.js"), "web", "--port", str(PORT)],
        cwd=str(REPO),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        got = wait_server(proc)
        if not got or not got[0]:
            print("[FAIL] Server 未就绪或未拿到 token")
            proc.terminate()
            return 1
        token, _ = got
        report("Server 启动并拿到 token", True)

        # 1. 鉴权
        code, _ = api("GET", "/api/gzh/articles", "wrong-token")
        report("错误 token 401", code == 401)

        # 2. 列表(真实文章)
        code, body = api("GET", "/api/gzh/articles", token)
        arts = body.get("articles", []) if isinstance(body, dict) else []
        report("文章列表含 fixture 文章且 drafted=true", code == 200 and len(arts) == 1 and arts[0]["drafted"] is True)

        d = urllib.parse.quote(str(FIXTURE))
        # 3. 加载:GIF 与中文文件名都重写为签名 URL
        code, body = api("GET", f"/api/gzh/article?dir={d}", token)
        md = body.get("markdown", "") if isinstance(body, dict) else ""
        report(
            "加载重写 GIF 与中文文件名",
            code == 200 and "/gzh-img?" in md and "02-人机分工闭环.gif" in json.dumps(body.get("images", []), ensure_ascii=False) is not None and "](imgs/" not in md.split("未引用")[0],
        )

        # 4. 签名图片 200 + GIF MIME
        img_url = next((i["url"] for i in body["images"] if i["name"].endswith(".gif")), None)
        ok4 = False
        if img_url:
            req = urllib.request.Request(BASE + img_url)
            with urllib.request.urlopen(req, timeout=10) as r:
                ok4 = r.status == 200 and r.headers.get("Content-Type") == "image/gif" and r.read(4) == b"GIF8"
        report("签名图片免 Bearer 200 + image/gif", ok4)

        # 5. 保存往返:改标题 -> 签名 URL 还原
        edited = md.replace("# ", "# [预览改动] ", 1) if md.startswith("# ") else md + "\n[预览改动]"
        code, body5 = api("POST", "/api/gzh/article/save", token, {
            "dir": str(FIXTURE), "markdown": edited, "baseMdHash": body["mdHash"],
        })
        after = (FIXTURE / "一句话解释DeepSeek刚开源的超级智能体super-agent.md").read_text(encoding="utf-8")
        report(
            "保存还原相对路径且无签名 URL 残留",
            code == 200 and "](imgs/02-人机分工闭环.gif)" in after and "/gzh-img?" not in after and "[预览改动]" in after,
        )

        # 6. 只切主题:md 字节不变
        before_bytes = (FIXTURE / "一句话解释DeepSeek刚开源的超级智能体super-agent.md").read_bytes()
        code, body6 = api("POST", "/api/gzh/article/save", token, {"dir": str(FIXTURE), "style": "wechat-ft"})
        after_bytes = (FIXTURE / "一句话解释DeepSeek刚开源的超级智能体super-agent.md").read_bytes()
        yaml_text = (FIXTURE / "article.yaml").read_text(encoding="utf-8")
        report(
            "只切主题 md 字节不变 + yaml 写入 style",
            code == 200 and before_bytes == after_bytes and "style: wechat-ft" in yaml_text,
        )

        # 7. baseHash 409
        code, _ = api("POST", "/api/gzh/article/save", token, {
            "dir": str(FIXTURE), "markdown": "# 覆盖", "baseMdHash": "0" * 64,
        })
        report("baseHash 不匹配 409", code == 409)

        # 8. 路径逃逸 403
        outside = urllib.parse.quote(str(REPO))
        code, _ = api("GET", f"/api/gzh/article?dir={outside}", token)
        report("路径逃逸 403", code == 403)

        # 9. 保存后 check_state.py 仍可运行(style 新字段不破坏判定)
        r = subprocess.run(
            [sys.executable, str(REPO / "dev-examples/wx-article/scripts/draft_manager/check_state.py"), "--article-dir", str(FIXTURE)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
        )
        out = r.stdout + r.stderr
        report("check_state 兼容(style 字段不破坏)", r.returncode == 0 and "prepare_ready" in out, out.strip().splitlines()[-1] if out.strip() else "")

        # 10. 发布隔离:gzh API 面无任何 publish 端点(404 证明)
        code, _ = api("POST", "/api/gzh/publish", token, {"dir": str(FIXTURE)})
        report("预览面无 publish 端点(发布隔离)", code == 404)

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        md_fixture.write_bytes(md_backup)

    print(f"=== P0 SUITE DONE PASS={PASS} FAIL={FAIL} SKIP={SKIP} ===")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
