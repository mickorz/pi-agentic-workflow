#!/usr/bin/env python3
"""components.py —— 小绿书卡片版式组件表（唯一事实来源）。

validate_pages.py（校验器）与 build_html.py（注入器）共用本模块：
- 新增版式 = 在 COMPONENTS 加一个条目（required/optional 字段规格 + render 函数），
  校验与注入自动跟随，不各自维护枚举（方案 2026-11-05 V1.1 评审 P0-2/P0-4 定案）。

字段规格说明：
- required / optional：点路径 -> 期望 python 类型（str/list/dict），缺 required 即 FAIL
- points_range：list 字段的长度边界（仅对名为 copy.points 的字段生效）
- image_fit：截图类组件的缩放策略；screenshot 组件强制 contain（UI 截图禁 cover，D8）
- render(page, page_no, article_root)：返回画板内部 HTML（固定片段，文本一律经 esc() 转义；
  片段不写任何 margin/定位样式，画板从整数 0,0 开始 —— T0 经验：分数坐标截图差 1px）

标记约定：
- asset 路径一律相对文章目录，必须以 "_cards/assets/" 开头（防路径逃逸，构建时转成 "assets/"）
- 画板 id 固定 "xhs-{no:02d}"，render.mjs 按元素 id 命名产物，T4 规范化按页号映射
"""
from __future__ import annotations

import html as _html
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_dims import dims as _image_dims  # noqa: E402

NL = "\n"  # 片段内 HTML 行分隔（真实换行符；写进生成文件保持可读）


def esc(text: str) -> str:
    """HTML 转义（含引号）。所有进入 HTML 的文本必须经过本函数。"""
    return _html.escape(str(text), quote=True)


def esc_multiline(text: str) -> str:
    """同 esc，但保留多行（换行 -> <br>）。"""
    return esc(text).replace("\r\n", "<br>").replace("\n", "<br>")


def asset_src(asset: str) -> str:
    """pages.json 的 asset 路径 -> HTML src（index.html 位于 _cards/ 下）。"""
    return asset[len("_cards/"):]


def poster_open(page_no: int) -> str:
    return f'    <section class="poster xhs" id="xhs-{page_no:02d}">' + NL


POSTER_CLOSE = "    </section>" + NL

KICKERS = {
    "cover": "封面 · Cover",
    "point": "要点 · Point",
    "evidence": "实证 · Evidence",
    "checklist": "清单 · Checklist",
    "quote": "引言 · Quote",
}

# 图框纵横比（gz-figure data-ratio 合法值；units 宽/高，用于 manual-crop 几何）
WELL_RATIOS = {
    "16x9": 16 / 9, "16x10": 16 / 10, "4x3": 4 / 3, "3x2": 3 / 2,
    "1x1": 1.0, "3x4": 3 / 4, "21x9": 21 / 9,
}


def _kicker(label: str) -> str:
    return f'      <p class="kicker">{esc(label)}</p>' + NL


# ---------------------------------------------------------------- 组件渲染 --
# 片段只使用种子模板已有 class（gz-components.md 为准），双模板（editorial/swiss）通用。


def _render_cover(page: dict, page_no: int, article_root: Path | None = None) -> str:
    """封面钩子页：gz-cover 体系；标题按行数字自适应（--chars = 最长行字数 + 0.1）。"""
    copy = page["copy"]
    title = copy["title"]
    points = copy["points"]
    emphasis = page.get("emphasis") or ""
    lines = title.split("\n")
    chars = f"{max(len(ln) for ln in lines) + 0.1:.2f}"
    sub = f'      <p class="gz-cover__sub gz-t-lead">{esc(emphasis)}</p>' + NL if emphasis else ""
    meta = "".join(f"        <span>{esc(p)}</span>" + NL for p in points)
    return (
        poster_open(page_no)
        + '      <div class="content stack gap-4">' + NL
        + '        <header class="gz-cover">' + NL
        + f'          <div class="gz-cover__kicker gz-t-label">{esc(KICKERS["cover"])}</div>' + NL
        + '          <div class="gz-cover__body">' + NL
        + f'            <h1 class="gz-cover__title gz-t-display-zh" style="--chars:{chars}">{esc(title)}</h1>' + NL
        + '            <div class="gz-cover__rule"></div>' + NL
        + sub
        + "          </div>" + NL
        + '          <div class="gz-cover__meta gz-chrome gz-t-meta">' + NL
        + '            <div class="gz-chrome__group">' + NL
        + meta
        + "            </div>" + NL
        + "          </div>" + NL
        + "        </header>" + NL
        + "      </div>" + NL
        + POSTER_CLOSE
    )


