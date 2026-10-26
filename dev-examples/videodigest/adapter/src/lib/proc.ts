import { spawn, spawnSync } from 'node:child_process';

/**
 * @clibase/core 三薄封装的本地替换（源码级验证结论：digest 单视频链路仅用这三者）。
 * 适配本 adapter 的输出契约：stdout 只留 JSON，进度日志全部走 stderr。
 */

/** 业务错误：message + 所属步骤 + 详情（对齐 Vcli CliError 的使用面） */
export class CliError extends Error {
  readonly step?: string;
  readonly details?: string;

  constructor(message: string, step?: string, details?: string) {
    super(message);
    this.name = 'CliError';
    this.step = step;
    this.details = details;
  }
}

/** 同步子进程结果（对齐 runSyncArgs 的使用面：exitCode/stdout/stderr/error） */
export interface SyncRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** 同步执行（不经 shell），返回退出码与捕获的输出 */
export function runSyncArgs(file: string, args: string[]): SyncRunResult {
  let f = file;
  let a = args;
  // Windows：Node 不允许 spawnSync 直跑 .cmd/.bat（EINVAL），需 cmd /d /s /c 包装；
  // 含空格/特殊字符的参数套双引号（调用方须保证参数内无双引号，见 GRAB_JS 注释）
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    f = 'cmd';
    a = ['/d', '/s', '/c', [file, ...args].map(cmdQuote).join(' ')];
    // verbatim：禁止 Node 自动转义内嵌引号（\" 会被 CRT 当字面引号拆碎参数），引号完全由 cmdQuote 自管
    const r = spawnSync(f, a, { encoding: 'utf-8', windowsVerbatimArguments: true });
    return {
      exitCode: r.status ?? -1,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      error: r.error,
    };
  }
  const r = spawnSync(f, a, { encoding: 'utf-8' });
  return {
    exitCode: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error,
  };
}

/** cmd /c 参数加引号：含空白或 cmd 元字符的参数套双引号（参数内不得含双引号） */
function cmdQuote(s: string): string {
  return /^[^\s|&^%<>"()=!;,+]+$/.test(s) ? s : `"${s}"`;
}

/**
 * 异步执行（实时进度）：stdout 转发到 stderr 保持本进程 stdout 纯净（JSON 契约），
 * 返回退出码（非零不抛，由调用方自检）。
 */
export function runAsync(file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: opts?.env,
    });
    child.stdout?.on('data', (d: Buffer) => process.stderr.write(d));
    child.on('error', (e) => {
      process.stderr.write(`[adapter] 无法执行 ${file}: ${String(e)}\n`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
}
