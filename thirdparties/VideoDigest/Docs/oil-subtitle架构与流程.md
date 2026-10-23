# oil-subtitle 架构与流程分析

> 分析对象：`thirdparties/oil-subtitle`（GitHub: oil-oil/oil-subtitle）
> 定位：一个面向 Agent 的字幕 Skill，为已导出的本地视频（MP4、MOV）完成中文转录、校对、预览、章节进度并烧录成片；可选把审校后的中文字幕翻译成同时间轴的英文 SRT。

## 1. 一句话架构

**脚本负责确定性工序，Agent 是唯一的语义校对者，云端模型只提供毛坯不允许碰成品。**

类比理解：它像一条"字幕流水线工厂"——

- `scripts/` 是车间里的自动机器：抽音频、ASR、分行、排版、烧录，全是确定性工序，可断点续跑；
- Agent 是流水线上唯一的"质检兼修字师"：通读全文、结合音画改错词、审阅人工修改；
- 百炼 FunAudio 和 Qwen 是"原材料供应商"：只提供原始转录和章节建议，被明确禁止改写字幕正文；
- 用户是"终审"：在本地预览页修改定稿，机器不擅自吸收润色进词库。

## 2. 目录结构

```text
oil-subtitle/
├── SKILL.md                    # Agent 执行规范（8 步工作流，核心契约）
├── README.md                   # 使用说明与数据边界
├── setup.sh                    # 一次性初始化（仅 macOS：venv + FFmpeg + 依赖）
├── agents/openai.yaml          # OpenAI 兼容入口元数据
├── scripts/                    # 全部流水线脚本（Python）
│   ├── user_config.py          # 配置、密钥、词库路径解析（含旧版迁移兼容）
│   ├── configure_api_key.py    # 保存或迁移百炼 API Key（权限 600）
│   ├── dashscope_client.py     # DashScope SDK 封装（文本、JSON、文件转写）
│   ├── bailian_transcribe.py   # 主转录：ASR + hotwords + glossary + 智能分行
│   ├── local_transcribe.py     # 本地 Whisper 降级路径（mlx-whisper 或 openai-whisper）
│   ├── review_subtitles.py     # 原样复制转录稿 + 生成技术词疑点清单（不改词）
│   ├── prepare_subtitles.py    # 章节生成（Qwen）+ CJK 空格规范化 + 预览 manifest
│   ├── preview_editor.py       # Flask 本地预览编辑器（默认端口 8765）
│   ├── learn_glossary.py       # 从人工修改生成错词待审报告（不自动写词库）
│   ├── subtitle_text.py        # 共享的 CJK 与拉丁边界补空格（幂等）
│   ├── burn_subtitles.py       # SRT 草稿、ASS 生成、人脸美颜、FFmpeg 烧录
│   └── detect_face_regions.swift # macOS Vision 框架采样人脸区域
└── tests/                      # 6 个 unittest 模块
```

## 3. 模块架构图

```mermaid
flowchart TB
    subgraph Agent层 [Agent 层]
        SKILL[SKILL md 八步执行规范]
        AGENT[Agent 语义校对与审阅]
    end

    subgraph 脚本层 [脚本层 scripts]
        CFG[user config py 配置与密钥解析]
        DSC[dashscope client py SDK 封装]
        BT[bailian transcribe py 主转录与分行]
        LT[local transcribe py 本地 Whisper 降级]
        RS[review subtitles py 校对副本与疑点清单]
        PS[prepare subtitles py 章节与预览清单]
        PE[preview editor py Flask 预览编辑器]
        LG[learn glossary py 错词待审报告]
        ST[subtitle text py 空格规范化]
        BS[burn subtitles py 烧录]
        SW[detect face regions swift 人脸检测]
    end

    subgraph 外部服务 [外部服务]
        ASR[百炼 FunAudio ASR]
        QW[百炼 Qwen 大模型]
        FF[FFmpeg]
        WH[本地 Whisper]
    end

    subgraph 用户侧 [用户侧]
        USR[本地浏览器预览页]
        GLS[个人词库 hotwords 与 glossary]
    end

    SKILL --> AGENT
    AGENT --> RS
    AGENT --> PS
    AGENT --> LG
    BT --> DSC
    PS --> DSC
    DSC --> ASR
    DSC --> QW
    BT --> FF
    BS --> FF
    LT --> WH
    BS --> SW
    PE --> LG
    PE --> USR
    BT --> GLS
    BS --> GLS
    CFG --> DSC
```

依赖关系要点：

