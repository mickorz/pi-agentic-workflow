# Vcli

Vcli 命令行工具

基于 [CLIBase](../../) 基座生成。

## 开发

```bash
pnpm install
pnpm build
node dist/index.js --help
```

## 加命令

1. 在 `src/commands/` 新建 `xxx.ts` 用 `defineCommand` 定义并导出。
2. 在 `src/commands/index.ts` 的 `commands` 数组加一行。

无需修改 `src/index.ts`。

## 命令

- `vcli hello [名字]`：示例问候命令
- `vcli ask <问题>`：示例 LLM 命令，向大模型提问
- `vcli digest <url...>`：一个或多个视频/图文链接 -> 重点提炼 + 完整内容
  - 串联 yt-dlp 下载 + ffmpeg 转码 + whisper 转录 +（抖音/小红书）cdp-cli 取 cookie + LLM 提炼
  - 小红书/抖音链接自动检测笔记类型：视频笔记走下载转录，图文笔记自动转页面提取（标题/正文/图片列表）；抖音短链先 Node 侧跟随 302 解析出最终 `douyin.com/note/<id>`（短链页内跳转可能卡住）；避免 yt-dlp 对图文报 `No video formats found` / `Unsupported URL`
  - **两阶段提取**：阶段一逐条提取原稿（下载转录/图文正文），每条完成立即写入结果文件；阶段二待全部原稿完成后统一 LLM 重点提炼，每条提炼完立即重写结果文件——LLM 超时或失败只损失提炼，原稿不丢（条目标记"提炼失败"原因）
  - 每次运行写日志到 `~/.video-digest/logs/digest-<时间戳>.md`：每条链接的步骤时间线（含**每步耗时与链接总耗时**）、成功/失败、原始报错与类型判定，文首附**阶段耗时汇总表**（累计/次数/平均/最长，按累计降序），便于定位耗时大头做优化
  - 多链接一个批次：整个批次只启动一次调试 Chrome，每个平台域只导出一次 cookie（缓存于批次目录 `cookies-<域>.txt`），批末统一关闭与清理；单条失败不中断批次，结束汇总 N/M
  - `--cookies <file>` 直接使用现成 Netscape cookies.txt，完全跳过 cdp-cli
  - `--json`：单链接输出单个结果对象（含 `resultKind: video|note`），多链接输出 `{ results, failures }` 结构
  - `-o <file>`：批末写合并文件（文本用分隔线连接多条结果，失败链接以占位段落体现）
  - 命令行选项请放在 URL 前面（commander variadic 参数的限制）
  - 工具路径解析优先级：`--ytdlp/--ffmpeg/--whisper/--cdp-cli` 选项 > `VD_YTDLP/VD_FFMPEG/VD_WHISPER/VD_CDP_CLI` 环境变量 > PATH
  - 抖音/小红书自动走 cdp-cli 取 cookie（绕过 Chrome ABE 加密）
  - `--skip-summary` 仅输出内容不提炼；`--keep-temp` 保留批次根目录

## LLM 能力

本 CLI 通过 @clibase/core 内置大模型调用 支持文本 读图 生图三类模型 可配置多个并按用途选用

### 配置

编辑配置文件 Windows 为 %APPDATA%/vcli/vcli.json 写入 models 与 active 段

```json
{
  "models": {
    "my-text": { "kind": "text", "apiBaseUrl": "https://api.deepseek.com/v1", "apiKey": "sk-xxx", "model": "deepseek-chat" },
    "my-vision": { "kind": "vision", "apiBaseUrl": "https://api.openai.com/v1", "apiKey": "sk-yyy", "model": "gpt-4o" }
  },
  "active": { "text": "my-text", "vision": "my-vision" }
}
```

或用环境变量单模型兜底 所有用途共用

```bash
export LLM_API_BASE_URL=https://api.deepseek.com/v1
export LLM_API_KEY=sk-xxx
export LLM_MODEL=deepseek-chat
```

### 使用

vcli ask 你的问题

更多能力见 @clibase/core 的 chat chatJson generateImage loadModelConfig
