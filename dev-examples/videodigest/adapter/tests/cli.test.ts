import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * CLI 冒烟：对 dist 构建产物执行 resolve（先 npx tsc -p dev-examples/videodigest/adapter）。
 * 规范长链（www.douyin.com/video/<id>）纯确定性解析，不需要网络（短链才 fetch 302）。
 */
function runCli(args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });
    return { stdout, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 };
  }
}

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;

test('resolve 规范长链：确定性输出 sourceKey（无网络）', () => {
  const r = runCli(['resolve', '--url', 'https://www.douyin.com/video/7381234567890123456']);
  assert.equal(r.exitCode, 0, r.stdout);
  const j = JSON.parse(r.stdout) as { ok: boolean; platform: string; videoId: string; sourceKey: string; canonicalUrl: string };
  assert.equal(j.ok, true);
  assert.equal(j.platform, 'douyin');
  assert.equal(j.videoId, '7381234567890123456');
  assert.equal(j.sourceKey, 'douyin:7381234567890123456');
});

test('resolve 带文案的链接', () => {
  const r = runCli(['resolve', '--url', '提取这个 https://www.douyin.com/video/7389876543210987654?from=share 谢谢']);
  assert.equal(r.exitCode, 0, r.stdout);
  const j = JSON.parse(r.stdout) as { sourceKey: string };
  assert.equal(j.sourceKey, 'douyin:7389876543210987654');
});

test('resolve 非视频页（用户页）失败且错误结构化', () => {
  const r = runCli(['resolve', '--url', 'https://www.douyin.com/user/profile?uid=1']);
  assert.equal(r.exitCode, 1);
  const j = JSON.parse(r.stdout) as { ok: boolean; error: { message: string; step?: string } };
  assert.equal(j.ok, false);
  assert.ok(j.error.message.includes('视频 ID'));
});

test('resolve 缺 --url 报参数错', () => {
  const r = runCli(['resolve']);
  assert.equal(r.exitCode, 1);
});

test('extract 缓存命中：已有 transcript.json 不重复下载/转写', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-cache-'));
  fs.writeFileSync(path.join(tmp, 'transcript.json'), JSON.stringify([{ text: '已提炼内容。' }]), 'utf-8');
  fs.writeFileSync(path.join(tmp, 'metadata.json'), JSON.stringify({ title: '缓存标题', uploader: '作者', durationSeconds: 42, webpageUrl: 'https://www.douyin.com/video/7381234567890123456' }), 'utf-8');
  const r = runCli([ 'extract', '--url', 'https://www.douyin.com/video/7381234567890123456', '--workdir', tmp ]);
  const out = JSON.parse(r.stdout) as { ok: boolean; cached?: boolean; transcriptText?: string; metadata?: { title: string } };
  assert.equal(r.exitCode, 0);
  assert.equal(out.ok, true);
  assert.equal(out.cached, true);
  assert.equal(out.transcriptText, '已提炼内容。');
  assert.equal(out.metadata?.title, '缓存标题');
  fs.rmSync(tmp, { recursive: true, force: true });
});
