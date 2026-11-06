#!/usr/bin/env python3
"""components.py —— 小绿书卡片版式组件表（唯一事实来源）。

validate_pages.py（校验器）与 build_html.py（注入器）共用本模块：
- 新增版式 = 在 COMPONENTS 加一个条目（required/optional 字段规格 + render 函数），
  校验与注入自动跟随，不各自维护枚举（方案 2026-11-05 V1.1 评审 P0-2/P0-4 定案）。

字段规格说明：
- required / optional：点路径 -> 期望 python 类型（str/list/dict），缺 required 即 FAIL
- points_range：list 字段的长度边界（仅对名为 copy.points 的字段生效）
- image_fit：截图类组件的缩放策略；screenshot 组件强制 contain（UI 截图禁 cover，D8）
- render(page, page_no)：返回画板内部 HTML（固定片段，文本一律经 esc() 转义；
  片段不写任何 margin/定位样式，画板从整数 0,0 开始 —— T0 经验：分数坐标截图差 1px）

标记约定：
- asset 路径一律相对文章目录，必须以 "_cards/assets/" 开头（防路径逃逸，构建时转成 "assets/"）
- 画板 id 固定 "xhs-{no:02d}"，render.mjs 按元素 id 命名产物，T4 规范化按页号映射
"""
from __future__ import annotations

import html as _html

# ---------------------------------------------------------------- 基础工具 --


def esc(text: str) -> str:
    """HTML 转义（含引号）；换行转 <br>。所有进入 HTML 的文本必须经过本函数。"""
    return _html.escape(str(text), quote=True).replace("\n", "<br>")


def esc_multiline(text: str) -> str:
    """同 esc，但保留多行（\n -> <br>）。"""
    return esc(text)


def asset_src(asset: str) -> str:
    """pages.json 的 asset 路径 -> HTML src（index.html 位于 _cards/ 下）。"""
    return asset[len("_cards/"):]


def poster_open(page_no: int) -> str:
    return f'    <section class="poster xhs" id="xhs-{page_no:02d}">\n'


POSTER_CLOSE = "    </section>\n"

KICKERS = {
    "cover": "封面 · Cover",
    "point": "要点 · Point",
    "evidence": "实证 · Evidence",
    "checklist": "清单 · Checklist",
    "quote": "引言 · Quote",
}


def _kicker(label: str) -> str:
    return f'      <p class="kicker">{esc(label)}</p>\n'


# ---------------------------------------------------------------- 组件渲染 --
# 片段只使用种子模板已有 class（gz-components.md 为准），双模板（editorial/swiss）通用。


def _render_cover(page: dict, page_no: int) -> str:
    """封面钩子页：gz-cover 体系；标题按行数字自适应（--chars = 最长行字数 + 0.1）。"""
    copy = page["copy"]
    title = copy["title"]
    points = copy["points"]
    emphasis = page.get("emphasis") or ""
    lines = title.split("\n")
    chars = f"{max(len(ln) for ln in lines) + 0.1:.2f}"
    sub = f'      <p class="gz-cover__sub gz-t-lead">{esc(emphasis)}</p>\n' if emphasis else ""
    meta = "".join(f"        <span>{esc(p)}</span>\n" for p in points)
    return (
        poster_open(page_no)
        + '      <div class="content stack gap-4">\n'
        + f'        <header class="gz-cover">\n'
        + f'          <div class="gz-cover__kicker gz-t-label">{esc(KICKERS["cover"])}</div>\n'
        + '          <div class="gz-cover__body">\n'
        + f'            <h1 class="gz-cover__title gz-t-display-zh" style="--chars:{chars}">{esc(title)}</h1>\n'
        + '            <div class="gz-cover__rule"></div>\n'
        + sub
        + "          </div>\n"
        + '          <div class="gz-cover__meta gz-chrome gz-t-meta">\n'
        + '            <div class="gz-chrome__group">\n'
        + meta
        + "            </div>\n"
        + "          </div>\n"
        + "        </header>\n"
        + "      </div>\n"
        + POSTER_CLOSE
    )


