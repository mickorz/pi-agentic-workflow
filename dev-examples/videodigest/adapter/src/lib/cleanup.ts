import fs from 'node:fs';
import { runSyncArgs } from './proc.js';

/** 删除临时工作目录，best effort（失败不抛） */
export function removeWorkDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * 结束调试 Chrome（精确匹配命令行 marker，绝不误杀用户浏览器）：
 *   - videodigest-adapter-chrome-<port>（Windows 自启动标记，本 adapter 未用，预留）
 *   - cdp-cli-chrome-<port>（cdp-cli launch 启动）
 * best effort：进程可能已退出。
 */
export function killDebugChrome(port: number): void {
  const markers = [`videodigest-adapter-chrome-${port}`, `cdp-cli-chrome-${port}`];
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
          // best effort
        }
      }
    }
  } catch {
    // best effort
  }
}
