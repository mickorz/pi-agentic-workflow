/** 平台类型 */
export type PlatformKind = 'bilibili' | 'douyin' | 'youtube' | 'xiaohongshu' | 'other';

/** 平台信息 由 URL 推得 */
export interface PlatformInfo {
  readonly kind: PlatformKind;
  /** 用于结果展示的中文名 */
  readonly displayName: string;
  /** 是否需要 cookie（抖音/小红书强制 cookie） */
  readonly needsCookie: boolean;
  /** cookie 域过滤词 */
  readonly domainKeyword: string;
  /** cookie 流程要打开的站点首页 */
  readonly siteUrl: string;
  /** 登录态 cookie 名（存在且非空视为已登录；空数组表示无需判断登录态） */
  readonly loginCookieNames: readonly string[];
}

/** 转录字幕段（oil-subtitle transcript.json 兼容格式） */
export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}

/** 转录结果：纯文本 + 带时间戳的分段 */
export interface TranscribeResult {
  text: string;
  segments: TranscriptSegment[];
}

/** hybrid 解析归一化结构（对齐 DDA hybrid_crawler 的 minimal 输出） */
export interface HybridVideoStats {
  like: number;
  comment: number;
  share: number;
}

export interface HybridVideoData {
  platform: 'douyin' | 'bilibili';
  videoId: string;
  type: 'video' | 'image';
  title: string;
  author: string;
  publishTime: string | null;
  durationSeconds: number | null;
  /** 无水印视频直链（B站阶段一不取 playurl，为空数组） */
  videoUrls: string[];
  /** 图集图片直链 */
  imageUrls: string[];
  stats: HybridVideoStats;
}

/** 视频元数据 */
export interface VideoMetadata {
  title: string;
  uploader: string;
  durationSeconds: number | null;
  webpageUrl: string;
}

/** digest 命令的选项（commander 自动把长 flag 转 camelCase） */
export interface DigestOptions {
  /** index signature 兼容 Record<string, unknown>，便于从 ctx.options 断言 */
  [key: string]: unknown;
  lang: string;
  whisperModel: string;
  skipSummary: boolean;
  output?: string;
  json: boolean;
  keepTemp: boolean;
  ytdlp?: string;
  ffmpeg?: string;
  whisper?: string;
  cdpCli?: string;
  cookieDomain?: string;
  /** 直接使用现成 Netscape cookies.txt，跳过 cdp-cli 取 cookie */
  cookies?: string;
  /** 等待扫码登录的超时秒数（默认 120） */
  loginTimeout?: number;
  /** 同时生成 SRT 字幕文件（与 -o 同目录，无 -o 则当前目录，按视频标题命名） */
  srt?: boolean;
}

/** digest 结果类型：video=视频转录 note=图文笔记 */
export type DigestResultKind = 'video' | 'note';

/** 图文笔记载荷（resultKind=note 时存在） */
export interface NotePayload {
  content: string;
  imageUrls: string[];
}

/** digest 命令的结果 */
export interface DigestResult {
  url: string;
  platform: PlatformInfo;
  metadata: VideoMetadata;
  /** 视频时为逐字稿；图文时为正文 */
  transcript: string;
  summary: string | null;
  summarySkipped: boolean;
  /** LLM 提炼失败原因（summary 为 null 且非跳过时，第二阶段失败不丢原稿） */
  summaryError?: string;
  cookiesUsed: boolean;
  resultKind: DigestResultKind;
  /** 生成的 SRT 字幕文件绝对路径（--srt 且 resultKind=video 时存在） */
  srtFile?: string;
  /** 图文笔记内容（仅 resultKind=note 时存在） */
  note?: NotePayload;
}

/** digest 批次中单条链接的失败记录（plain 结构便于 JSON 序列化） */
export interface LinkFailure {
  url: string;
  error: {
    message: string;
    step?: string;
  };
}

/** srt 命令的选项（commander 自动把长 flag 转 camelCase） */
export interface SrtOptions {
  /** index signature 兼容 Record<string, unknown>，便于从 ctx.options 断言 */
  [key: string]: unknown;
  engine: string;
  lang: string;
  whisperModel: string;
  output?: string;
  keepTemp: boolean;
  whisper?: string;
  ffmpeg?: string;
}

/** douyin-user 命令的选项 */
export interface DouyinUserOptions {
  [key: string]: unknown;
  output?: string;
  cookie?: string;
  maxPages?: number;
  author?: string;
  filter?: string;
}

/** cookie 命令的选项 */
export interface CookieOptions {
  [key: string]: unknown;
  output?: string;
  timeout?: number;
  cdpCli?: string;
}

/** note 命令的选项（commander 自动把长 flag 转 camelCase） */
export interface NoteOptions {
  /** index signature 兼容 Record<string, unknown>，便于从 ctx.options 断言 */
  [key: string]: unknown;
  output?: string;
  json: boolean;
  cdpCli?: string;
  wait: number;
}

/** download 命令的选项 */
export interface DownloadOptions {
  /** index signature 兼容 Record<string, unknown>，便于从 ctx.options 断言 */
  [key: string]: unknown;
  /** 音频格式：wav / mp3 / m4a / best（原始流不转码） */
  format: string;
  /** 输出路径：单链接可指文件名，多链接须为目录（默认当前目录） */
  output?: string;
  ytdlp?: string;
  ffmpeg?: string;
  cdpCli?: string;
  /** 直接使用现成 Netscape cookies.txt，跳过 cdp-cli 取 cookie */
  cookies?: string;
  cookieDomain?: string;
  /** 等待扫码登录的超时秒数（默认 120） */
  loginTimeout?: number;
  /** 读取清单 markdown（douyin-user 产出）按下载重命名列命名并回写状态 */
  fromList?: string;
  /** 本批最多处理条数（配合 from-list 分批） */
  limit?: number;
  /** 下载视频 MP4（默认音频） */
  video?: boolean;
}

/** download 命令单条链接的结果 */
export interface DownloadResult {
  url: string;
  platform: PlatformInfo;
  metadata: VideoMetadata;
  format: string;
  /** 实际落盘的音频文件绝对路径 */
  outputFile: string;
  cookiesUsed: boolean;
}
