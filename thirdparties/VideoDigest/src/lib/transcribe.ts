import path from 'node:path';
import fs from 'node:fs';
import { runAsync, CliError } from '@clibase/core';
import type { TranscriptSegment, TranscribeResult } from './types.js';
import { transcribeWithBailian } from './bailian.js';

export type TranscribeEngine = 'bailian' | 'whisper';

/** whisper --output_format json 输出中的原始 segment */
interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  words?: Array<{ word: string; start: number; end: number }> | null;
}

/**
 * 统一转录入口：百炼 FunAudio（默认）或本地 whisper（降级）。
 * 两种引擎输出同一份 transcript.json 中间格式 [{start, end, text, words}]（词级时间戳），
 * 并在 workdir 落盘 transcript.json。
 */
export async function transcribeAudio(opts: {
  engine: TranscribeEngine;
  audioPath: string;
  workdir: string;
  lang: string;
  /** 百炼 API Key（engine=bailian 必填） */
  apiKey?: string;
  /** whisper 模型名（engine=whisper 用） */
  model?: string;
  whisper?: string;
  ffmpegDir?: string;
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
}): Promise<TranscribeResult> {
  const result =
    opts.engine === 'bailian'
      ? await transcribeWithBailian({
          audioPath: opts.audioPath,
          apiKey: opts.apiKey ?? '',
          lang: opts.lang,
          onProgress: opts.onProgress,
          timeoutMs: opts.timeoutMs,
        })
      : await transcribeWithWhisper(opts.audioPath, opts.workdir, opts.lang, opts.model ?? 'base', opts.whisper, opts.ffmpegDir);

  // 落盘 oil-subtitle 兼容的 transcript.json（目录可能未创建，百炼路径不会自动建目录）
  fs.mkdirSync(opts.workdir, { recursive: true });
  fs.writeFileSync(path.join(opts.workdir, 'transcript.json'), JSON.stringify(result.segments, null, 2) + '\n', 'utf-8');
  return result;
}

/** 本地 whisper 转录：--output_format json --word_timestamps */
async function transcribeWithWhisper(
  audioPath: string,
  workdir: string,
  lang: string,
  model: string,
  whisper?: string,
  ffmpegDir?: string,
): Promise<TranscribeResult> {
  if (!whisper) {
    throw new CliError('未指定 whisper 可执行文件（--whisper 路径 / VD_WHISPER 环境变量）', '转录');
  }
  const args = [audioPath, '--model', model, '--output_format', 'json', '--output_dir', workdir, '--word_timestamps', 'True'];
  if (lang && lang !== 'auto') args.push('--language', lang);

  // whisper 内部按名调用 ffmpeg；ffmpeg 不在 PATH 时，把其 bin 目录前插到子进程 PATH
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (ffmpegDir) env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH ?? ''}`;

  const code = await runAsync(whisper, args, { env });
  if (code !== 0) throw new CliError(`转录失败 退出码 ${code}`, '转录');

  const base = path.basename(audioPath, path.extname(audioPath));
  const jsonFile = path.join(workdir, `${base}.json`);
  if (!fs.existsSync(jsonFile)) throw new CliError('转录后未找到输出 json', '转录', `期望路径 ${jsonFile}`);

  let raw: { segments?: WhisperSegment[] };
  try {
    raw = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
  } catch (e) {
    throw new CliError('转录 json 解析失败', '转录', e instanceof Error ? e.message : String(e));
  }

  const segments: TranscriptSegment[] = (raw.segments ?? []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
    words: (s.words ?? []).map((w) => ({ start: w.start, end: w.end, text: w.word.trim() })),
  }));
  if (segments.length === 0) {
    throw new CliError('转录结果为空（可能为纯音乐或无语音），无法生成内容', '转录');
  }
  return { text: segments.map((s) => s.text).join(''), segments };
}