def _render_text_card(page: dict, page_no: int) -> str:
    """单观点文字卡：kicker + h-display（大字）+ lead（正文）。"""
    copy = page["copy"]
    title = copy["title"]
    body = copy["body"]
    emphasis = page.get("emphasis") or ""
    big = esc(emphasis or title)
    kick = esc(title if emphasis else KICKERS["point"])
    return (
        poster_open(page_no)
        + '      <div class="content stack gap-4">\n'
        + _kicker(kick)
        + f'        <h1 class="h-display">{big}</h1>\n'
        + f'        <p class="lead">{esc(body)}</p>\n'
        + "      </div>\n"
        + POSTER_CLOSE
    )


def _render_screenshot(page: dict, page_no: int) -> str:
    """截图证据卡：gz-figure(data-kind=screenshot) 强制 contain + 阴影；cover 走 photo 通道。

    图框固定 4:3（横版 UI 截图为主；3:4 会让 标题+图框+图注 超出 1440 画板，
    图注被 overflow:hidden 裁掉——T1 抽检实测教训）。竖版证据图列 P1 增强。"""
    copy = page["copy"]
    title = copy["title"]
    caption = copy["caption"]
    fit = page.get("image_fit") or "contain"
    crop = page.get("crop") or {}
    position = crop.get("position", "center") if isinstance(crop, dict) else "center"
    kind = "photo" if fit == "cover" else "screenshot"
    style = f' style="--img-pos:{esc(position)}"' if position != "center" else ""
    return (
        poster_open(page_no)
        + '      <div class="content stack gap-4">\n'
        + _kicker(KICKERS["evidence"])
        + f'        <h1 class="h-display">{esc(title)}</h1>\n'
        + f'        <figure class="gz-figure" data-kind="{kind}" data-ratio="4x3"{style}>\n'
        + '          <div class="gz-figure__well">\n'
        + f'            <img src="{esc(asset_src(page["asset"]))}" alt="{esc(title)}">\n'
        + "          </div>\n"
        + f'          <figcaption class="gz-figure__cap gz-t-caption">\n'
        + f'            <span class="gz-figure__idx">Fig.{page_no - 1}</span>\n'
        + f"            <span>{esc(caption)}</span>\n"
        + "          </figcaption>\n"
        + "        </figure>\n"
        + "      </div>\n"
        + POSTER_CLOSE
    )


def _render_checklist(page: dict, page_no: int) -> str:
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
            '        <li class="gz-ledger__row">\n'
            f'          <span class="gz-ledger__nb gz-t-label">{i + 1:02d}</span>\n'
            f"          <div><div class=\"gz-ledger__title gz-t-heading\">{esc(p)}</div>{note_html}</div>\n"
            "        </li>\n"
        )
    return (
        poster_open(page_no)
        + '      <div class="content stack gap-4">\n'
        + _kicker(KICKERS["checklist"])
        + f'        <h1 class="h-display">{esc(title)}</h1>\n'
        + '        <ol class="gz-ledger">\n'
        + "".join(rows)
        + "        </ol>\n"
        + "      </div>\n"
        + POSTER_CLOSE
    )


def _render_quote(page: dict, page_no: int) -> str:
    """金句/结论页：emphasis 为引文（\n 换行），copy.title 为出处。"""
    emphasis = page.get("emphasis") or ""
    source = (page.get("copy") or {}).get("title", "")
    src_html = f'  <figcaption class="gz-quote__source gz-t-meta">{esc(source)}</figcaption>\n' if source else ""
    return (
        poster_open(page_no)
        + '      <div class="content stack gap-4">\n'
        + '        <figure class="gz-quote">\n'
        + '          <blockquote class="gz-quote__text gz-t-quote">\n'
        + f"            <p>{esc_multiline(emphasis)}</p>\n"
        + "          </blockquote>\n"
        + src_html
        + "        </figure>\n"
        + "      </div>\n"
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
        "optional": {"image_fit": str, "crop": dict},
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
