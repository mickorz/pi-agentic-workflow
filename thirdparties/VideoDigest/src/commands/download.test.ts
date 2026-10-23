import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  sanitizeFilename,
  resolveOutput,
  buildOutTemplate,
  resolveActualOutput,
  parseListMarkdown,
  markListDownloaded,
  FORMATS,
} from './download.js';

describe('parseListMarkdown', () => {
  const md = [
    '# 某主播 的抖音作品列表',
    '',
    '| # | 标题 | 发布时间 | 点赞 | 时长 | 链接 | 下载状态 | 下载重命名 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 1 | 课程一 | 2025-09-01 | 10 | 300 秒 | https://www.douyin.com/video/111 | 待下载 | 1.预训练 |',
    '| 2 | 课程二 | 2025-09-02 | 20 | 400 秒 | https://www.douyin.com/video/222 | 已下载 | 2.微调 |',
    '| 3 | 课程三 | 2025-09-03 | 30 | - | https://www.douyin.com/video/333 | 下载失败 | 3.KV Cache提速 |',
  ].join('\n');

  it('提取链接与重命名，跳过已下载', () => {
    const entries = parseListMarkdown(md);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ url: 'https://www.douyin.com/video/111', name: '1.预训练' });
    expect(entries[1]).toMatchObject({ url: 'https://www.douyin.com/video/333', name: '3.KV Cache提速' });
  });

  it('无状态列时全部提取（不跳过任何行）', () => {
    const noStatus = [
      '| # | 标题 | 发布时间 | 点赞 | 时长 | 链接 | 下载重命名 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| 1 | a | t | 1 | - | https://www.douyin.com/video/111 | 1.预训练 |',
      '| 2 | b | t | 2 | - | https://www.douyin.com/video/222 | 2.微调 |',
    ].join('\n');
    const entries = parseListMarkdown(noStatus);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ name: '2.微调' });
  });
});

describe('markListDownloaded', () => {
  it('待下载改为已下载，其余行不动', () => {
    const line = '| 1 | 课程一 | 2025-09-01 | 10 | 300 秒 | https://www.douyin.com/video/111 | 待下载 | 1.预训练 |';
    const other = '| 2 | 课程二 | 2025-09-02 | 20 | - | https://www.douyin.com/video/222 | 待下载 | 2.微调 |';
    const md = ['| # | 标题 | 发布时间 | 点赞 | 时长 | 链接 | 下载状态 | 下载重命名 |', '| --- |', line, other].join('\n');
    const entry = parseListMarkdown(md)[0]!;
    const out = markListDownloaded(md, entry);
    expect(out).toContain('111 | 已下载 | 1.预训练');
    expect(out).toContain('222 | 待下载 | 2.微调');
  });
});

describe('sanitizeFilename', () => {
  it('保留中文与空格', () => {
    expect(sanitizeFilename('我 的 视频 标题')).toBe('我 的 视频 标题');
  });

  it('替换 Windows/Unix 非法字符为下划线', () => {
    expect(sanitizeFilename('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i');
  });

  it('压缩连续空白', () => {
    expect(sanitizeFilename('a   b\tc')).toBe('a b c');
  });

  it('空标题兜底为 audio', () => {
    expect(sanitizeFilename('')).toBe('audio');
    expect(sanitizeFilename('   ')).toBe('audio');
  });

  it('清理控制字符', () => {
    expect(sanitizeFilename('a\x00b\x01c')).toBe('a_b_c');
  });
});

describe('resolveOutput', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vcli-dl-test-'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('不传 output 时 outDir=cwd 且无 outName', () => {
    const r = resolveOutput(undefined, false, cwd);
    expect(r.outDir).toBe(cwd);
    expect(r.outName).toBeUndefined();
  });

  it('已存在目录 -> 当作目录', () => {
    const sub = path.join(cwd, 'sub');
    fs.mkdirSync(sub);
    const r = resolveOutput(sub, false, cwd);
    expect(r.outDir).toBe(sub);
    expect(r.outName).toBeUndefined();
  });

  it('以分隔符结尾 -> 当作目录（去掉尾分隔符）', () => {
    const r = resolveOutput(path.join(cwd, 'out') + path.sep, false, cwd);
    expect(r.outDir).toBe(path.join(cwd, 'out'));
    expect(r.outName).toBeUndefined();
  });

  it('单链接且 basename 含扩展名 -> 当作文件名', () => {
    const r = resolveOutput(path.join(cwd, 'music.wav'), false, cwd);
    expect(r.outDir).toBe(cwd);
    expect(r.outName).toBe('music.wav');
  });

  it('单链接无扩展名 -> 当作目录', () => {
    const r = resolveOutput(path.join(cwd, 'outdir'), false, cwd);
    expect(r.outDir).toBe(path.join(cwd, 'outdir'));
    expect(r.outName).toBeUndefined();
  });

  it('多链接一律当作目录（即使像文件名）', () => {
    const r = resolveOutput(path.join(cwd, 'music.wav'), true, cwd);
    expect(r.outDir).toBe(path.join(cwd, 'music.wav'));
    expect(r.outName).toBeUndefined();
  });
});

