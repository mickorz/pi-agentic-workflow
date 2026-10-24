import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cdpInfoToMetadata, pickAudioUrl } from '../src/lib/cdp-grab.js';

test('pickAudioUrl 取最后一条 media-audio（当前视频）', () => {
  const names = [
    'https://a/b/media-audio-und-mp4a?v=1',
    'https://cdn/x.css',
    'https://a/c/media-audio-und-mp4a?v=2',
    'https://a/d/media-video-avc1?v=9',
  ];
  assert.equal(pickAudioUrl(names), 'https://a/c/media-audio-und-mp4a?v=2');
  assert.equal(pickAudioUrl(['https://x/y.css']), '');
  assert.equal(pickAudioUrl([]), '');
});

test('cdpInfoToMetadata：作者不可得置空不臆测，时长 null 转 undefined', () => {
  const m = cdpInfoToMetadata(
    { audioUrl: 'u', videoUrl: '', durationSeconds: null, title: '标题 - 抖音', author: '' },
    'https://www.douyin.com/video/1',
  );
  assert.equal(m.title, '标题');
  assert.equal(m.uploader, '');
  assert.equal(m.durationSeconds, null);
  assert.equal(m.webpageUrl, 'https://www.douyin.com/video/1');
});
