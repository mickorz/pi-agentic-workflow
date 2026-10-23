---
name: video-digest
description: 将公开视频或音频链接下载并转录为完整逐字稿，再根据真实转录内容提炼重点。用户说“提取视频”“转录链接”“生成逐字稿和摘要”、使用“/提取”并附带链接，或一次提供多个视频链接时使用。支持 B站、抖音、YouTube、小红书及 yt-dlp 可处理的平台。
---

# 视频转录与重点提炼

把视频或音频链接转换为“重点提炼 + 完整逐字稿”，直接显示在对话中，不写入知识库或永久文件。

始终基于真实转录内容生成摘要。不要根据标题、描述或常识补写未转录出的内容。

## 前置检查

确认以下命令可用：

```bash
yt-dlp --version
ffmpeg -version
whisper --help
node --version   # 运行 cookie 导出脚本需要 Node 22+
```

如有缺失，告诉用户安装：

```bash
pip install -U yt-dlp openai-whisper
# macOS: brew install ffmpeg
# Ubuntu / Debian: sudo apt install ffmpeg
# Node（需 22+）：https://nodejs.org
```

抖音、小红书等需要 cookie 的平台还会用到 `cdp-cli`（首次用到时再确认）：

```bash
cdp-cli --version   # 或: node <cdp-cli 安装目录>/build/index.js --version
```

若不可用，安装：`npm install -g @myerscarpenter/cdp-cli`。

## 工作流

### 1. 解析输入

- 提取一个或多个 URL，以及可选备注。
- 识别平台用于结果展示，并判断是否需要 cookie：
  - `bilibili.com` / `b23.tv`：B站（音频通常无需 cookie）
  - `douyin.com` / `tiktok.com`：抖音（强制 cookie → 走 cdp-cli）
  - `youtube.com` / `youtu.be`：YouTube（通常无需 cookie）
  - `xiaohongshu.com` / `xhslink.com`：小红书（强制 cookie → 走 cdp-cli）
  - 其他：先尝试无 cookie 下载；若报“需要 cookie / 登录”再走 cdp-cli
- **小红书/抖音链接先判断笔记类型（图文 or 视频）再提取**，避免图文笔记走 yt-dlp 报 `No video formats found` 或 `Unsupported URL /note/`：
  - 先用 `yt-dlp --dump-single-json` 探测：返回含 `duration`（时长 > 0）即为视频笔记，走 2b 视频流程。
  - 探测失败或无时长：在调试 Chrome 打开该链接（抖音短链先在命令行 `curl -sIL <短链>` 跟随重定向拿到最终 `www.douyin.com/note/<id>` 再打开，短链页内跳转可能卡住），页面若能提取到正文则是图文笔记，输出标题/正文/图片列表（正文足够长时同样生成重点提炼），**不要**再跑下载转录。
  - 抖音图文正文定位：找含“发布时间：”的元素，向上取同时含正文的最近父容器（排除评论区与右侧推荐流）。
- 多个 URL 作为一个批次处理，**分两个阶段**：
  - **阶段一（逐条提取原稿）**：按链接顺序逐条完成下载转录（或图文正文提取），每条完成后立即把"标题/作者/链接/原稿"追加写入结果（对话输出或 `-o` 文件），不等待其他链接。
  - **阶段二（统一重点提炼）**：全部原稿提取完成后，再逐条用 LLM 提炼重点，每条提炼完成立即更新对应条目。LLM 超时或失败只损失提炼本身，原稿已保存不丢，条目标注"提炼失败"及原因。
- 本批只在需要时启动一次调试 Chrome，每个需 cookie 的平台只导出一次 cookie，全部链接处理完后统一清理。
- 本批所有链接共用一个批次目录 `$BATCHDIR`，每条链接使用独立子目录。
- 每批次结束写运行日志到 `~/.video-digest/logs/batch-<时间戳>.md`（详见第 6 步），记录每条链接的步骤时间线、每步耗时、成功/失败与原始报错。

### 2. 获取元数据并转录

批次开始时创建一次批次目录：

```bash
BATCHDIR="$(mktemp -d "${TMPDIR:-/tmp}/video-digest-batch.XXXXXX")"
```

处理第 N 条链接前（N 从 1 起）创建其子目录：

```bash
WORKDIR="$BATCHDIR/link-N"
mkdir -p "$WORKDIR"
```

#### 2a. 获取 cookie（仅抖音、小红书，或下载报“需要 cookie / 登录”时）

