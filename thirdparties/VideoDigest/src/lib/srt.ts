import type { TranscriptSegment } from './types.js';

/** 秒数格式化为 SRT 时间戳 HH:MM:SS,mmm */
export function formatSrtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(rest).padStart(3, '0')}`;
}

/**
 * 带时间戳的分段转 SRT 文本。
 * 空文本段跳过、序号连续；end 早于 start 时按 start 对齐（whisper 偶发零长段）。
 */
export function segmentsToSrt(segments: readonly TranscriptSegment[]): string {
  const blocks: string[] = [];
  let index = 0;
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    index++;
    const end = Math.max(seg.end, seg.start);
    blocks.push(`${index}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(end)}\n${text}`);
  }
  return blocks.map((b) => b + '\n').join('\n');
}
