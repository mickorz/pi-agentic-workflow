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
  const r = spawnSync(file, args, { encoding: 'utf-8' });
  return {
    exitCode: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error,
  };
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
