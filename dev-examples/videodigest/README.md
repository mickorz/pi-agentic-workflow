# videodigest —— 提取短视频工作流（开发期沙盒）

设计：`dev-docs/design/2026-10-24-短视频提取工作流设计方案V2.md`（V1 可行性分析已部分作废）。
进度：`dev-docs/progress/短视频提取工作流执行进度.md`。

> dev-examples 约定：本目录不对读者负责，内容可随时失效或删除，不进 README 宣传、不被其他文档引用。

## 布局

```text
videodigest/
  registry.json              # 本主题注册表片段（videodigest-extract, write 级, urlDomains 抖音域）
  adapter/                   # TS adapter（VideoDigest 移植，去 @clibase/core 与 @moonr/abogus 依赖）
    dist/cli.js              # resolve / extract 子命令，stdout 纯 JSON
  scripts/
    videodigest_extract.js   # 六阶段 workflow DSL（解析/幂等查重/提取/AI 提炼/归档/回执）
    archive_inspire.py       # 灵感区归档写入器（check/lock/unlock/archive，Python stdlib）
  work/<sourceKey>/          # 运行产物（gitignore）：metadata.json/transcript.json/extract.json
```

## 使用

```bash
# adapter 构建与测试（用仓库根工具链）
npx tsc -p dev-examples/videodigest/adapter/tsconfig.json
npx tsx --test dev-examples/videodigest/adapter/tests/*.test.ts

# 归档器单测（含 DSL 校验与 registry 校验）
npx tsx --test tests/unit/videodigest-archive.test.ts

# 微信网关（agent 模式，URL 前置路由直达本流程）
pi-workflow wechat start --registry dev-examples/videodigest/registry.json --scripts dev-examples/videodigest
```

环境依赖：yt-dlp / ffmpeg / cdp-cli（cookie 导出）/ DASHSCOPE_API_KEY（百炼 ASR）/ vault root
（`--vault-root` > `OBSIDIAN_VAULT_ROOT` > `.aws-article/config.json` 的 `vault_root`）。

## 幂等与锁

- `sourceKey = <platform>:<videoId>`（如 `douyin:7381234567890123456`）；短链多次分享同 videoId 同 key。
- 幂等索引 = 灵感区 frontmatter（`source_platform`+`source_id`），无额外状态文件。
- 并发占位 = `<vault>/60_Workspace/写作/灵感/.vd/locks/<sourceKey>.lock`（`open(x)` 原子；30min 陈锁接管）。
- 撞标题 → `<标题> (2)` 序号后缀（确定性，不用时间戳）。
