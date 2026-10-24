import path from 'node:path';
import fs from 'node:fs';
import type { TranscribeResult } from './types.js';
import { transcribeWithBailian } from './bailian.js';

/**
 * 统一转录入口（V1 仅百炼引擎；whisper 降级通道不移植，见 V2 设计 §1 out of scope）。
 * 输出 oil-subtitle 兼容 transcript.json 到 workdir 并返回结果。
 */
export async function transcribeAudio(opts: {
  audioPath: string;
  workdir: string;
  lang: string;
  apiKey: string;
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
}): Promise<TranscribeResult> {
  const result = await transcribeWithBailian({
    audioPath: opts.audioPath,
    apiKey: opts.apiKey,
    lang: opts.lang,
    onProgress: opts.onProgress,
    timeoutMs: opts.timeoutMs,
  });
  fs.mkdirSync(opts.workdir, { recursive: true });
  fs.writeFileSync(path.join(opts.workdir, 'transcript.json'), JSON.stringify(result.segments, null, 2) + '\n', 'utf-8');
  return result;
}