- `user_config.py` 是全脚本的配置地基：统一解析 API Key、hotwords、glossary、进度条开关，并兼容旧版 `screen-studio-editor` 与 `~/.bailian` 迁移；
- `dashscope_client.py` 是唯一的云端出口：`call_qwen_text`、`call_qwen_json`、`transcribe_audio_file`（含 OSS 音频上传），一个 API Key 通吃 ASR 与 Qwen；
- `subtitle_text.py` 被 prepare 和 burn 共用，保证"预览看到的空格 = 成片烧出的空格"（幂等补空格）；
- `learn_glossary.py` 同时被预览器保存动作和命令行重试两条路径调用。

## 4. 核心工作流（主流程）

对应 SKILL.md 的 8 个阶段，从输入成片到交付烧录视频：

```mermaid
flowchart TD
    A[输入成片视频] --> B{已有可用转录且源未变}
    B -->|没有或已变化| C[FFmpeg 提取 16k 单声道音频]
    C --> D[FunAudio ASR 应用 hotwords]
    D --> E[应用 glossary 与智能分行]
    E --> F[transcript json 转录稿]
    B -->|可复用| G
    F --> G[review 原样复制并生成疑点清单]
    G --> H[Agent 通读全文结合音画改错词]
    H --> I[prepare 生成章节与预览清单]
    I --> J{用户免预览授权}
    J -->|需要校对| K[启动 Flask 预览编辑器]
    K --> L[用户修改并保存]
    L --> M[审阅人工修改维护 glossary]
    J -->|直接烧录| N
    M --> N[生成 SRT 草稿检查]
    N --> O[ASS 生成与人脸美颜烧录]
    O --> P[验证并交付 MP4 与 SRT 和 ASS]
```

关键分支：

1. **断点续跑**：每个阶段先核对工作目录已有产物（路径、大小、修改时间、指纹），源与选项未变就从缺失阶段继续，不重跑 ASR、不覆盖审校稿。
2. **本地降级**：用户明确要求或百炼不可用时，走 `local_transcribe.py`（Apple Silicon 用 mlx-whisper，否则 openai-whisper），输出格式与云端完全一致。
3. **免预览**：用户说"直接烧录"或工作流已授权时，Agent 完成全文校对和 SRT 检查后跳过预览服务直达烧录。

## 5. 阶段产物表

| 阶段 | 脚本 | 工作目录产物 | 说明 |
| --- | --- | --- | --- |
| 转录 | bailian_transcribe.py | `bailian_asr.json`、`transcript.json` | 原始 ASR 响应 + 术语校正分行后的转录稿 |
| 校对副本 | review_subtitles.py | `reviewed-transcript.json`、`subtitle-review.json`、`review-frames/` | 文字原样复制，疑点清单含版本号、命令、文件名、ASCII 词 |
| 准备 | prepare_subtitles.py | `subtitle-transcript.json`、`subtitle-chapters.json`、`subtitle-manifest.json`、`cache/` | 章节由 Qwen 生成，支持 `--resume` |
| 预览 | preview_editor.py | `subtitle-transcript.json.orig.json`、`preview-editor.log/pid` | 保存前自动备份副本 |
| 错词学习 | learn_glossary.py | `manual-edit-review.json` | 只出报告，写入权在 Agent |
| 烧录 | burn_subtitles.py | `demo_subtitled.srt/.ass/.mp4` | 草稿与成片分两步 |

最终交付物落在视频旁：`<视频名>_subtitled.mp4`、`.srt`、`.ass`；中间物全部收敛在 `<视频名>.subtitle-work/`。

## 6. 关键子流程

### 6.1 章节进度与排版（prepare_subtitles.py）

- 视频严格超过 3 分钟（可配置）才显示章节进度；3-5 分钟视频生成 2-4 章，更长视频 4-6 章，每章至少约 75 秒，避免碎片化；
- 章节规划由 `call_qwen_json` 提示词约束（`CHAPTER_PLANNING_VERSION = 3`），并以 segment ID 对齐字幕时间轴；
- 中英文与数字边界统一补一个半角空格（`add_cjk_spacing`，幂等），纯空格变化不进错题本；
- `--no-progress` 是单次任务开关：准备和烧录命令都要传，防止旧章节文件被误用。

### 6.2 预览编辑器（preview_editor.py）

```mermaid
flowchart TD
    A[manifest 文件] --> B[后台启动 Flask 服务]
    B --> C[Agent 校验 manifest 与 transcript 接口]
    C --> D[向用户提供实际端口地址]
    D --> E[用户左侧看预览 右侧逐句修改]
    E --> F[保存并关闭]
    F --> G[先备份 orig 副本]
    G --> H[写回 subtitle transcript json]
    H --> I[调用 learn manual edits 生成待审报告]
```

