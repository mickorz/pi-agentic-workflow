#!/usr/bin/env python3
"""generate_ai_images.py —— 小绿书卡片 AI 生图路由执行器（T3 v2：image-use 通道，零 API key）。

v2 改造（2026-11-06 用户定案）：AI 生图走现有 image_gen 执行器的 **image-use provider**
（chrome-use 驱动已登录浏览器 + ChatGPT 订阅 web 后端，零 API 计费，不需要 IMAGE_MODEL_API_KEY）。
本脚本只做确定性编排：
  1. 读 pages.json 的 ai-image 页 -> 确定性组装提示词 -> 存档 _cards/prompts/NN.md
  2. 组装 <article_dir>/image-prompts.json（image_gen 执行器唯一输入，D6 契约）
  3. 调 node image_gen/generate.mjs --provider image-use --mode batch
     （IMAGE_GEN_SIZE=1080x1440；执行器自带断点续跑/失败分类/UNKNOWN/扣费不确定保护）
  4. 读 image-manifest.json -> 产物校验（MIME/尺寸/SHA256）-> 复制到 _cards/assets/ai-NN.<ext>
     -> 回填 state.asset -> verify 可用

状态机（与 T3 v1 同构）：PENDING -> GENERATING -> {SUCCEEDED | FAILED | UNKNOWN}
  UNKNOWN = image-use 侧无法证明未提交（可能已消耗订阅配额）：禁止自动重试。
  恢复路径：确定性产物 ai-NN.* 已存在且校验通过 -> SUCCEEDED；
  否则人工核对后 --mark-failed <no>（转 FAILED 可重跑）或用执行器
  `--resolve-unknown <id>:<outcome>` 处理上游状态后再重跑。

费用授权边界：真实生成必须显式 --yes（工作流在付费 checkpoint 后传入）；
缺 --yes 时 --dry-run 只打印计划。--max-images 单次上限（缺省 9 硬上限）。
降级不伪造：执行器缺失/失败 -> 保存提示词与失败原因，状态 FAILED，绝不生成空白图。
Mock：--mock 直接落 fixture 产物（零费用零网络零 LLM）。

CLI：
  python3 generate_ai_images.py --pages <pages.json> --cards-dir <article_dir/_cards>
      --article-dir <article_dir>       # image_gen 执行器的工作目录（imgs/ 落产物）
      [--mock] [--yes] [--dry-run] [--max-images N]
      [--mark-failed <no>] [--inject add-timeout]
输出契约：逐页 [OK]/[SKIP]/[HOLD]/[WARN]/[FAIL]；结尾：
  全部 SUCCEEDED -> "=== ALL DONE ===" 退出码 0
  存在 UNKNOWN   -> "=== DONE WITH UNKNOWN ===" 退出码 2
  存在 FAILED    -> "=== DONE WITH FAILED ===" 退出码 1
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_dims import dims  # noqa: E402

MAX_IMAGES = 9
GEN_SIZE = "1080x1440"
ASSET_FMT = "_cards/assets/ai-{no:02d}{ext}"  # 产物名由页号确定性决定（UNKNOWN 恢复依据）
ASSET_EXTS = (".png", ".jpg", ".jpeg", ".gif")
RUNNER_TIMEOUT = 600  # image-use 单张预算 330s，多张执行器串行——外层宽限

# 状态机
PENDING, GENERATING, SUCCEEDED, FAILED, UNKNOWN = (
    "PENDING", "GENERATING", "SUCCEEDED", "FAILED", "UNKNOWN")


def compose_prompt(raw_prompt: str, style_hint: str = "") -> str:
    """确定性组装：页面语义 + 构图比例 + 负面约束（+ 可选风格提示）。"""
    parts = [raw_prompt.strip()]
    if style_hint:
        parts.append(f"整体风格：{style_hint.strip()}。")
    parts.append(f"竖版 3:4 构图，输出 {GEN_SIZE} 像素，主体清晰居中，适合移动端整屏浏览。")
    parts.append("负面约束：画面中不要出现文字或水印，不要边框装饰，不要多格分镜拼图。")
    return "\n".join(parts)


def prompt_doc(no: int, page: dict, prompt: str, mock: bool) -> str:
    head = [
        f"# 生图提示词 · 第 {no} 页",
        "- 通道: image-use（chrome-use + ChatGPT 订阅 web，零 API 计费）" + ("（mock，不发真实请求）" if mock else ""),
        f"- 尺寸: {GEN_SIZE}",
        f"- 页面角色: {page.get('role', 'ai-image')}",
        "",
    ]
    return "\n".join(head) + prompt + "\n"


def _sniff_ext(raw: bytes) -> str:
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if raw[:2] == b"\xff\xd8":
        return ".jpg"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    return ".bin"


def _verify_and_save(raw: bytes, asset_path: Path) -> dict:
    """MIME + 真实尺寸校验，原子保存产物，返回完整 SHA256 与尺寸。失败抛 ValueError。"""
    ext = _sniff_ext(raw)
    if ext == ".bin":
        raise ValueError(f"未知图片格式（magic bytes 不识别），前 8 字节 {raw[:8]!r}")
    tmp = asset_path.with_suffix(".tmp")
    tmp.write_bytes(raw)
    real = asset_path.with_suffix(ext)
    os.replace(str(tmp), str(real))  # Windows rename 不覆盖，用原子替换
    try:
        info = dims(real)
    except ValueError:
        real.unlink()
        raise
    return {"ext": ext, "width": info["display"]["width"], "height": info["display"]["height"],
            "sha256": hashlib.sha256(raw).hexdigest()}  # 完整 64 位


def _save_state(state: dict, state_path: Path) -> None:
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


def _load_state(state_path: Path) -> dict:
    if state_path.is_file():
        return json.loads(state_path.read_text(encoding="utf-8"))
    return {"pages": {}}


def _finish(state: dict, state_path: Path, force_code: int | None = None) -> int:
    _save_state(state, state_path)
    print("[6] state saved")
    statuses = [p.get("status") for p in state.get("pages", {}).values()]
    if UNKNOWN in statuses or force_code == 2:
        print("=== DONE WITH UNKNOWN ===")
        return 2
    if FAILED in statuses or force_code == 1:
        print("=== DONE WITH FAILED ===")
        return 1
    print("=== ALL DONE ===")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", required=True)
    ap.add_argument("--cards-dir", required=True, help="article_dir/_cards")
    ap.add_argument("--article-dir", required=True, help="article_dir（image_gen 执行器工作目录）")
    ap.add_argument("--mock", action="store_true", help="零费用零网络：fixture 图直接落为产物")
    ap.add_argument("--yes", action="store_true", help="授权真实生成（消耗 ChatGPT 订阅配额）；缺省 [DRY]")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划（等价缺省行为，显式化用）")
    ap.add_argument("--max-images", type=int, default=MAX_IMAGES, help="单次生成张数上限")
    ap.add_argument("--inject", default=None, choices=["add-timeout"], help="故障注入（仅测试）")
    ap.add_argument("--mark-failed", default=None,
                    help="人工确认 UNKNOWN 页未产生可用图片，转 FAILED（可重跑）")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    cards_dir = Path(args.cards_dir)
    article_dir = Path(args.article_dir)
    state_path = cards_dir / "aigen-state.json"
    prompts_dir = cards_dir / "prompts"
    assets_dir = cards_dir / "assets"
    prompts_dir.mkdir(parents=True, exist_ok=True)
    assets_dir.mkdir(parents=True, exist_ok=True)

    data = json.loads(Path(args.pages).read_text(encoding="utf-8-sig"))
    ai_pages = [p for p in data.get("pages", []) if p.get("source") == "ai-image"]
    if not ai_pages:
        print("[SKIP] 无 ai-image 页面，无事可做")
        print("=== ALL DONE ===")
        return 0

    state = _load_state(state_path)

    # --mark-failed：人工确认 UNKNOWN -> FAILED
    if args.mark_failed:
        st = state["pages"].get(str(args.mark_failed))
        if st and st.get("status") == UNKNOWN:
            st["status"] = FAILED
            st["error"] = "人工确认未产生可用图片（--mark-failed；配额消耗请按 ChatGPT 后台核对）"
            _save_state(state, state_path)
            print(f"[OK] 页 {args.mark_failed}: UNKNOWN -> FAILED（可重跑重试）")
            print("=== DONE WITH FAILED ===")
            return 1
        print(f"[FAIL] 页 {args.mark_failed} 不存在或状态不是 UNKNOWN")
        return 1

    # 提示词组装与存档（确定性）
    for page in ai_pages:
        no = page["no"]
        prompt = compose_prompt(page["prompt"], data.get("content", ""))
        (prompts_dir / f"{no:02d}.md").write_text(
            prompt_doc(no, page, prompt, args.mock), encoding="utf-8")
    print(f"[OK] 提示词存档 {len(ai_pages)} 份 -> {prompts_dir}")

    # UNKNOWN 恢复（确定性产物扫描，P0 同 T3 v1）
    todo: list[dict] = []
    for page in ai_pages:
        no = str(page["no"])
        st = state["pages"].setdefault(no, {"status": PENDING, "attempts": 0})
        status = st.get("status", PENDING)
        if status == SUCCEEDED and st.get("asset") and (article_dir / st["asset"]).is_file():
            print(f"[SKIP] 页 {page['no']}: 已 SUCCEEDED（不覆盖成功产物）")
            continue
        if status == UNKNOWN:
            recovered = None
            for ext in ASSET_EXTS:
                cand = article_dir / ASSET_FMT.format(no=int(no), ext=ext)
                if cand.is_file():
                    recovered = cand
                    break
            if recovered is not None:
                try:
                    info = _verify_and_save(recovered.read_bytes(), recovered)
                    expected = st.get("expected_sha256")
                    if expected and info["sha256"] != expected:
                        raise ValueError("产物 SHA256 与预期不符")
                    st.update(status=SUCCEEDED, asset=ASSET_FMT.format(no=int(no), ext=info["ext"]),
                              sha256=info["sha256"], size=f"{info['width']}x{info['height']}", error=None)
                    print(f"[OK] 页 {page['no']}: UNKNOWN -> SUCCEEDED（产物已存在且校验通过，无需重新生成）")
                    continue
                except (ValueError, OSError):
                    pass
            print(f"[HOLD] 页 {page['no']}: UNKNOWN（上游无法证明未提交，可能已消耗配额）。"
                  f"人工核对后：产物存在 -> 重跑自动确认；未产生 -> --mark-failed {page['no']}；"
                  f"或用 image_gen --resolve-unknown 处理上游状态")
            continue
        todo.append(page)
    _save_state(state, state_path)

    if not todo:
        return _finish(state, state_path)

    # 预算边界：单次上限截断（多余页保留下次，items 只写截断后的）
    if len(todo) > args.max_images:
        dropped = todo[args.max_images:]
        todo = todo[:args.max_images]
        print(f"[WARN] 待生成 {len(todo) + len(dropped)} 张超过单次上限 {args.max_images}，"
              f"本次只做前 {len(todo)} 张（页号 {'、'.join(str(p['no']) for p in dropped)} 保留下次）")

    # 组装 image-prompts.json（image_gen 执行器唯一输入，schema v1）
    items = []
    for page in todo:
        no = int(page["no"])
        items.append({
            "id": f"ai-{no:02d}",
            "kind": "body",
            "filename": f"ai-{no:02d}.png",
            "heading": page.get("role", "ai-image"),
            "prompt": compose_prompt(page["prompt"], data.get("content", "")),
        })
    prompts_doc = {
        "version": 1,
        "article_id": f"sticker-cards-{article_dir.resolve().name}",
        "style_prefix": "",
        "items": items,
    }
    prompts_json = article_dir / "image-prompts.json"
    prompts_json.write_text(json.dumps(prompts_doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[计划] 通道=image-use（chrome-use + ChatGPT 订阅 web，零 API 计费） "
          f"张数={len(todo)}（页号 {'、'.join(str(p['no']) for p in todo)}） 尺寸={GEN_SIZE}"
          + (" 模式=mock（零费用）" if args.mock else " 模式=真实（消耗 ChatGPT 订阅配额）"))
    print(f"[OK] image-prompts.json -> {prompts_json}")

    if args.mock:
        mock_src = Path(__file__).parent / "fixtures" / "_cards" / "assets" / "shot-01.png"
        raw = mock_src.read_bytes()
        for page in todo:
            no = str(page["no"])
            asset_rel = ASSET_FMT.format(no=int(no), ext=".png")
            info = _verify_and_save(raw, article_dir / asset_rel)
            st = state["pages"].setdefault(no, {"status": PENDING, "attempts": 0})
            st.update(status=SUCCEEDED, asset=asset_rel, sha256=info["sha256"],
                      size=f"{info['width']}x{info['height']}", error=None, mock=True,
                      model="image-use/web(mock)")
            print(f"[OK] 页 {page['no']}: mock 产物 {asset_rel} sha256={info['sha256'][:16]}...")
        return _finish(state, state_path)

    if args.dry_run or not args.yes:
        print("[DRY] 未传 --yes，不发起生成（不消耗订阅配额）。确认后重跑并加 --yes。")
        return _finish(state, state_path)

    # 真实生成：调 image_gen 执行器（参数数组直传，不经 shell）
    gen_mjs = Path(__file__).resolve().parents[1] / "image_gen" / "generate.mjs"
    if not gen_mjs.is_file():
        for page in todo:
            st = state["pages"].setdefault(str(page["no"]), {"status": PENDING, "attempts": 0})
            st["status"] = FAILED
            st["error"] = f"image_gen 执行器缺失: {gen_mjs}"
        print(f"[FAIL] image_gen 执行器缺失（提示词已存档，不伪造图片）: {gen_mjs}")
        return _finish(state, state_path, force_code=1)
    if args.inject == "add-timeout":
        # 测试注入：把执行器替换为不存在的 provider 触发明确失败前的挂起语义不可行，
        # 改为注入"产物永不出现"——直接标 UNKNOWN（与 v1 语义一致，人工恢复路径可测）
        for page in todo:
            st = state["pages"].setdefault(str(page["no"]), {"status": PENDING, "attempts": 0})
            st["status"] = UNKNOWN
            st["error"] = "注入 add-timeout：视作上游结果不明（可能已消耗配额，禁止自动重试）"
        print("[HOLD] 注入超时 -> 全部待生成页 UNKNOWN")
        return _finish(state, state_path, force_code=2)

    env = {**os.environ, "IMAGE_GEN_SIZE": GEN_SIZE}
    cmd = [node_bin(), str(gen_mjs), "--article-dir", str(article_dir),
           "--provider", "image-use", "--mode", "batch"]
    print("[生成] 调用 image_gen 执行器（image-use 通道，chrome-use 驱动浏览器，单张预算约 330s）")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=RUNNER_TIMEOUT * len(todo) + 120, env=env)
    except subprocess.TimeoutExpired:
        for page in todo:
            st = state["pages"].setdefault(str(page["no"]), {"status": PENDING, "attempts": 0})
            if st["status"] in (PENDING, GENERATING):
                st["status"] = UNKNOWN
                st["error"] = "执行器整体超时（上游结果不明，可能已消耗配额，禁止自动重试）"
        print("[HOLD] 执行器超时 -> 待生成页 UNKNOWN")
        return _finish(state, state_path, force_code=2)
    tail = "\n".join(r.stdout.splitlines()[-10:])
    print(tail)
    if r.stderr.strip():
        print("[执行器 stderr 尾] " + r.stderr.strip()[-300:])

    # 读 manifest 回填状态
    manifest_path = article_dir / "image-manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        for page in todo:
            st = state["pages"].setdefault(str(page["no"]), {"status": PENDING, "attempts": 0})
            st["status"] = UNKNOWN
            st["error"] = f"image-manifest.json 读取失败（上游结果不明）: {e}"
        print("[HOLD] manifest 读取失败 -> 待生成页 UNKNOWN")
        return _finish(state, state_path, force_code=2)
    entries = {(e.get("id")): e for e in manifest.get("entries", {}).values()} \
        if isinstance(manifest.get("entries"), dict) else \
        {e.get("id"): e for e in manifest.get("entries", [])}
    exit_hint = 0
    for page in todo:
        no = str(page["no"])
        item_id = f"ai-{int(no):02d}"
        entry = entries.get(item_id)
        st = state["pages"].setdefault(no, {"status": PENDING, "attempts": 0})
        if entry is None:
            st["status"] = UNKNOWN
            st["error"] = "manifest 无该条目（上游结果不明）"
            exit_hint = 2
            print(f"[HOLD] 页 {page['no']}: manifest 无条目 -> UNKNOWN")
            continue
        cands = entry.get("candidates") or []
        cur = cands[-1] if cands else entry
        cstatus = cur.get("status") or entry.get("status")
        if cstatus == "ok":
            src_path = article_dir / (cur.get("path") or entry.get("path", ""))
            if not src_path.is_file():
                st["status"] = UNKNOWN
                st["error"] = f"manifest 记 ok 但产物缺失: {src_path.name}"
                exit_hint = 2
                print(f"[HOLD] 页 {page['no']}: 产物缺失 -> UNKNOWN")
                continue
            raw = src_path.read_bytes()
            asset_rel = ASSET_FMT.format(no=int(no), ext=_sniff_ext(raw))
            info = _verify_and_save(raw, article_dir / asset_rel)
            st.update(status=SUCCEEDED, asset=asset_rel, sha256=info["sha256"],
                      size=f"{info['width']}x{info['height']}", error=None,
                      model=f"image-use/{entry.get('model', 'web')}")
            print(f"[OK] 页 {page['no']}: {asset_rel} {info['width']}x{info['height']} "
                  f"sha256={info['sha256'][:16]}...")
        elif cstatus == "unknown":
            st["status"] = UNKNOWN
            st["error"] = "上游无法证明未提交（可能已消耗配额）；用 image_gen --resolve-unknown 或 --mark-failed"
            exit_hint = 2
            print(f"[HOLD] 页 {page['no']}: 上游 UNKNOWN（人工核对 ChatGPT 会话后处理）")
        else:  # failed / pending / 其他
            st["status"] = FAILED
            st["error"] = f"执行器状态 {cstatus}: {str(cur.get('error') or entry.get('error'))[:160]}"
            if exit_hint == 0:
                exit_hint = 1
            print(f"[FAIL] 页 {page['no']}: 执行器状态 {cstatus}（可修复后重跑）")
        _save_state(state, state_path)

    return _finish(state, state_path, force_code=exit_hint)


def node_bin() -> str:
    for c in ("node",):
        try:
            r = subprocess.run([c, "-v"], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                return c
        except (OSError, subprocess.TimeoutExpired):
            pass
    raise RuntimeError("node 不可用（image_gen 执行器需要 node）")


if __name__ == "__main__":
    sys.exit(main())
