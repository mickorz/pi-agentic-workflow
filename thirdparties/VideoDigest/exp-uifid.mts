import { netscapeToCookieHeader } from './src/lib/douyin.js';
import { spawnSync } from 'node:child_process';
import abogusPkg from '@moonr/abogus';
const { generate_a_bogus } = abogusPkg as unknown as { generate_a_bogus: (params: string, ua: string) => string };
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const cookieFile = fs.readFileSync(path.join('C:/Users/zhangqi95', '.config/vcli/cookies/douyin.txt'), 'utf-8');
const header = netscapeToCookieHeader(cookieFile);
const uifid = (header.match(/UIFID=([^;]+)/) ?? [])[1] ?? '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36';
const SEC = 'MS4wLjABAAAAvn49F9x9xa7R7TvSrnh6SXM4MSjHx7-2gFWg35Cnucs';

function tryFetch(extra: Record<string, string>, label: string) {
  const base: Record<string, string> = {
    device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1',
    version_code: '290100', version_name: '29.1.0', cookie_enabled: 'true',
    screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN', browser_platform: 'Win32',
    browser_name: 'Chrome', browser_version: '130.0.0.0', browser_online: 'true',
    engine_name: 'Blink', engine_version: '130.0.0.0', os_name: 'Windows', os_version: '10',
    cpu_core_num: '12', device_memory: '8', platform: 'PC', downlink: '10', effective_type: '4g',
    from_user_page: '1', locate_query: 'false', need_time_list: '1', pc_libra_divert: 'Windows',
    publish_video_strategy_type: '2', round_trip_time: '0', show_live_replay_strategy: '1',
    time_list_query: '0', whale_cut_token: '', update_version_code: '170400', msToken: '',
    sec_user_id: SEC, max_cursor: '0', count: '20', ...extra,
  };
  const qs = new URLSearchParams(base);
  const ab = generate_a_bogus(qs.toString(), UA);
  const url = `https://www.douyin.com/aweme/v1/web/aweme/post/?${qs.toString()}&a_bogus=${encodeURIComponent(ab)}`;
  const tmp = path.join(os.tmpdir(), `exp-${process.pid}.json`);
  spawnSync('curl', ['-s', '--max-time', '20', '-H', `User-Agent: ${UA}`,
    '-H', 'Accept: application/json, text/plain, */*', '-H', 'Referer: https://www.douyin.com/',
    '-H', `Cookie: ${header}`, '-o', tmp, url], { encoding: 'utf-8' });
  const body = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf-8') : '';
  fs.rmSync(tmp, { force: true });
  let ok: string;
  try { const j = JSON.parse(body); ok = `aweme_list=${(j.aweme_list ?? []).length} has_more=${j.has_more}`; } catch { ok = `非JSON(${body.slice(0, 60)})`; }
  console.log(`[${label}] ${ok}`);
}

tryFetch({ uifid }, '带uifid参数');
tryFetch({ uifid, webid: '7305954266958856710' }, '带uifid加webid');
