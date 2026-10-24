import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPlatform } from '../src/lib/platform.ts';
import { parseLastJson } from '../src/lib/download.ts';
import { convertBailianResult } from '../src/lib/bailian.ts';
import { CliError } from '../src/lib/proc.ts';

test('detectPlatform 域名识别', () => {
  assert.equal(detectPlatform('https://v.douyin.com/AbCdEf/').kind, 'douyin');
  assert.equal(detectPlatform('https://www.douyin.com/video/7381234567890123456').kind, 'douyin');
  assert.equal(detectPlatform('https://www.iesdouyin.com/share/video/1').kind, 'douyin');
  assert.equal(detectPlatform('https://www.bilibili.com/video/BV1xx').kind, 'bilibili');
  assert.equal(detectPlatform('https://b23.tv/abc').kind, 'bilibili');
  assert.equal(detectPlatform('https://www.xiaohongshu.com/explore/1').kind, 'xiaohongshu');
  assert.equal(detectPlatform('https://www.youtube.com/watch?v=1').kind, 'youtube');
  assert.equal(detectPlatform('https://example.com/watch').kind, 'other');
});

test('parseLastJson 取最后一个合法 JSON 行', () => {
  assert.deepEqual(parseLastJson('{"a":1}', 't'), { a: 1 });
  assert.deepEqual(parseLastJson('log line\n{"a":1}\nanother\n{"b":2}', 't'), { b: 2 });
  assert.throws(() => parseLastJson('', 't'), CliError);
  assert.throws(() => parseLastJson('no json here', 't'), CliError);
});

test('convertBailianResult：sentences→segments、词级时间戳、排序', () => {
  const payload = {
    transcripts: [
      {
        sentences: [
          {
            begin_time: 2000,
            end_time: 4000,
            text: '第二句',
            words: [
              { text: '第二', begin_time: 2000, end_time: 3000, punctuation: '' },
              { text: '句', begin_time: 3000, end_time: 4000, punctuation: '。' },
            ],
          },
          {
            begin_time: 0,
            end_time: 1900,
            text: '第一句',
            words: [{ begin_time: 0, end_time: 1900, text: '第一句', punctuation: '！' }],
          },
        ],
      },
    ],
  };
  const segs = convertBailianResult(payload);
  assert.equal(segs.length, 2);
  assert.equal(segs[0]?.text, '第一句', '按 start 排序');
  assert.equal(segs[0]?.start, 0);
  assert.equal(segs[1]?.start, 2, '毫秒转秒');
  assert.equal(segs[1]?.words[1]?.text, '句。', 'word 文本+尾随标点');
  assert.deepEqual(convertBailianResult({ transcripts: [{}] }), []);
  assert.deepEqual(convertBailianResult({}), []);
});

test('CliError 携带 step 与 details', () => {
  const e = new CliError('msg', '步骤', '详情');
  assert.ok(e instanceof CliError);
  assert.equal(e.step, '步骤');
  assert.equal(e.details, '详情');
});