cookie **统一通过 `cdp-cli` 获取，不要使用 yt-dlp 的 `--cookies-from-browser`**——Chrome 127+ 的 App-Bound Encryption (ABE) 会让它报 `Failed to decrypt with DPAPI`。cdp-cli 让运行中的 Chrome 自己吐出明文 cookie（含 HttpOnly），绕过文件加密，也无需用户关闭浏览器。

**批次规则：整批只启动一次调试 Chrome；每个平台域只导出一次 cookie；全部链接处理完才关闭 Chrome。**

```bash
# 1) 启动调试 Chrome —— 带超时与重试，失败则终止整个任务
#
#    背景：cdp-cli launch 成功输出 JSON 后，命令本身可能不退出（持续占用
#    当前 shell 的标准管道），表现为"卡住"。因此必须后台启动 + 轮询读取端口，
#    而不是等待命令返回。单次超时 30s，最多重试 3 次，3 次均失败则终止
#    整个任务（不再继续后续步骤）。
#
#    —— bash（macOS / Linux）——
PORT=""
for attempt in 1 2 3; do
  echo "[Chrome] 启动第 ${attempt}/3 次（超时 30s）"
  LOG="/tmp/cdp-launch-$$.log"; rm -f "$LOG"
  cdp-cli launch > "$LOG" 2>&1 &
  for i in $(seq 1 30); do
    PORT=$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$LOG" 2>/dev/null)
    [ -n "$PORT" ] && curl -sf "http://localhost:$PORT/json" >/dev/null 2>&1 && break 2
    sleep 1
  done
  echo "[Chrome] 第 ${attempt} 次未成功，清理后重试"
  pkill -f "cdp-cli-chrome-" 2>/dev/null || true
  sleep 2
done
if [ -z "$PORT" ] || ! curl -sf "http://localhost:$PORT/json" >/dev/null 2>&1; then
  echo "[Chrome] 3 次重试均失败，终止任务。"; exit 1
fi
#    后续所有平台、所有链接复用这一个 $PORT，绝不重复 launch
#
#    —— PowerShell（Windows）——
# $PORT = ""; $ok = $false
# for ($a = 1; $a -le 3; $a++) {
#   Write-Output "[Chrome] 启动第 $a/3 次（超时 30s）"
#   $log = "$env:TEMP\cdp-launch.log"; Remove-Item $log -ErrorAction SilentlyContinue
#   $p = Start-Process cdp-cli -ArgumentList "launch" -RedirectStandardOutput $log -PassThru -WindowStyle Hidden
#   for ($i = 1; $i -le 30; $i++) {
#     if ((Test-Path $log) -and (Get-Content $log -Raw -EA SilentlyContinue) -match '"port":(\d+)') {
#       $PORT = $Matches[1]
#       try { Invoke-RestMethod "http://localhost:$PORT/json" -TimeoutSec 3 | Out-Null; $ok = $true; break } catch {}
#     }
#     Start-Sleep 1
#   }
#   if ($ok) { Write-Output "[Chrome] 成功，端口 $PORT"; break }
#   if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -EA SilentlyContinue }
#   Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
#     Where-Object CommandLine -like "*cdp-cli-chrome-*" |
#     ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
#   Start-Sleep 2
# }
# if (-not $ok) { Write-Output "[Chrome] 3 次重试均失败，终止任务。"; exit 1 }

# 2) 每个需 cookie 的平台各执行一次（如抖音和小红书各一次，之后复用）：
cdp-cli --cdp-url "http://localhost:$PORT" new "https://www.<平台域名>.com"
sleep 6
node "$SKILL_DIR/export_cookies.mjs" "$BATCHDIR/cookies-<域关键词>.txt" "$PORT" "<域关键词>"
#   例：抖音 -> cookies-douyin.txt，域关键词 douyin
#   例：小红书 -> cookies-xiaohongshu.txt，域关键词 xiaohongshu

# 3) 该平台的所有后续链接直接复用 $BATCHDIR/cookies-<域关键词>.txt，不再重复步骤 2
# 4) 该平台所有 yt-dlp 命令统一加 --cookies "$BATCHDIR/cookies-<域关键词>.txt"
```

- `$SKILL_DIR` 是本 skill 目录（`export_cookies.mjs` 所在处）。
- 域关键词用于过滤 cookie，只导出目标站点；cookie 文件名带域关键词，多平台互不覆盖。
- 平台不需要 cookie 时直接跳过本步，也不要启动 Chrome。

#### 2b. 获取元数据并下载音频

获取标题、作者、时长和发布时间（若有 cookie 则追加 `--cookies "$BATCHDIR/cookies-<域关键词>.txt"`）：

