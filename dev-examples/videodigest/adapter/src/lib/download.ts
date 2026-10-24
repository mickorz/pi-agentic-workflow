import path from 'node:path';
import fs from 'node:fs';
import { runSyncArgs, runAsync, CliError } from './proc.js';
import type { VideoMetadata } from './types.js';

/**
 * yt-dlp 下载与元数据（移植自 Vcli download.ts）。
 */

/**
 * 从 yt-dlp 的 stdout 解析 JSON。
 * stdout 可能混有日志行，取最后一个以 { 开头的合法 JSON 行；全部失败则抛。
 */
export function parseLastJson(stdout: string, step: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === '') throw new CliError('yt-dlp 未返回 JSON', step, 'stdout 为空');
  try {
    return JSON.parse(trimmed);
  } catch {
    // 继续逐行查找
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i] as string);
    } catch {
      // 继续尝试更早的行
    }
  }
  throw new CliError('yt-dlp 返回的不是合法 JSON', step, trimmed.slice(0, 500));
}

/** 用 yt-dlp --dump-single-json 获取标题/作者/时长等元数据 */
export function dumpMetadata(opts: { ytdlp: string; url: string; cookiesFile?: string }): VideoMetadata {
  const args = ['--dump-single-json', '--no-download', '--no-playlist'];
  if (opts.cookiesFile) args.push('--cookies', opts.cookiesFile);
  args.push(opts.url);
  const r = runSyncArgs(opts.ytdlp, args);
  if (r.exitCode !== 0) {
    throw new CliError(`yt-dlp 获取元数据失败 退出码 ${r.exitCode}`, '获取元数据', (r.stderr || r.stdout).slice(0, 500));
  }
  const data = parseLastJson(r.stdout, '获取元数据') as Record<string, unknown>;
  return {
    title: String(data.title ?? '(未知标题)'),
    uploader: String(data.uploader ?? data.channel ?? '(未知)'),
    durationSeconds: typeof data.duration === 'number' ? data.duration : null,
    webpageUrl: String(data.webpage_url ?? opts.url),
  };
}

/** 下载音频并转 16kHz 单声道 WAV，返回 wav 路径 */
export async function fetchAudio(opts: {
  ytdlp: string;
  ffmpeg: string;
  url: string;
  workdir: string;
  cookiesFile?: string;
}): Promise<string> {
  const outTpl = path.join(opts.workdir, 'audio.%(ext)s');
  const args = [
    '-x',
    '--audio-format', 'wav',
    '--audio-quality', '0',
    '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1',
    // ffmpeg 不在 PATH 时靠它定位（传 bin 目录，yt-dlp 在此找 ffmpeg 与 ffprobe）
    '--ffmpeg-location', path.dirname(opts.ffmpeg),
    '-o', outTpl,
    '--no-playlist',
  ];
  if (opts.cookiesFile) args.push('--cookies', opts.cookiesFile);
  args.push(opts.url);
  // runAsync 实时输出下载进度（stdout 转发到 stderr，保持本进程 stdout 纯净）
  const code = await runAsync(opts.ytdlp, args);
  if (code !== 0) throw new CliError(`下载转码失败 退出码 ${code}`, '下载转码');
  const wav = path.join(opts.workdir, 'audio.wav');
  if (!fs.existsSync(wav)) throw new CliError('下载转码后未找到 audio.wav', '下载转码', `期望路径 ${wav}`);
  return wav;
}
