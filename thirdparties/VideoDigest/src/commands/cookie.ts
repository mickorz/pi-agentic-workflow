import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defineCommand, CliError, ensureDir } from '@clibase/core';
import { TABLE } from '../lib/platform.js';
import { resolveTool } from '../lib/tools.js';
import { cdpLaunch, exportDomainCookies } from '../lib/cookies.js';
import { killDebugChrome } from '../lib/cleanup.js';
import type { CookieOptions } from '../lib/types.js';

/**
 * cookie 命令：打开指定平台网页版 -> 用户扫码登录 -> 自动导出 cookies.txt
 * 例：vcli cookie douyin
 * 默认保存到 ~/.config/vcli/cookies/<平台>.txt，--cookie 可直接喂给 douyin-user/digest。
 */
export const cookieCommand = defineCommand({
  name: 'cookie',
  description: '打开平台网页版扫码登录并导出 cookies.txt（抖音/小红书等，供 douyin-user 与 digest 使用）',
  args: { name: 'platform', description: '平台：douyin / xiaohongshu / bilibili / youtube', required: true },
  options: [
    { flags: '-o, --output <file>', description: 'cookies.txt 输出路径（默认 ~/.config/vcli/cookies/<平台>.txt）' },
    { flags: '--timeout <sec>', description: '等待扫码登录的超时秒数（默认 120）', default: 120 },
    { flags: '--cdp-cli <path>', description: 'cdp-cli 可执行文件路径（默认 VD_CDP_CLI 或 PATH）' },
  ],
  action: async (ctx) => {
    const o = ctx.options as CookieOptions;
    const name = String(ctx.args[0] ?? '').trim().toLowerCase();
    const platform = (TABLE as Record<string, (typeof TABLE)['douyin']>)[name];
    if (!platform) {
      throw new CliError(
        `不支持的平台：${name}`,
        '参数校验',
        `可用平台：${Object.keys(TABLE).join(' / ')}`,
      );
    }

    const cdpCli = resolveTool('cdp-cli', { optionPath: o.cdpCli });
    const target =
      o.output
        ? path.resolve(String(o.output).trim())
        : path.join(os.homedir(), '.config', 'vcli', 'cookies', `${name}.txt`);
    ensureDir(path.dirname(target));

    let port = 0;
    try {
      port = await cdpLaunch(cdpCli);
      const r = await exportDomainCookies({
        cdpPath: cdpCli,
        port,
        outDir: path.dirname(target),
        domainKeyword: platform.domainKeyword,
        siteUrl: platform.siteUrl,
        loginCookieNames: platform.loginCookieNames,
        loginTimeoutMs: Number(o.timeout ?? 120) * 1000,
        logger: ctx.logger,
      });

      // exportDomainCookies 固定写 cookies-<域>.txt，按目标名归一（同名则原位）
      if (r.cookiesFile !== target) {
        fs.renameSync(r.cookiesFile, target);
      }
      ctx.logger.success(`已保存 ${r.count} 条 cookie -> ${target}`);
      ctx.logger.info(`使用方式：vcli douyin-user <主页链接> --cookie "${target}"`);
      return { success: true, message: `cookie 已保存：${target}` };
    } finally {
      // 只杀本命令启动的调试 Chrome；复用用户已开的则不动
      if (port) killDebugChrome(port);
    }
  },
});