- 单文件内嵌 HTML 模板，Flask 路由：`/`（页面）、`/manifest`、`/video`、`/track/<code>`、`/api/transcript`（GET 读 / POST 存）；
- 通过 `start_new_session` 脱离会话运行，日志与 pid 写入工作目录，便于复用与排查；
- Agent 必须先核对 `/manifest` 与 `/api/transcript` 内容后才把地址给用户，未验证的 URL 不发送。

### 6.3 错词学习闭环（learn_glossary.py）

这是本 Skill 最克制的设计：**机器只报告，Agent 决定，词库永不自动写入。**

```mermaid
flowchart LR
    A[用户保存预览修改] --> B[比较 orig 与保存后字幕]
    B --> C{本地规则过滤}
    C -->|删句 纯新增 标点 整句大改| D[忽略]
    C -->|疑似稳定错词映射| E[pending 待审清单]
    E --> F[Agent 结合原句与上下文审阅]
    F -->|安全 可复用 不冲突| G[显式写入个人 glossary]
    F -->|润色 语气 一次性改写| D
    G --> H[下次转录自动应用]
    H --> B
```

- 基于 `difflib.SequenceMatcher` 对齐人工修改；
- 同一错词对应不同正确词时记录冲突，不覆盖；
- hotwords 变化会自动更新 DashScope 远程词表缓存（`vocabulary-cache.json`）。

### 6.4 英文 SRT 分支

```mermaid
flowchart TD
    A[用户要求英文字幕] --> B{已有审校后的中文 SRT}
    B -->|没有| C[补齐转录与 Agent 校对生成中文 SRT]
    B -->|有| D[直接作为翻译源]
    C --> D
    D --> E[Agent 逐条翻译正文]
    E --> F[编号 时间码 块数与中文源完全一致]
    F --> G[输出到视频旁 en srt]
    G --> H[到此停止 不章节 不预览 不烧录]
```

交付前逐块检查：编号时间码一致、英文非空、无未翻译中文残留。

### 6.5 烧录与美颜（burn_subtitles.py + detect_face_regions.swift）

```mermaid
flowchart TD
    A[字幕定稿] --> B[先生成 SRT 草稿供检查]
    B --> C[确认输出 MP4 不存在]
    C --> D{Swift Vision 人脸采样}
    D -->|检测到持续人脸| E[双边滤波轻度美颜 10 强度]
    D -->|无稳定人脸| F[保持原画]
    E --> G[生成 ASS 三层字幕]
    F --> G
    G --> H[FFmpeg 一次烧录成片]
    H --> I[验证时长 同步 遮挡与交付]
```

- ASS 采用多层事件：进度条填充（Layer 1）、章节刻度与标签（Layer 2-3）、圆角底框（Layer 4）、正文（Layer 5）；
- 字幕底框用矢量路径绘制圆角矩形，白色 PingFang 文本居中底部；
- 人脸区域检测采样 18 帧，取稳定区域裁剪后做 `bilateral` 平滑再 overlay 回原画面；
- 人工审阅过的 SRT 走 `--srt-input` 直烧：文本、换行、时间码原样保留。

## 7. 关键设计原则汇总

| 原则 | 落地方式 |
| --- | --- |
| 模型不得改写字幕正文 | `review_subtitles.py` 强制 `automatic_text_changes=0`，改词权只在 Agent |
| 词库永不自动写入 | `learn_glossary.py` 只出 `pending` 报告，写入是 Agent 的显式动作 |
| 预览即所得 | `subtitle_text.py` 在准备与烧录幂等复用同一空格规则 |
| 不覆盖已有产物 | 所有输出存在时换新文件名，除非用户明确同意覆盖 |
| 断点续跑 | 每阶段核对产物指纹，从缺失阶段继续；`prepare` 支持 `--resume` |
| 单密钥多用途 | FunAudio ASR、Qwen 断句、章节共用一个百炼 API Key |
| 最小数据外发 | 仅音频（ASR）与字幕文本（断句、章节）上云，编辑、词库、烧录全本地 |

## 8. 数据边界

- 上行：从视频提取的音频上传百炼临时存储；字幕文本发送百炼 Qwen；
- 本地：预览界面、人工编辑、待审报告、个人词库、SRT/ASS 生成、FFmpeg 烧录；
- 私密：API Key（600 权限）、个人配置、词库保存在 `~/.config/oil-subtitle/`，不进仓库。

## 9. 引用说明

- 本地源码：`thirdparties/oil-subtitle/SKILL.md`、`README.md`、`scripts/` 全部脚本与 `tests/`
- 上游仓库：https://github.com/oil-oil/oil-subtitle
- 相关文档：项目根 `README.md`（videodigestcli 对 thirdparties 的集成说明）
