import fs from 'node:fs';
import path from 'node:path';
import { defineCommand, CliError } from '@clibase/core';
import {
  getSecUserId,
  listUserVideos,
  userVideosToMarkdown,
  netscapeToCookieHeader,
  inspectDouyinCookie,
  sortByLessonNumber,
} from '../lib/douyin.js';
import type { DouyinUserOptions } from '../lib/types.js';

/**
 * douyin-user 命令：抖音主播主页 -> 全部作品列表 markdown
 * 提取 sec_user_id 后循环翻页拉取作品（标题/时间/点赞/时长/链接），输出表格。
 * Cookie 优先级：--cookie 文件 > 内置公开 Cookie（风控拦截时建议用 cdp-cli 导出的登录 Cookie）。
 */
export const douyinUserCommand = defineCommand({
  name: 'douyin-user',
  description: '抖音主播主页 -> 全部作品列表 markdown 表格（标题 时间 链接）',
  args: { name: 'url', description: '主播主页链接或分享文案（选项请放在 URL 前面）', required: true },
  options: [
    { flags: '-o, --output <file>', description: 'markdown 输出文件（默认打印到终端）' },
    { flags: '--cookie <file>', description: 'Netscape cookies.txt（登录态更稳，可用 cdp-cli 导出）' },
    { flags: '--max-pages <n>', description: '最多翻页数（默认 100，每页 20 条）', default: 100 },
    { flags: '--filter <regex>', description: '按标题正则筛选作品（如 --filter "大模型|AI"）' },
    { flags: '--author <name>', description: '覆盖表格中的主播昵称（接口列表页不含昵称时使用）', default: '未知主播' },
  ],
  action: async (ctx) => {
    const o = ctx.options as DouyinUserOptions;
    const input = String(ctx.args[0] ?? '').trim();
    if (!input) throw new CliError('请提供主播主页链接', '参数校验');

    let cookie: string | undefined;
    if (o.cookie) {
      const file = path.resolve(String(o.cookie).trim());
      if (!fs.existsSync(file)) throw new CliError(`--cookie 指定的文件不存在：${file}`, '参数校验');
      const raw = fs.readFileSync(file, 'utf-8');

      // 用前体检：硬过期直接拦，软性风险（游客 cookie / 文件久远）警告后继续
      const health = inspectDouyinCookie(raw);
      if (health.total === 0) {
        throw new CliError(`cookies 文件中没有有效条目：${file}`, '参数校验');
      }
      if (health.sessionIdExpired) {
        throw new CliError(
          'cookie 已过期（sessionid 有效期已过）：请重新运行 vcli cookie douyin 导出',
          '参数校验',
          file,
        );
      }
      if (!health.hasSessionId) {
        ctx.logger.warn('cookie 文件缺少 sessionid（游客 cookie），被风控拦截的概率高，建议 vcli cookie douyin 重新导出');
      } else {
        const ageDays = (Date.now() - fs.statSync(file).mtimeMs) / 86400000;
        if (ageDays > 25) {
          ctx.logger.warn(`cookie 文件已 ${Math.round(ageDays)} 天未更新（抖音登录态一般 30 天内有效），建议重新导出`);
        }
      }
      cookie = netscapeToCookieHeader(raw);
    }

    ctx.spinner.start('解析主页链接...');
    const secUserId = await getSecUserId(input);
    ctx.spinner.succeed(`主页 ID：${secUserId.slice(0, 20)}...`);

    ctx.spinner.start('翻页拉取作品列表...');
    const { items: allItems, author } = await listUserVideos(secUserId, {
      cookie,
      maxPages: Number(o.maxPages ?? 100),
      onProgress: (msg) => ctx.spinner.start(msg),
    });

    // 可选筛选 + 课程编号升序（学习顺序模板）
    let items = allItems;
    if (o.filter) {
      try {
        const re = new RegExp(String(o.filter), 'i');
        items = items.filter((it) => re.test(it.title));
      } catch (e) {
        throw new CliError(`--filter 正则无效：${String(o.filter)}`, '参数校验', e instanceof Error ? e.message : String(e));
      }
      ctx.logger.info(`筛选后剩余 ${items.length}/${allItems.length} 条`);
    }
    items = sortByLessonNumber(items);
    ctx.spinner.succeed(`共获取 ${items.length} 个作品（编号课程升序排列）`);

    if (items.length === 0) {
      throw new CliError('未获取到任何作品（可能被风控拦截或主页为空，建议用 --cookie 提供登录 Cookie）', '抖音解析');
    }

    const displayName = author ?? String(o.author ?? '未知主播');
    if (author) ctx.logger.info(`主播昵称：${author}`);
    const md = userVideosToMarkdown(items, { author: displayName, secUserId });

    if (o.output) {
      const file = path.resolve(String(o.output).trim());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, md, 'utf-8');
      ctx.logger.success(`已保存 ${items.length} 条作品 -> ${file}`);
      return { success: true, message: `作品列表已生成：${file}` };
    }
    console.log(md);
    return { success: true, message: `已输出 ${items.length} 条作品` };
  },
});
