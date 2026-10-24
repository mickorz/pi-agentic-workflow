/** 平台类型（V1 支持抖音；表内其余为识别预留） */
export type PlatformKind = 'bilibili' | 'douyin' | 'youtube' | 'xiaohongshu' | 'other';

/** 平台信息 由 URL 推得 */
export interface PlatformInfo {
  readonly kind: PlatformKind;
  readonly displayName: string;
  readonly needsCookie: boolean;
  readonly domainKeyword: string;
  readonly siteUrl: string;
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

/** 视频元数据（yt-dlp --dump-single-json 提取） */
export interface VideoMetadata {
  title: string;
  uploader: string;
  durationSeconds: number | null;
  webpageUrl: string;
}

/** 每步耗时（毫秒；对齐 V2 设计 §5.2 CLI 契约） */
export interface StepTimings {
  resolveMs: number;
  cookieMs: number;
  metadataMs: number;
  downloadMs: number;
  transcribeMs: number;
  totalMs: number;
}

/** resolve 子命令结果（确定性解析，秒级） */
export interface ResolveResult {
  ok: true;
  platform: PlatformKind;
  platformName: string;
  /** 抖音 videoId；非抖音平台为 null（sourceKey 退化用 URL 摘要） */
  videoId: string | null;
  sourceKey: string;
  /** 短链跟随 302 后的规范化链接（非短链为原 URL） */
  canonicalUrl: string;
}

/** extract 子命令成功结果 */
export interface ExtractResult {
  ok: true;
  sourceKey: string;
  platform: PlatformKind;
  url: string;
  metadata: VideoMetadata;
  transcriptPath: string;
  transcriptText: string;
  audioPath: string;
  cookiesUsed: boolean;
  timings: StepTimings;
  /** 命中本地缓存（同 sourceKey 已提炼过：跳过下载/转写，直接复用 transcript.json） */
  cached?: boolean;
}

/** 失败结果（stdout JSON + exit 1） */
export interface ExtractFailure {
  ok: false;
  url?: string;
  sourceKey?: string;
  error: {
    message: string;
    step?: string;
    details?: string;
  };
}
