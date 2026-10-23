import fs from 'node:fs';
import { runSyncArgs } from '@clibase/core';

/** 删除临时工作目录，best effort（失败不抛） */
export function removeWorkDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort：清理失败不应影响主流程结果
  }
}

/**
 * 结束本工作流启动的调试 Chrome。
 * 精确匹配命令行含 marker 的进程，绝不误杀用户自己的浏览器：
 *   - vcli-chrome-<port>  Windows 自启动的 Chrome（user-data-dir 标记）
 *   - cdp-cli-chrome-<port>  cdp-cli launch 启动的 Chrome
 * best effort：进程可能已退出。
 *
 * 用 runSyncArgs（spawnSync，不经 shell）调 powershell/pkill，
 * 避免 runSync 字符串命令在 cmd->powershell 间的引号转义问题。
 */
export function killDebugChrome(port: number): void {
  const markers = [`vcli-chrome-${port}`, `cdp-cli-chrome-${port}`];
  try {
    if (process.platform === 'win32') {
      const conds = markers.map((mk) => `$_.CommandLine -like '*${mk}*'`).join(' -or ');
      const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { ${conds} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
      runSyncArgs('powershell', ['-NoProfile', '-Command', ps]);
    } else {
      for (const mk of markers) {
        try {
          runSyncArgs('pkill', ['-f', mk]);
        } catch {
          // best effort：某个 marker 无匹配不影响另一个
        }
      }
    }
  } catch {
    // best effort：进程可能已退出
  }
}
