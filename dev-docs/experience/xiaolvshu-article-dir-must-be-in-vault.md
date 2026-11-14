# 小绿书文章目录建到仓库内 60_Workspace 导致发布失败

日期：2026-11-14（agent-skills 篇，发布授权门首次 execute 报 FileNotFoundError）

## 问题现象

publish_sticker_cards.py --execute 报 `FileNotFoundError: 'E:\\WorkProjects\\pi-agentic-workflow\\aws.env'`——凭据文件明明在 `dev-examples/wx-article/aws.env`，却到仓库根找。

## 排查过程

1. publish.py `find_config_root(article_dir)` 从文章目录向上找 `.aws-article` 标记目录；仓库根恰好有一个**只有 config.json（vault_root 指针）没有 aws.env 的 `.aws-article/`**，向上查找在仓库根提前命中。
2. 根因是上游错误：规划时把文章目录建在了**仓库内** `60_Workspace/写作/单篇/`（当时 ls 为空误以为目录该建在这），而文章目录约定位置是 **Obsidian vault** 内 `E:/Obsidian/newsky/60_Workspace/写作/单篇/<YYYYMMDD>/<主题>/`（历史篇全在 vault；仓库根 `.aws-article/config.json` 的 `vault_root` 字段就是指针）。vault 侧向上查找命中不了任何 `.aws-article`，回落 `find_config_root(draft_manager/)` 正确找到 `dev-examples/wx-article/` 配置根。

## 解决方案

1. 整目录搬到 vault：跨盘 `mv` 会因文件锁 Permission denied（MSYS），改 `cp -r` + `cmp` 字节级校验关键文件（pages.json / cards-manifest.json / output PNG / publish-approval.json / time-log.jsonl）后删源。
2. **同指纹重跑 execute 直接成功**：授权指纹 = sha256(pages/manifest/图片/标题/配文/账号槽位的内容哈希)，不含路径，搬家不作废授权。
3. 发布后顺手 `find <repo>/60_Workspace -type d -empty -delete` 清掉仓库内空壳。

## 预防 / 注意事项

- 小绿书与文章线共用同一文章目录约定：**一律建在 vault `E:/Obsidian/newsky/60_Workspace/写作/单篇/` 下**，不要在仓库内建 `60_Workspace/`（仓库根 `.aws-article` 只存 vault_root 指针，会截胡 find_config_root；且该目录未被 gitignore，素材会混进 git）。
- publish 失败先读 stderr 的目标路径：路径长啥样基本就指出 config root 被解析到了哪一层。
- 指纹不含路径：目录搬家不需要重新 prepare，同 `--approval` 重跑即可。
