import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 提取运行日志：每次 digest 运行写一份 markdown 到 ~/.video-digest/logs/，
 * 记录每条链接的步骤时间线、成功/失败、原始报错与处理结果，
 * 便于事后分析"为什么失败、卡在哪一步、如何解决"。
 * best effort：日志写入失败不影响主流程。
 */

/** 单条链接的步骤记录 */
export interface LogStep {
  /** 步骤名 如 获取元数据 */
  name: string;
  /** 本地时间戳 HH:mm:ss */
  time: string;
  /** 本步骤耗时毫秒（与上一步骤的时间差；首步为链接开始到本步） */
  elapsedMs?: number;
  /** ok=成功 fail=失败 info=中性信息 */
  status: 'ok' | 'fail' | 'info';
  /** 补充说明（报错摘要、耗时、处理结果等） */
  note?: string;
}

/** 单条链接的完整日志 */
export interface LogLink {
  url: string;
  /** 最终结果：成功/失败/跳过 */
  outcome: '成功' | '失败';
  /** 图文/视频 类型检测结论 */
  kind?: string;
  steps: LogStep[];
  /** 链接总耗时毫秒 */
  totalMs?: number;
}

/** 一次运行的批次日志 */
export interface RunLog {
  /** 命令与参数摘要 */
  command: string;
  /** 本地时间戳（用于文件名与文首） */
  startedAt: Date;
  links: LogLink[];
  /** 汇总 N/M */
  summary?: string;
}

/** 毫秒格式化为人类可读耗时 如 1分23秒 / 45秒 / 500毫秒 */
function fmtMs(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return '';
  if (ms < 1000) return `${ms}毫秒`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return m < 60 ? `${m}分${rs > 0 ? `${rs}秒` : ''}` : `${Math.floor(m / 60)}时${m % 60}分`;
}

/** 生成 markdown 文本 */
function render(log: RunLog): string {
  const lines: string[] = [];
  lines.push(`# 提取运行日志`);
  lines.push('');
  lines.push(`- 命令：${log.command}`);
  lines.push(`- 开始：${log.startedAt.toLocaleString('zh-CN')}`);
  lines.push(`- 链接数：${log.links.length}`);
  lines.push('');
  // 阶段耗时汇总：跨链接聚合同名阶段的累计与均值，定位耗时大头
  const stageAgg = new Map<string, { totalMs: number; count: number; maxMs: number }>();
  for (const link of log.links) {
    for (const s of link.steps) {
      if (s.elapsedMs === undefined) continue;
      const cur = stageAgg.get(s.name) ?? { totalMs: 0, count: 0, maxMs: 0 };
      cur.totalMs += s.elapsedMs;
      cur.count += 1;
      cur.maxMs = Math.max(cur.maxMs, s.elapsedMs);
      stageAgg.set(s.name, cur);
    }
  }
  if (stageAgg.size > 0) {
    lines.push(`## 阶段耗时汇总`);
    lines.push('');
    lines.push('| 阶段 | 累计 | 次数 | 平均 | 最长 |');
    lines.push('| --- | --- | --- | --- | --- |');
    // 按累计耗时降序，大头排前面
    const rows = [...stageAgg.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
    for (const [name, agg] of rows) {
      lines.push(`| ${name} | ${fmtMs(agg.totalMs)} | ${agg.count} | ${fmtMs(Math.round(agg.totalMs / agg.count))} | ${fmtMs(agg.maxMs)} |`);
    }
    lines.push('');
  }
  for (let i = 0; i < log.links.length; i++) {
    const link = log.links[i]!;
    lines.push(`## [${i + 1}] ${link.outcome}${link.kind ? `（${link.kind}）` : ''}${link.totalMs !== undefined ? ` 总耗时 ${fmtMs(link.totalMs)}` : ''}`);
    lines.push('');
    lines.push(`- 链接：${link.url}`);
    lines.push('');
    lines.push('| 时间 | 步骤 | 耗时 | 状态 | 说明 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const s of link.steps) {
      const mark = s.status === 'ok' ? '成功' : s.status === 'fail' ? '失败' : '-';
      const note = (s.note ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
      lines.push(`| ${s.time} | ${s.name} | ${fmtMs(s.elapsedMs)} | ${mark} | ${note} |`);
    }
    lines.push('');
  }
  if (log.summary) {
    lines.push(`## 汇总`);
    lines.push('');
    lines.push(log.summary);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

/** 日志目录：~/.video-digest/logs */
export function logDir(): string {
  return path.join(os.homedir(), '.video-digest', 'logs');
}

/** 生成日志文件名 digest-YYYYMMDD-HHmmss.md */
function logFileName(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `digest-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.md`;
}

/** 把运行日志写盘，返回文件路径；best effort 失败返回 undefined */
export function writeRunLog(log: RunLog): string | undefined {
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, logFileName(log.startedAt));
    fs.writeFileSync(file, render(log), 'utf-8');
    return file;
  } catch {
    return undefined;
  }
}
