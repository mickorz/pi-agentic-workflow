import { describe, it, expect } from 'vitest';
import { formatSrtTime, segmentsToSrt } from './srt.js';
import type { TranscriptSegment } from './types.js';

function seg(start: number, end: number, text: string): TranscriptSegment {
  return { start, end, text, words: [] };
}

describe('formatSrtTime', () => {
  it('基础格式化', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(1.5)).toBe('00:00:01,500');
    expect(formatSrtTime(61.234)).toBe('00:01:01,234');
    expect(formatSrtTime(3661.999)).toBe('01:01:01,999');
  });

  it('负数按 0 处理', () => {
    expect(formatSrtTime(-1)).toBe('00:00:00,000');
  });
});

describe('segmentsToSrt', () => {
  it('正常生成序号与时间轴', () => {
    const srt = segmentsToSrt([seg(0, 1.5, '你好'), seg(1.5, 3, '世界')]);
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,500\n你好\n\n2\n00:00:01,500 --> 00:00:03,000\n世界\n');
  });

  it('空文本段跳过且序号连续', () => {
    const srt = segmentsToSrt([seg(0, 1, 'a'), seg(1, 2, '  '), seg(2, 3, 'b')]);
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,000\na\n\n2\n00:00:02,000 --> 00:00:03,000\nb\n');
  });

  it('end 早于 start 时对齐 start', () => {
    const srt = segmentsToSrt([seg(5, 5, '零长段')]);
    expect(srt).toContain('00:00:05,000 --> 00:00:05,000');
  });

  it('文本去首尾空格', () => {
    const srt = segmentsToSrt([seg(0, 1, '  whisper 前导空格  ')]);
    expect(srt).toContain('\nwhisper 前导空格');
  });
});
