import path from 'node:path';
import fs from 'node:fs';
import { defineCommand, CliError, ensureDir } from '@clibase/core';
import type { NoteOptions } from '../lib/types.js';
import type { PageContent } from '../lib/pageread.js';
import { resolveTool } from '../lib/tools.js';
import { readNotePage } from '../lib/pageread.js';
import { killDebugChrome } from '../lib/cleanup.js';

/** 渲染纯文本结果（Markdown 风格，无 emoji） */
function renderNote(url: string, p: PageContent): string {
  const lines: string[] = [];
  lines.push(`# ${p.title}`);
  lines.push('');
  lines.push(`- 链接：${url}`);
  lines.push(`- 图片数：${p.imageUrls.length}`);
  lines.push('');
  lines.push('## 正文');
  lines.push('');
  lines.push(p.content);
  if (p.imageUrls.length > 0) {
    lines.push('');
    lines.push('## 图片');
    for (const u of p.imageUrls) lines.push(`- ${u}`);
  }
  return lines.join('\n');
}

/**
 * note 命令：图文笔记链接 -> 标题/正文/图片提取
 * 用 cdp-cli 打开页面，经 CDP Runtime.evaluate 提取（适配小红书图文）。
 */
export const noteCommand = defineCommand({
  name: 'note',
  description: '图文笔记链接 -> 标题/正文/图片提取（cdp-cli 打开页面，适配小红书图文，不依赖 whisper/LLM）',
  args: { name: 'url', description: '图文笔记链接（小红书等）', required: true },
  options: [
    { flags: '-o, --output <file>', description: '把结果写入文件（文本或 json）' },
    { flags: '--json', description: '输出 JSON 而非文本（默认文本）' },
    { flags: '--cdp-cli <path>', description: 'cdp-cli 可执行文件路径（默认 VD_CDP_CLI 或 PATH）' },
    { flags: '--wait <ms>', description: '页面加载等待毫秒数（默认 10000）', default: 10000 },
  ],
  action: async (ctx) => {
    const o = ctx.options as NoteOptions;
    const url = ctx.args[0]?.trim();
    if (!url) throw new CliError('请提供图文笔记链接', '参数校验');

    const cdpCli = resolveTool('cdp-cli', { optionPath: o.cdpCli });

    let chromePort = 0;
    let page: PageContent;
    try {
      ctx.spinner.start(`打开页面并提取（等待 ${o.wait}ms 加载）...`);
      const r = await readNotePage({ cdpPath: cdpCli, url, waitMs: o.wait });
      page = r.page;
      chromePort = r.chromePort;
      ctx.spinner.succeed(`提取完成（正文 ${page.content.length} 字，图片 ${page.imageUrls.length} 张）`);
    } finally {
      // 调试 Chrome 用完即清（readNotePage 失败路径已自带清理，此处覆盖成功路径）
      if (chromePort) killDebugChrome(chromePort);
    }

    const text = o.json ? JSON.stringify({ url, ...page }, null, 2) : renderNote(url, page);
    if (o.output) {
      ensureDir(path.dirname(path.resolve(o.output)));
      fs.writeFileSync(o.output, text + '\n', 'utf-8');
      ctx.logger.success(`已写入 ${o.output}`);
    } else {
      console.log(text);
    }
    return { success: true, message: `完成：${page.title}` };
  },
});
