# 已迁移说明（2026-10-24）

本目录仅保留历史参考。原 `references/` 下的 Windows 专用脚本已全部迁移为跨平台 Python 脚本（仅标准库）：

- `insert_images.ps1` → `dev-examples/wx-article/scripts/references/article_insert_images_meta/scripts/insert_images.py`
- `publish.ps1` → `dev-examples/wx-article/scripts/references/wechat_md_to_draft/scripts/publish.py`

工程脚本语言约定见仓库根 `CLAUDE.md`「脚本语言约定」章节。

`my.aws` / `my.json` 为敏感凭证打包件，已于 ece2bb7 迁移至 `dev-examples/wx-article/.aws-article/` + `aws.env`（gitignore，换机器手动同步），本目录不再保留副本。
