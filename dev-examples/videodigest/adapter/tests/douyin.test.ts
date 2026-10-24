import assert from 'node:assert/strict';
import { test } from 'node:test';
import { awemeIdFromUrl, firstUrlFromText, inspectDouyinCookie, netscapeToCookieHeader, sourceKeyFor } from '../src/lib/douyin.js';

test('awemeIdFromUrl 提取 video/note/slides/modal_id', () => {
  assert.equal(awemeIdFromUrl('https://www.douyin.com/video/7381234567890123456'), '7381234567890123456');
  assert.equal(awemeIdFromUrl('https://www.douyin.com/note/7381234567890123457?from=share'), '7381234567890123457');
  assert.equal(awemeIdFromUrl('https://www.douyin.com/slides/7381234567890123458'), '7381234567890123458');
  assert.equal(awemeIdFromUrl('https://www.douyin.com/?modal_id=7381234567890123459'), '7381234567890123459');
  assert.equal(awemeIdFromUrl('https://www.douyin.com/user/profile?uid=1'), undefined);
  // 少于 6 位数字不算合法 id
  assert.equal(awemeIdFromUrl('https://www.douyin.com/video/123'), undefined);
});

test('firstUrlFromText 从中文文案提取 URL（中文标点截断）', () => {
  assert.equal(firstUrlFromText('看看这个 https://v.douyin.com/AbCdEf/ 很有意思'), 'https://v.douyin.com/AbCdEf/');
  assert.equal(firstUrlFromText('https://v.douyin.com/XyZ123/，快来看'), 'https://v.douyin.com/XyZ123/');
  assert.equal(firstUrlFromText('没有任何链接'), undefined);
  assert.equal(firstUrlFromText('两条链接 https://a.com/1 和 https://b.com/2'), 'https://a.com/1');
});

test('sourceKeyFor：抖音用 videoId，其它平台用 URL 摘要', () => {
  assert.equal(sourceKeyFor('douyin', '7381234567890123456', 'https://www.douyin.com/video/7381234567890123456'), 'douyin:7381234567890123456');
  const k1 = sourceKeyFor('other', null, 'https://example.com/watch?v=abc');
  const k2 = sourceKeyFor('other', null, 'https://example.com/watch?v=abc');
  const k3 = sourceKeyFor('other', null, 'https://example.com/watch?v=xyz');
  assert.ok(k1.startsWith('other:'));
  assert.equal(k1, k2, '同 URL 幂等');
  assert.notEqual(k1, k3, '不同 URL 不同键');
});

test('netscapeToCookieHeader 忽略注释/过期/短行，拼接 name=value', () => {
  const future = Math.floor(Date.now() / 1000) + 86400;
  const past = Math.floor(Date.now() / 1000) - 86400;
  const netscape = [
    '# Netscape HTTP Cookie File',
    '.douyin.com\tTRUE\t/\tTRUE\t' + future + '\tsessionid\tabc123',
    '#HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t' + future + '\tttwid\ttt456',
    '.douyin.com\tTRUE\t/\tTRUE\t' + past + '\texpired\told',
    'badline',
  ].join('\n');
  const header = netscapeToCookieHeader(netscape);
  assert.ok(header.includes('sessionid=abc123'));
  assert.ok(header.includes('ttwid=tt456'), '#HttpOnly_ 前缀行应被解析');
  assert.ok(!header.includes('expired'));
});

test('inspectDouyinCookie 登录态与过期体检', () => {
  const future = Math.floor(Date.now() / 1000) + 86400;
  const past = Math.floor(Date.now() / 1000) - 86400;
  const healthy = inspectDouyinCookie(`.douyin.com\tTRUE\t/\tTRUE\t${future}\tsessionid\tabc`);
  assert.equal(healthy.total, 1);
  assert.equal(healthy.hasSessionId, true);
  assert.equal(healthy.sessionIdExpired, false);
  const expired = inspectDouyinCookie(`.douyin.com\tTRUE\t/\tTRUE\t${past}\tsessionid\tabc`);
  assert.equal(expired.total, 0, '过期条目不计入 total');
  assert.equal(expired.sessionIdExpired, true, 'sessionid 条目硬过期');
});