def _render_text_card(page: dict, page_no: int, article_root: Path | None = None) -> str:
    """单观点文字卡：kicker + h-display（大字）+ lead（正文）。"""
    copy = page["copy"]
    title = copy["title"]
    body = copy["body"]
    emphasis = page.get("emphasis") or ""
    big = esc_multiline(emphasis or title)
    kick = esc(title if emphasis else KICKERS["point"])
    return (
        poster_open(page_no)
        + '      <div class="content stack gap-4">' + NL
        + _kicker(kick)
        + f'        <h1 class="h-display">{big}</h1>' + NL
        + f'        <p class="lead">{esc_multiline(body)}</p>' + NL
        + "      </div>" + NL
        + POSTER_CLOSE
    )


def _render_screenshot(page: dict, page_no: int, article_root: Path | None = None) -> str:
    """截图证据卡：gz-figure + 图框 well_ratio（缺省 4x3；宽横图建议 21x9/16x10，T2 定案）。

    两种呈现模式（T2.5/T2.6）：
    - contain（缺省）: data-kind=screenshot 完整展示，crop.position 微调 object-position；
      UI/代码/GitHub 截图强制 contain，禁 cover 裁切（D8）
    - manual: crop.mode=manual，人工指定归一化区域 R=(x,y,width,height)（规划审批后写入），
      显式几何映射：img 元素盒按 S 缩放定位，R 充满图框。crop.fit 语义（用户可选）：
        cover（缺省）: R 充满图框，比例差由溢出裁切吸收（可能丢 R 外围）
        contain      : R 完整呈现，比例差由留白吸收
      S 以像素坐标计算（保真无变形，inline object-fit:fill 绕开 gz 样式默认规则）：
        contain: S = min(Wu/(w*dw), Hu/(h*dh))；cover: S = max(...)
        width% = dw*S/Wu*100；height% = dh*S/Hu*100
        left%  = ((Wu - w*dw*S)/2 - x*dw*S)/Wu*100；top 同理
      显示尺寸读 asset 文件真实值（image_dims.dims，含 EXIF 换算），非 Agent 口供。
    """
    copy = page["copy"]
    title = copy["title"]
    caption = copy["caption"]
    crop = page.get("crop") or {}
    mode = crop.get("mode", "contain") if isinstance(crop, dict) else "contain"
    well_ratio = page.get("well_ratio", "4x3")
    if well_ratio not in WELL_RATIOS:
        raise ValueError(f"well_ratio 非法: {well_ratio}（允许 {'|'.join(WELL_RATIOS)}）")
    wu, hu = WELL_RATIOS[well_ratio], 1.0  # 单位向量：纵横比保持即可，公式对整体缩放不变
    if mode == "manual" and article_root is None:
        raise ValueError("manual-crop 需要 article_root 以读取图片真实尺寸")
    if mode == "manual":
        info = _image_dims(article_root / page["asset"])  # 解析失败显式抛错，构建失败列出
        dw, dh = info["display"]["width"], info["display"]["height"]
        x, y, w, h = crop["x"], crop["y"], crop["width"], crop["height"]
        fit = crop.get("fit", "cover")
        if fit == "contain":
            s = min(wu / (w * dw), hu / (h * dh))
        else:  # cover（缺省）
            s = max(wu / (w * dw), hu / (h * dh))
        w_pct = dw * s / wu * 100
        h_pct = dh * s / hu * 100
        # img 相对图框定位：R 区域恰好落在图框窗口内（well 自带 overflow:hidden 完成裁切）
        # cover: R 左上对齐图框左上（充满，溢出裁 R 外围）；contain: R 居中（留白）
        if fit == "contain":
            left_pct = -x * w_pct + (100 - w_pct) / 2
            top_pct = -y * h_pct + (100 - h_pct) / 2
        else:  # cover（缺省）
            left_pct = -x * w_pct
            top_pct = -y * h_pct
        img_style = (f"position:absolute;left:{left_pct:.4f}%;top:{top_pct:.4f}%;"
                     f"width:{w_pct:.4f}%;height:{h_pct:.4f}%;"
                     "object-fit:fill;max-width:none;max-height:none")
        kind = "photo"  # 覆盖 well 默认 img 规则，几何由 inline style 全权控制
        figure_style = ""
    else:
        kind = "screenshot"  # contain 基底
        position = crop.get("position", "center") if isinstance(crop, dict) else "center"
        img_style = ""
        figure_style = f' style="--img-pos:{esc(position)}"' if position != "center" else ""
    return (
        poster_open(page_no)
        + '      <div class="content stack gap-4">' + NL
        + _kicker(KICKERS["evidence"])
        + f'        <h1 class="h-display">{esc(title)}</h1>' + NL
        + f'        <figure class="gz-figure" data-kind="{kind}" data-ratio="{well_ratio}"{figure_style}>' + NL
        + '          <div class="gz-figure__well">' + NL
        + (f'            <img src="{esc(asset_src(page["asset"]))}" alt="{esc(title)}"'
           + (f' style="{img_style}"' if img_style else "") + ">" + NL)
        + "          </div>" + NL
        + '          <figcaption class="gz-figure__cap gz-t-caption">' + NL
        + f'            <span class="gz-figure__idx">Fig.{page_no - 1}</span>' + NL
        + f"            <span>{esc(caption)}</span>" + NL
        + "          </figcaption>" + NL
        + "        </figure>" + NL
        + "      </div>" + NL
        + POSTER_CLOSE
    )


