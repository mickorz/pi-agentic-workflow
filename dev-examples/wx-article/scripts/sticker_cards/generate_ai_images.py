#!/usr/bin/env python3
"""generate_ai_images.py —— 小绿书卡片 AI 生图路由执行器（T3，最小调用，零 LLM）。

架构约束（2026-11-06 评审定案）：
- 只实现小绿书需要的最小生图调用：读 pages.json 的 ai-image 页 -> 组装提示词 ->
  调 images/generations 端点 -> 校验产物 -> 回填 asset。不复制两阶段生图/风格审批/manifest 机制。
- 提示词确定性组装（页面语义 + 构图比例 + 负面约束），存档 _cards/prompts/NN.md 可追溯。
- 产物 _cards/assets/ai-NN.<ext> 稳定编号（页号），SUCCEEDED 不覆盖；单张失败不影响其他页。
- 结果验证：MIME magic bytes + image_dims 真实尺寸 + SHA256（完整 64 位）记入状态。

状态机（评审 P0-6 同构 + T3 收口扩展）：
  PENDING -> GENERATING -> {SUCCEEDED | FAILED | UNKNOWN}
  生成内部分两阶段（T3 收口 P0-2）：REQUESTING（付费请求）-> RESPONSE_RECEIVED（拿到
  b64/url）-> 下载与校验。请求失败 = FAILED（明确，可修复重跑）；**请求成功但下载/校验
  失败 = UNKNOWN（可能已扣费，保留 download_url 证据，禁止直接重付费）**。

UNKNOWN 恢复路径（按序尝试，全部失败则 HOLD 人工核对）：
  1. 确定性产物 ai-NN.* 已存在 -> 校验（含 expected_sha256 匹配）-> SUCCEEDED
  2. state.download_url 存在 -> 重新下载（不产生新付费）-> 校验 -> SUCCEEDED
  3. 人工核对：--mark-failed <no>（确认原请求未产生可用图片）-> FAILED（可重跑重试）

崩溃恢复（T3 收口 P0-1）：每页 GENERATING 记录 run_id；启动时发现 GENERATING 且 run_id
非本次运行 => 上次进程未收尾 => 转 UNKNOWN => 走恢复路径（避免重复扣费）。

费用授权边界：真实请求必须显式 --yes（工作流在付费 checkpoint 后传入）；
缺 --yes 时只打印计划（[DRY]）不发起任何请求。--max-images 单次上限（缺省 9 硬上限）。
降级不伪造：无配置/接口失败 -> 保存提示词与失败原因，状态 FAILED，绝不生成空白图。

端点约定（wechat_article_images branches.md 六节）：config.image_model.base_url 为完整端点，
P0 仅支持 `…/v1/images/generations` 模式（size 像素串；chat/completions 模式列 P1）。

CLI：
  python3 generate_ai_images.py --pages <pages.json> --cards-dir <article_dir/_cards>
      --config-dir <文章目录或其祖先（含 aws.env 与 .aws-article）>
      [--mock] [--yes] [--max-images N] [--inject add-timeout|add-errcode|dl-fail]
      [--mark-failed <no>]
输出契约：逐页 [OK]/[SKIP]/[HOLD]/[WARN]/[FAIL]；结尾：
  全部 SUCCEEDED -> "=== ALL DONE ===" 退出码 0
  存在 UNKNOWN   -> "=== DONE WITH UNKNOWN ===" 退出码 2（禁自动重试，人工核对）
  存在 FAILED    -> "=== DONE WITH FAILED ===" 退出码 1（可修复重跑）
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_dims import dims  # noqa: E402

MAX_IMAGES = 9
GEN_SIZE = "1080x1440"  # 小绿书 3:4
TIMEOUT_SECS = 120
ASSET_FMT = "_cards/assets/ai-{no:02d}{ext}"  # 产物名由页号确定性决定（UNKNOWN 恢复依据）
ASSET_EXTS = (".png", ".jpg", ".jpeg", ".gif")

# 状态机
PENDING, GENERATING, SUCCEEDED, FAILED, UNKNOWN = (
    "PENDING", "GENERATING", "SUCCEEDED", "FAILED", "UNKNOWN")


def _find_config(config_dir: Path) -> tuple[Path, Path] | None:
    """自 config_dir 向上找 aws.env 与 .aws-article/config.json。"""
    d = config_dir.resolve()
    while True:
        env, cfg = d / "aws.env", d / ".aws-article" / "config.json"
        if env.is_file() and cfg.is_file():
            return env, cfg
        if d.parent == d:
            return None
        d = d.parent


def _read_env(env_file: Path, key: str) -> str:
    for line in env_file.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == key:
            return v.strip()
    return ""


def _load_model_cfg(config_dir: Path) -> dict:
    """返回 {base_url, model, api_key}；缺凭证字段留空（上层显式降级）。"""
    found = _find_config(config_dir)
    if found is None:
        return {"base_url": "", "model": "", "api_key": ""}
    env_file, cfg_file = found
    try:
        model_cfg = json.loads(cfg_file.read_text(encoding="utf-8-sig")).get("image_model", {}) or {}
    except (json.JSONDecodeError, OSError):
        model_cfg = {}
    return {
        "base_url": (model_cfg.get("base_url") or "").strip(),
        "model": (model_cfg.get("model") or "").strip(),
        "api_key": _read_env(env_file, "IMAGE_MODEL_API_KEY"),
    }


def compose_prompt(raw_prompt: str, style_hint: str = "") -> str:
    """确定性组装：页面语义 + 构图比例 + 负面约束（+ 可选风格提示）。"""
    parts = [raw_prompt.strip()]
    if style_hint:
        parts.append(f"整体风格：{style_hint.strip()}。")
    parts.append(f"竖版 3:4 构图，输出 {GEN_SIZE} 像素，主体清晰居中，适合移动端整屏浏览。")
    parts.append("负面约束：画面中不要出现文字或水印，不要边框装饰，不要多格分镜拼图。")
    return "\n".join(parts)


def prompt_doc(no: int, page: dict, prompt: str, model_cfg: dict, mock: bool) -> str:
    """提示词存档文档（元数据 + 全文，无时间戳保证幂等）。"""
    head = [
        f"# 生图提示词 · 第 {no} 页",
        f"- 模型: {model_cfg.get('model') or '(未配置)'}" + ("（mock，不发真实请求）" if mock else ""),
        "- 端点模式: images/generations",
        f"- 尺寸: {GEN_SIZE}",
        f"- 页面角色: {page.get('role', 'ai-image')}",
        "",
    ]
    return "\n".join(head) + prompt + "\n"


def _post_images(endpoint: str, api_key: str, model: str, prompt: str,
                 inject: str | None) -> dict:
    """付费请求阶段。返回 {b64_json|url}；网络异常抛 TimeoutError；明确错误抛 RuntimeError。"""
    if inject == "add-timeout":
        raise TimeoutError("mock timeout")
    if inject == "add-errcode":
        raise RuntimeError("mock api error 40007")
    if inject == "dl-fail":
        return {"url": "http://127.0.0.1:9/x.png"}  # 请求"成功"返回不可达 URL，模拟下载失败
    body = json.dumps({"model": model, "prompt": prompt, "n": 1,
                       "size": GEN_SIZE, "response_format": "b64_json"}).encode("utf-8")
    req = urllib.request.Request(
        endpoint, data=body, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8",
                 "Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECS) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    item = (data.get("data") or [{}])[0]
    if not item.get("b64_json") and not item.get("url"):
        raise RuntimeError(f"response missing b64_json/url: {str(data)[:200]}")
    return item


def _fetch_image_bytes(item: dict) -> bytes:
    """下载阶段（仅 url 响应需要；不产生新付费）。失败抛 URLError/OSError/TimeoutError。"""
    if item.get("b64_json"):
        return base64.b64decode(item["b64_json"])
    req = urllib.request.Request(item["url"], headers={"User-Agent": "sticker-cards/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECS) as resp:
        return resp.read()


def _sniff_ext(raw: bytes) -> str:
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if raw[:2] == b"\xff\xd8":
        return ".jpg"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    return ".bin"


def _verify_and_save(raw: bytes, asset_path: Path) -> dict:
    """MIME + 真实尺寸校验，原子保存产物，返回完整 SHA256 与尺寸。解析失败抛 ValueError。"""
    ext = _sniff_ext(raw)
    if ext == ".bin":
        raise ValueError(f"未知图片格式（magic bytes 不识别），前 8 字节 {raw[:8]!r}")
    tmp = asset_path.with_suffix(".tmp")
    tmp.write_bytes(raw)
    real = asset_path.with_suffix(ext)
    os.replace(str(tmp), str(real))  # Windows 下 rename 对已存在目标会抛错，用原子替换
    try:
        info = dims(real)
    except ValueError:
        real.unlink()
        raise
    return {"ext": ext, "width": info["display"]["width"], "height": info["display"]["height"],
            "sha256": hashlib.sha256(raw).hexdigest()}  # 完整 64 位（T3 收口 P0-3）


def _save_state(state: dict, state_path: Path) -> None:
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


def _load_state(state_path: Path) -> dict:
    if state_path.is_file():
        return json.loads(state_path.read_text(encoding="utf-8"))
    return {"pages": {}}


def _recover_unknown(st: dict, no: int, cards_dir: Path) -> str:
    """UNKNOWN 恢复（T3 收口）。返回 SUCCEEDED / HOLD / RETRY_DOWNLOAD 三种判定。

    顺序：确定性产物扫描（expected_sha256 有则必须匹配）-> download_url 重试 -> HOLD。
    """
    asset = st.get("asset")
    candidates: list[Path] = []
    if asset:
        candidates.append(cards_dir.parent / asset)
    candidates += [cards_dir.parent / ASSET_FMT.format(no=no, ext=e) for e in ASSET_EXTS]
    for cand in candidates:
        if cand.is_file():
            try:
                info = _verify_and_save(cand.read_bytes(), cand)
            except (ValueError, OSError):
                continue  # 损坏/不完整文件不算恢复成功
            expected = st.get("expected_sha256")
            if expected and info["sha256"] != expected:
                st["error"] = f"产物 SHA256 与预期不符（expected={expected[:16]}...）"
                return "HOLD"
            st["status"] = SUCCEEDED
            st["asset"] = ASSET_FMT.format(no=no, ext=info["ext"])
            st["sha256"] = info["sha256"]
            st["size"] = f"{info['width']}x{info['height']}"
            st["error"] = None
            return "SUCCEEDED"
    if st.get("download_url"):
        return "RETRY_DOWNLOAD"
    return "HOLD"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", required=True)
    ap.add_argument("--cards-dir", required=True, help="article_dir/_cards")
    ap.add_argument("--config-dir", required=True)
    ap.add_argument("--mock", action="store_true", help="零费用零网络：fixture 图直接落为产物")
    ap.add_argument("--yes", action="store_true", help="授权真实付费请求；缺省 [DRY] 只打印计划")
    ap.add_argument("--max-images", type=int, default=MAX_IMAGES, help="单次生成张数上限")
    ap.add_argument("--inject", default=None,
                    choices=["add-timeout", "add-errcode", "dl-fail"], help="故障注入（仅测试）")
    ap.add_argument("--mark-failed", default=None,
                    help="人工确认 UNKNOWN 页未产生可用图片（且接受可能已扣费的账单核对责任），"
                         "转 FAILED（可重跑重试），如 --mark-failed 3")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    cards_dir = Path(args.cards_dir)
    pages_path = Path(args.pages)
    state_path = cards_dir / "aigen-state.json"
    prompts_dir = cards_dir / "prompts"
    assets_dir = cards_dir / "assets"
    prompts_dir.mkdir(parents=True, exist_ok=True)
    assets_dir.mkdir(parents=True, exist_ok=True)

    data = json.loads(pages_path.read_text(encoding="utf-8-sig"))
    ai_pages = [p for p in data.get("pages", []) if p.get("source") == "ai-image"]
    if not ai_pages:
        print("[SKIP] 无 ai-image 页面，无事可做")
        print("=== ALL DONE ===")
        return 0

    state = _load_state(state_path)
    run_id = f"r{time.strftime('%Y%m%d%H%M%S')}-{os.getpid()}"
    model_cfg = _load_model_cfg(Path(args.config_dir))

    # --mark-failed：人工确认 UNKNOWN -> FAILED
    if args.mark_failed:
        st = state["pages"].get(str(args.mark_failed))
        if st and st.get("status") == UNKNOWN:
            st["status"] = FAILED
            st["error"] = "人工确认未产生可用图片（--mark-failed；账单请按服务后台核对）"
            _save_state(state, state_path)
            print(f"[OK] 页 {args.mark_failed}: UNKNOWN -> FAILED（可重跑重试）")
            print("=== DONE WITH FAILED ===")
            return 1
        print(f"[FAIL] 页 {args.mark_failed} 不存在或状态不是 UNKNOWN")
        return 1

    # 崩溃恢复（T3 收口 P0-1）：GENERATING 且非本次 run => 上次进程未收尾 => UNKNOWN
    for no, st in state["pages"].items():
        if st.get("status") == GENERATING and st.get("run_id") != run_id:
            st["status"] = UNKNOWN
            st["error"] = f"上次运行崩溃（GENERATING 未收尾 run={st.get('run_id')}），转 UNKNOWN 待恢复"
            print(f"[WARN] 页 {no}: 检测到上次运行崩溃残留 GENERATING，已转 UNKNOWN 走恢复路径")
    if any(st.get("status") == UNKNOWN and "崩溃" in (st.get("error") or "")
           for st in state["pages"].values()):
        _save_state(state, state_path)  # 转换落盘，防再次崩溃丢失

    # 提示词组装与存档（确定性；PENDING/FAILED/UNKNOWN 均刷新，保证可追溯）
    for page in ai_pages:
        no = page["no"]
        prompt = compose_prompt(page["prompt"], data.get("content", ""))
        (prompts_dir / f"{no:02d}.md").write_text(
            prompt_doc(no, page, prompt, model_cfg, args.mock), encoding="utf-8")
    print(f"[OK] 提示词存档 {len(ai_pages)} 份 -> {prompts_dir}")

    # 待生成集合（UNKNOWN 不自动重试：走恢复路径）
    todo: list[dict] = []
    for page in ai_pages:
        no = str(page["no"])
        st = state["pages"].setdefault(no, {"status": PENDING, "attempts": 0})
        status = st.get("status", PENDING)
        if status == SUCCEEDED and st.get("asset") and (cards_dir.parent / st["asset"]).is_file():
            print(f"[SKIP] 页 {page['no']}: 已 SUCCEEDED（不覆盖成功产物）")
            continue
        if status == UNKNOWN:
            verdict = _recover_unknown(st, int(no), cards_dir)
            if verdict == "SUCCEEDED":
                print(f"[OK] 页 {page['no']}: UNKNOWN -> SUCCEEDED（恢复校验通过，无需重新付费）")
                continue
            if verdict == "RETRY_DOWNLOAD":
                # 恢复下载：只重新拉取已扣费响应的 URL，绝不重新发付费请求
                try:
                    raw = _fetch_image_bytes({"url": st["download_url"]})
                    asset_rel = ASSET_FMT.format(no=int(no), ext=_sniff_ext(raw))
                    info = _verify_and_save(raw, cards_dir.parent / asset_rel)
                    expected = st.get("expected_sha256")
                    if expected and info["sha256"] != expected:
                        raise ValueError("产物 SHA256 与响应预期不符")
                    st.update(status=SUCCEEDED, asset=asset_rel, sha256=info["sha256"],
                              size=f"{info['width']}x{info['height']}", error=None)
                    print(f"[OK] 页 {page['no']}: 恢复下载成功 -> SUCCEEDED")
                    continue
                except (urllib.error.URLError, urllib.error.HTTPError, OSError,
                        TimeoutError, RuntimeError, ValueError) as e:
                    st["error"] = f"恢复下载仍失败（不重新付费，保留 URL 证据）: {e}"
                    print(f"[HOLD] 页 {page['no']}: 恢复下载仍失败，保持 UNKNOWN；"
                          f"人工核对后 --mark-failed {page['no']}")
                    continue
            print(f"[HOLD] 页 {page['no']}: UNKNOWN（{st.get('error') or '上次请求结果不明，可能已扣费'}）。"
                  f"人工核对后：产物存在 -> 重跑自动确认；未产生 -> --mark-failed {page['no']}")
            continue
        todo.append(page)
    _save_state(state, state_path)

    if not todo:
        return _finish(state, state_path)

    # 预算边界：单次上限截断（多余页保留下次）
    if len(todo) > args.max_images:
        dropped = todo[args.max_images:]
        todo = todo[:args.max_images]
        print(f"[WARN] 待生成 {len(todo) + len(dropped)} 张超过单次上限 {args.max_images}，"
              f"本次只做前 {len(todo)} 张（页号 {'、'.join(str(p['no']) for p in dropped)} 保留下次）")

    # 计划展示（评审：模型/张数/预算可见；skip_confirm 不隐式授权付费）
    print(f"[计划] 模型={model_cfg.get('model') or '(未配置)'} "
          f"张数={len(todo)}（页号 {'、'.join(str(p['no']) for p in todo)}） 尺寸={GEN_SIZE}"
          + (" 模式=mock（零费用）" if args.mock else " 模式=真实（按服务计费）"))

    if args.mock:
        mock_src = Path(__file__).parent / "fixtures" / "_cards" / "assets" / "shot-01.png"
        if not mock_src.is_file():
            print(f"[FAIL] mock fixture 缺失: {mock_src}")
            return 1
        for page in todo:
            no = str(page["no"])
            asset_rel = ASSET_FMT.format(no=int(no), ext=".png")
            raw = mock_src.read_bytes()
            info = _verify_and_save(raw, cards_dir.parent / asset_rel)
            st = state["pages"].setdefault(no, {"status": PENDING, "attempts": 0})
            st.update(status=SUCCEEDED, asset=asset_rel, sha256=info["sha256"],
                      size=f"{info['width']}x{info['height']}", error=None, mock=True,
                      run_id=run_id)
            print(f"[OK] 页 {page['no']}: mock 产物 {asset_rel} "
                  f"{info['width']}x{info['height']} sha256={info['sha256'][:16]}...")
        return _finish(state, state_path)

    # 真实模式：配置完整性与授权检查
    missing = [k for k, v in model_cfg.items() if not v]
    if missing:
        for page in todo:
            st = state["pages"].setdefault(str(page["no"]), {"status": PENDING, "attempts": 0})
            st["status"] = FAILED
            st["error"] = f"生图配置缺失: {missing}（提示词已存档，配置后重跑）"
        print(f"[FAIL] 生图配置缺失 {missing}：提示词已保留，状态记 FAILED（配置后重跑，不伪造图片）")
        return _finish(state, state_path, force_code=1)
    if not args.yes:
        print("[DRY] 未传 --yes，不发起任何付费请求。确认后重跑并加 --yes。")
        return _finish(state, state_path)

    endpoint = model_cfg["base_url"]
    exit_hint = 0
    for page in todo:
        no = str(page["no"])
        st = state["pages"].setdefault(no, {"status": PENDING, "attempts": 0})
        prompt = compose_prompt(page["prompt"], data.get("content", ""))
        st["status"] = GENERATING
        st["attempts"] = st.get("attempts", 0) + 1
        st["model"] = model_cfg["model"]
        st["run_id"] = run_id
        _save_state(state, state_path)
        try:
            # 阶段一：付费请求（失败=FAILED 明确失败，可修复重跑）
            item = _post_images(endpoint, model_cfg["api_key"], model_cfg["model"],
                                prompt, args.inject)
        except TimeoutError as e:
            st["status"] = UNKNOWN
            st["error"] = f"请求超时（可能已扣费，禁止自动重试）: {e}"
            exit_hint = 2
            _save_state(state, state_path)
            print(f"[HOLD] 页 {page['no']}: 请求超时 -> UNKNOWN（先核对后台/账单，勿直接重试）")
            continue
        except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError) as e:
            st["status"] = FAILED
            st["error"] = f"请求明确失败: {e}"
            if exit_hint == 0:
                exit_hint = 1
            _save_state(state, state_path)
            print(f"[FAIL] 页 {page['no']}: 请求明确失败（可修复后重跑）: {str(e)[:200]}")
            continue

        # 阶段二：下载与校验（请求已成功，可能已扣费——失败一律 UNKNOWN 不重付费）
        st["response_kind"] = "b64_json" if item.get("b64_json") else "url"
        if item.get("url"):
            st["download_url"] = item["url"]
        expected = None
        try:
            if item.get("b64_json"):
                expected = hashlib.sha256(base64.b64decode(item["b64_json"])).hexdigest()
            st["expected_sha256"] = expected
            _save_state(state, state_path)
            raw = _fetch_image_bytes(item)
            asset_rel = ASSET_FMT.format(no=int(no), ext=_sniff_ext(raw))
            info = _verify_and_save(raw, cards_dir.parent / asset_rel)
            if expected and info["sha256"] != expected:
                raise ValueError(f"产物 SHA256 与响应预期不符")
            st.update(status=SUCCEEDED, asset=asset_rel, sha256=info["sha256"],
                      size=f"{info['width']}x{info['height']}", error=None)
            _save_state(state, state_path)
            print(f"[OK] 页 {page['no']}: {asset_rel} {info['width']}x{info['height']} "
                  f"sha256={info['sha256'][:16]}...")
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, TimeoutError,
                RuntimeError, ValueError) as e:
            st["status"] = UNKNOWN
            st["error"] = (f"生成请求已成功但下载/校验失败（可能已扣费，禁止重新付费）: {e}"
                           + ("；保留 download_url 可恢复" if st.get("download_url") else ""))
            exit_hint = 2
            _save_state(state, state_path)
            print(f"[HOLD] 页 {page['no']}: 下载/校验失败 -> UNKNOWN"
                  + ("（保留 download_url，重跑自动恢复）" if st.get("download_url") else ""))

    return _finish(state, state_path, force_code=exit_hint)


def _finish(state: dict, state_path: Path, force_code: int | None = None) -> int:
    """按终态汇总退出码：UNKNOWN=2 优先（禁自动重试）> FAILED=1 > ALL DONE=0。"""
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


if __name__ == "__main__":
    sys.exit(main())
