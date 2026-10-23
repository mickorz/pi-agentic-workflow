import path from 'node:path';
import { runSyncArgs, CliError } from '@clibase/core';

/** 受管理的外部工具 */
export type ToolName = 'yt-dlp' | 'ffmpeg' | 'whisper' | 'cdp-cli';

/** 对应的命令行 flag（用于错误提示） */
const FLAG_NAME: Record<ToolName, string> = {
  'yt-dlp': '--ytdlp',
  ffmpeg: '--ffmpeg',
  whisper: '--whisper',
  'cdp-cli': '--cdp-cli',
};

/** 对应的环境变量名 */
const ENV_NAME: Record<ToolName, string> = {
  'yt-dlp': 'VD_YTDLP',
  ffmpeg: 'VD_FFMPEG',
  whisper: 'VD_WHISPER',
  'cdp-cli': 'VD_CDP_CLI',
};

/** 用 where(Windows)/which(Unix) 探测命令在 PATH 中的位置，找不到返回 undefined */
function probePath(name: string): string | undefined {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = runSyncArgs(probe, [name]);
  if (r.exitCode !== 0 || !r.stdout.trim()) return undefined;
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
}

/**
 * 工具路径解析，三级优先：
 *   1. --<tool> 选项（optionPath）
 *   2. VD_<TOOL> 环境变量
 *   3. where/which 探测 PATH
 * 三者都没有则抛 CliError，details 给出三种修复方式
 */
export function resolveTool(
  name: ToolName,
  opts: { optionPath?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = opts.env ?? process.env;
  if (opts.optionPath && opts.optionPath.trim() !== '') return opts.optionPath.trim();
  const envVal = env[ENV_NAME[name]];
  if (envVal && envVal.trim() !== '') return envVal.trim();
  const found = probePath(name);
  if (found) return found;
  throw new CliError(
    `未找到 ${name}，且不在 PATH 中`,
    '工具解析',
    `请用 ${FLAG_NAME[name]} <路径> 指定，或设置环境变量 ${ENV_NAME[name]}，或把 ${name} 所在目录加入 PATH`,
  );
}

/** 取可执行文件所在目录（用于把 ffmpeg 的 bin 前插到 whisper 子进程 PATH） */
export function dirOf(exePath: string): string {
  return path.dirname(exePath);
}