def _render_checklist(page: dict, page_no: int, article_root: Path | None = None) -> str:
    """清单页：gz-ledger 行式清单（nb 序号 + title + note 可选）。"""
    copy = page["copy"]
    title = copy["title"]
    points = copy["points"]
    notes = copy.get("notes") or []
    rows = []
    for i, p in enumerate(points):
        note = notes[i] if i < len(notes) and notes[i] else ""
        note_html = f'<p class="gz-ledger__note gz-t-small">{esc(note)}</p>' if note else ""
        rows.append(
            '        <li class="gz-ledger__row">' + NL
            + f'          <span class="gz-ledger__nb gz-t-label">{i + 1:02d}</span>' + NL
            + f'          <div><div class="gz-ledger__title gz-t-heading">{esc(p)}</div>{note_html}</div>' + NL
            + "        </li>" + NL
        )
    return (
        poster_open(page_no)
        + '      <div class="content stack gap-4">' + NL
        + _kicker(KICKERS["checklist"])
        + f'        <h1 class="h-display">{esc(title)}</h1>' + NL
        + '        <ol class="gz-ledger">' + NL
        + "".join(rows)
        + "        </ol>" + NL
        + "      </div>" + NL
        + POSTER_CLOSE
    )


def _render_quote(page: dict, page_no: int, article_root: Path | None = None) -> str:
    """金句/结论页：emphasis 为引文（换行转 <br>），copy.title 为出处。"""
    emphasis = page.get("emphasis") or ""
    source = (page.get("copy") or {}).get("title", "")
    src_html = f'  <figcaption class="gz-quote__source gz-t-meta">{esc(source)}</figcaption>' + NL if source else ""
    return (
        poster_open(page_no)
        + '      <div class="content stack gap-4">' + NL
        + '        <figure class="gz-quote">' + NL
        + '          <blockquote class="gz-quote__text gz-t-quote">' + NL
        + f"            <p>{esc_multiline(emphasis)}</p>" + NL
        + "          </blockquote>" + NL
        + src_html
        + "        </figure>" + NL
        + "      </div>" + NL
        + POSTER_CLOSE
    )


# ---------------------------------------------------------------- 组件表 ----
# 唯一事实来源：校验器读 required/optional/types 做字段校验，注入器调 render 出片段。

COMPONENTS: dict[str, dict] = {
    "cover-hook": {
        "required": {"copy.title": str, "copy.points": list},
        "optional": {"emphasis": str},
        "points_range": (3, 5),
        "render": _render_cover,
    },
    "text-card": {
        "required": {"copy.title": str, "copy.body": str},
        "optional": {"emphasis": str},
        "render": _render_text_card,
    },
    "screenshot-with-caption": {
        "required": {"asset": str, "copy.title": str, "copy.caption": str},
        "optional": {"image_fit": str, "crop": dict, "well_ratio": str},
        "image_fit_allow": ("contain",),  # UI 截图禁 cover（方案 D8；照片页请用 ai-image 路由）
        "render": _render_screenshot,
    },
    "checklist": {
        "required": {"copy.title": str, "copy.points": list},
        "optional": {"copy.notes": list},
        "points_range": (3, 6),
        "render": _render_checklist,
    },
    "quote": {
        "required": {"emphasis": str},
        "optional": {"copy.title": str},
        "render": _render_quote,
    },
}

# 主题枚举（与种子模板 data-theme 一致；style_mode -> 主题列表）
THEMES = {
    "editorial": ["ink-classic", "indigo-porcelain", "forest-ink", "kraft-paper", "dune", "midnight-ink"],
    "swiss": ["ikb", "lemon", "lemon-green", "safety-orange"],
}

SOURCE_ROUTES = ("html", "ai-image")

ASSET_PREFIX = "_cards/assets/"
