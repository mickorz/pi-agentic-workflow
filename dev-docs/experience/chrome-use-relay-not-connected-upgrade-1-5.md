# chrome-use relay 连不上致 image-use 生图 E_ENV：升级 1.5.x + extension install 一次修复

> 日期：2026-10-29
> 场景：公众号文章配图（image-prompts.json → article_image_generate workflow → provider=image-use web 后端）
> 关联：`references/pitfalls.md` #5（E_ENV 不要杀 Chrome）、scratchpad 生图环境排查待办、`2026-10-27-image-use-p16-acceptance-notes.md`

## 问题现象

image-use web 后端生成第 1 张图即失败，manifest 条目 `status=failed, error_code=E_ENV`。证据日志（文章目录 `.image-gen-logs/imggen-*.log`，路径见 manifest `evidence_log` 字段）显示三连失败：

1. 警告：`chrome-use 0.39.4 is older than 1.5.0; image-to-image / model-switch may fail`
2. `relay not connected`
3. 回落链全断：
   - `profile 'Default'`：composer never appeared（有 ChatGPT 登录但拉不起输入框，疑似冷启动未走代理被墙）
   - `current Chrome (relay)`：`chrome-use open failed (exit 1): Invalid response: EOF`
   - 收尾：`no logged-in ChatGPT browser available`

## 排查过程

1. 读 manifest 的 `evidence_log` 拿到完整失败链（不要只看 workflow stdout 的 `[failed] image-gen exit 1`）。
2. 按日志建议跑 `chrome-use extension install` → `command not found`。
3. 全盘找 chrome-use 二进制未果；从 vendored 脚本 `thirdparties/image-use/image-use` 源码发现关键行：
   `AB_BIN_CANDIDATES = ("chrome-use", "agent-browser", "agent-browser-stealth", "abs")`
   → 旧名 `agent-browser` 实际存在于 `/opt/homebrew/bin/agent-browser`，版本 0.39.4。
4. `agent-browser --help` 确认 0.39.4 **没有 `extension install` 子命令**（1.5.0+ 才有）——日志里"run chrome-use extension install"对旧版不可执行。
5. GitHub API 查 `leeguooooo/chrome-use` latest = v1.5.275，走代理下载 `chrome-use-darwin-arm64.tar.gz`，sha256 校验一致。
6. 安装：二进制 → `/opt/homebrew/bin/chrome-use`；`ChromeUse.app` → `/Applications/`；`xattr -dr com.apple.quarantine` 去 Gatekeeper 隔离。旧 `agent-browser` 保留不动（AB_BIN_CANDIDATES 里 chrome-use 排第一，自动优先命中新版）。
7. `chrome-use extension install`：注册 native messaging host（4 个 manifest，含临时 user-data-dir 的）→ 输出显示 **Default profile 已装扩展 0.5.97**。
8. `chrome-use browsers` 验证：`Chang Default mike.newsky@gmail.com CONNECTED yes`。
9. 重跑生成（`retry_failed: true` 重试 failed 条目）→ 预览图成功落盘。

## 根因（三层）

- **表层**：relay 未连接 + profile 'Default' 冷启动拉不起 chatgpt.com composer → web 后端两条浏览器路径全断。
- **深层**：旧版 0.39.4 缺少 1.5.0 的 extension install 自动化，**native messaging host 未注册**，扩展（其实一直装着，0.5.97）与 daemon 断连。新版 `extension install` 注册 host 后自动重连，无需人工碰 Chrome。
- **认知坑（下次直接绕开）**：
  - "ab-connect 扩展没找到"是搜索误导——ab-connect 是内部代号，Web Store 里的扩展名不叫这个；**扩展装没装以 `chrome-use browsers` / extension install 输出为准，别在 Chrome 里按名字搜**。
  - bash 里 `chrome-use: command not found` ≠ 没装：CLI 改过名（chrome-use ← agent-browser ← agent-browser-stealth/abs），且 workflow spawn 的 PATH 与交互 bash 不同。按 AB_BIN_CANDIDATES 顺序找别名。

## 解决方案（可复制的修复路径）

```bash
# 0) 诊断：先看 evidence_log，再验 relay
cat <文章目录>/.image-gen-logs/imggen-*.log
export PATH="/opt/homebrew/bin:$PATH"; chrome-use browsers   # CONNECTED yes 才继续

# 1) 版本 < 1.5.0 先升级（darwin-arm64 示例，走本机代理）
curl -sL -x http://127.0.0.1:7897 -o /tmp/cu.tar.gz \
  "https://github.com/leeguooooo/chrome-use/releases/download/v1.5.275/chrome-use-darwin-arm64.tar.gz"
curl -sL -x http://127.0.0.1:7897 -o /tmp/cu.tar.gz.sha256 "<同名>.sha256"
shasum -a 256 /tmp/cu.tar.gz   # 与 .sha256 一致再装
tar xzf /tmp/cu.tar.gz -C /tmp/chrome-use-upgrade
cp /tmp/chrome-use-upgrade/chrome-use /opt/homebrew/bin/ && chmod +x /opt/homebrew/bin/chrome-use
cp -R /tmp/chrome-use-upgrade/ChromeUse.app /Applications/ 2>/dev/null
xattr -dr com.apple.quarantine /opt/homebrew/bin/chrome-use /Applications/ChromeUse.app

# 2) 注册 native host + 检查扩展（扩展已装则自动重连，无需人工动 Chrome）
chrome-use extension install
chrome-use browsers   # 目标 profile CONNECTED: yes

# 3) 重跑生成，retry_failed 必带（failed 条目不重试会空跑）
pi-workflow run dev-examples/wx-article/scripts/article_image_generate.js --non-interactive \
  --args '{"article_dir":"<绝对路径>","mode":"preview","preview_id":"01","provider":"image-use","skip_confirm":true,"retry_failed":true}'
```

## 预防 / 注意事项

1. **生成前 30 秒预检代替事后排查**：跑 image-use 前先 `chrome-use browsers` 看 CONNECTED，断连先修再跑（"先探测 relay 再选后端"的前半已验证可行）。
2. **仍然不要杀 Chrome**（pitfalls #5）：扩展只在窗口开着时运行；修复靠注册 native host + 新开窗口，不靠重启进程。
3. **policy 路线（extension install 选项 A）没走**：它会把 Chrome 变成"受组织管理"（锁 DoH、扩展锁管理安装），对个人机代价大；本次 native host 注册即自动重连，选项 B（Web Store 逐 profile 点击）留作扩展真缺失时的路径。
4. **遗留改进项**：web 失败自动回落 codex（或 provider 层先探测 relay 再选 backend）仍值得做在 `image-use.mjs`；本次是手动修环境，未改代码。
5. 升级后 `chrome-use --version` 应 ≥ 1.5.0；`model_fingerprint` 会随二进制能力变化，重跑前确认 manifest 无 stale 意外。