describe('buildOutTemplate', () => {
  it('未指定文件名 + wav -> title.wav（固定扩展名）', () => {
    expect(buildOutTemplate('/out', undefined, '标题', 'wav')).toBe(
      path.join('/out', '标题.wav'),
    );
  });

  it('未指定文件名 + best -> title.%(ext)s（占位）', () => {
    expect(buildOutTemplate('/out', undefined, '标题', 'best')).toBe(
      path.join('/out', '标题.%(ext)s'),
    );
  });

  it('指定文件名且有扩展名 -> 原样使用', () => {
    expect(buildOutTemplate('/out', 'custom.mp3', '标题', 'wav')).toBe(
      path.join('/out', 'custom.mp3'),
    );
  });

  it('指定文件名但无扩展名 + wav -> 补 .wav', () => {
    expect(buildOutTemplate('/out', 'custom', '标题', 'wav')).toBe(
      path.join('/out', 'custom.wav'),
    );
  });

  it('指定文件名但无扩展名 + best -> 补 .%(ext)s', () => {
    expect(buildOutTemplate('/out', 'custom', '标题', 'best')).toBe(
      path.join('/out', 'custom.%(ext)s'),
    );
  });
});

describe('resolveActualOutput', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcli-dl-resolve-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('模板无占位且文件存在 -> 直接返回', () => {
    const p = path.join(dir, '标题.wav');
    fs.writeFileSync(p, 'x');
    expect(resolveActualOutput(p, dir, 'wav')).toBe(p);
  });

  it('模板无占位但文件不存在 -> undefined', () => {
    expect(resolveActualOutput(path.join(dir, 'no.wav'), dir, 'wav')).toBeUndefined();
  });

  it('best 模板含占位 -> 按候选扩展名匹配', () => {
    const tmpl = path.join(dir, '标题.%(ext)s');
    const real = path.join(dir, '标题.webm');
    fs.writeFileSync(real, 'x');
    expect(resolveActualOutput(tmpl, dir, 'best')).toBe(real);
  });

  it('固定格式模板含占位 -> 只匹配该扩展名', () => {
    const tmpl = path.join(dir, '标题.%(ext)s');
    const real = path.join(dir, '标题.wav');
    fs.writeFileSync(real, 'x');
    // 故意放一个 mp3 不应被选中
    fs.writeFileSync(path.join(dir, '标题.mp3'), 'x');
    expect(resolveActualOutput(tmpl, dir, 'wav')).toBe(real);
  });

  it('占位匹配失败 -> 目录前缀兜底取最近修改', () => {
    const tmpl = path.join(dir, '标题.%(ext)s');
    const real = path.join(dir, '标题.opus');
    fs.writeFileSync(real, 'x');
    // 候选列表无 opus 但前缀兜底应命中
    expect(resolveActualOutput(tmpl, dir, 'best')).toBe(real);
  });

  it('无任何匹配 -> undefined', () => {
    expect(resolveActualOutput(path.join(dir, 'x.%(ext)s'), dir, 'best')).toBeUndefined();
  });
});

describe('FORMATS', () => {
  it('包含四种格式且 best 在最后', () => {
    expect(FORMATS).toEqual(['wav', 'mp3', 'm4a', 'best']);
  });
});