```bash
yt-dlp --dump-single-json --no-download --no-playlist \
  --cookies "$BATCHDIR/cookies-<域关键词>.txt" "<URL>"
```

下载音频并转换为适合 Whisper 的 WAV（同样追加 `--cookies`，无 cookie 时省略该行）：

```bash
yt-dlp -x --audio-format wav --audio-quality 0 \
  --postprocessor-args "ffmpeg:-ar 16000 -ac 1" \
  --cookies "$BATCHDIR/cookies-<域关键词>.txt" \
  -o "$WORKDIR/audio.%(ext)s" --no-playlist "<URL>"
```

转录：

```bash
whisper "$WORKDIR/audio.wav" --model base --language zh \
  --output_format txt --output_dir "$WORKDIR"
```

- 明确是英文内容时，把 `--language zh` 改为 `--language en`。
- 语言不明确或混合语言较多时，去掉 `--language` 让 Whisper 自动识别。
- 读取完整的 `$WORKDIR/audio.txt`，不要只读开头或截断后半段。
- 下载失败时，明确说明“该链接无法访问，未能转录”，不要生成摘要。

### 3. 校验内容

- 转录超过 50 个字符：生成重点提炼。
- 转录不超过 50 个字符：只输出逐字稿，并说明内容过短，未生成提炼。
- 转录为空：报告失败，不得用视频简介替代逐字稿。

### 4. 提炼重点

按原文结构提炼，不自行增加原文没有的观点：

```text
[一句话概括核心价值]

① 名称：具体说明
② 名称：具体说明
...

核心观点：[一句话总结]
```

纠正上下文中明显的语音识别错误；无法确认的专有名词标记 `[?]`，不要猜测。

### 5. 输出结果

```text
🎬 标题：<title>
👤 作者：<uploader>
⏱️ 时长：<duration>
🔗 链接：<url>

📝 重点提炼：
<提炼结果>

———————————
📄 完整逐字稿：
<完整转录文字>
```

### 6. 清理与运行日志

确认全部链接的输出内容都已读取后，统一清理（不是每条链接清一次）：

- 写运行日志（见下）。
- 关闭调试 Chrome（若本批启动过）：结束命令行包含 `cdp-cli-chrome-$PORT` 的 chrome 进程（精确匹配临时 profile，避免误关用户自己的浏览器）。
- 删除整个批次目录：`rm -rf "$BATCHDIR"`。

先关 Chrome 再删目录。不要删除任何非本工作流创建的目录。

**运行日志**（用于事后分析失败原因与卡点，必须写）：

```bash
LOGDIR="$HOME/.video-digest/logs"
mkdir -p "$LOGDIR"
# 文件名 batch-YYYYMMDD-HHMMSS.md（用 date 生成时间戳）
```

每份日志包含：

- 批次命令与开始时间、链接总数。
- **阶段耗时汇总表**（放文首）：各阶段（类型检测、元数据、下载、转录、提炼等）的累计耗时、次数、平均、最长，按累计降序——一眼看出耗时大头在哪。
- 每条链接一节：类型判定结论（视频/图文）、各步骤时间线（平台识别、取 cookie、类型检测、元数据、下载、转录、提炼）、**每步耗时**（用 `date +%s` 记录步骤开始结束算差值）、每步成功或失败、失败时的**原始报错全文**（不要只写"失败了"）、链接总耗时。
- 卡点与解决方式：若某步失败后换了方法成功（如视频流提不到转图文提取），记录"什么报错 -> 换了什么办法 -> 结果如何"。
- 批次汇总：N/M 条成功、失败原因分类、批次总耗时。

## 异常处理

- **需要 cookie / 登录**：统一走 cdp-cli 获取 cookie（见 2a）。不要用 `--cookies-from-browser`（Chrome 127+ 的 ABE 加密会失败）。若 cdp-cli 不可用，提示安装 `npm i -g @myerscarpenter/cdp-cli`。
- **小红书报 `No video formats found` 或抖音报 `Unsupported URL .../note/`**：说明是图文笔记，转图文提取路径（见 1），并在日志中记录该判定。
- 链接内容已删除、地区受限或下载失败：说明具体失败原因，不编造内容；该链接标记失败后继续处理下一条。
- 视频超过 15 分钟：仍然完整转录；提前提示可能耗时较长。
- 多个链接：一条失败不影响后续链接，分别报告每条结果；即使某条失败，调试 Chrome 也保留到批次全部结束才关闭（下一条链接可能还需要它）。
- 若批次中途被打断（如会话取消），调试 Chrome 可能残留：手动结束命令行包含 `cdp-cli-chrome-<端口>` 的 chrome 进程。
