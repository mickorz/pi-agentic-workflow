import { describe, it, expect } from 'vitest';
import {
  awemeIdFromUrl,
  firstUrlFromText,
  awemeTypeKind,
  normalizeDouyinVideo,
  secUserIdFromUrl,
  formatDouyinTime,
  escapeMdCell,
  userVideosToMarkdown,
  netscapeToCookieHeader,
  inspectDouyinCookie,
  videoShortName,
  lessonNumber,
  clipTitleUnits,
  sortByLessonNumber,
  type DouyinUserVideoItem,
} from './douyin.js';
import type { DouyinAwemeDetailPayload } from './douyin.js';

describe('awemeIdFromUrl', () => {
  it('提取 video 路径 id', () => {
    expect(awemeIdFromUrl('https://www.douyin.com/video/7372484719365098803')).toBe('7372484719365098803');
  });

  it('提取 note 与 slides 路径 id（图集）', () => {
    expect(awemeIdFromUrl('https://www.douyin.com/note/1234567890123456789?from=share')).toBe('1234567890123456789');
    expect(awemeIdFromUrl('https://www.douyin.com/slides/9876543210987654321')).toBe('9876543210987654321');
  });

  it('提取 modal_id 查询参数', () => {
    expect(awemeIdFromUrl('https://www.douyin.com/user/xx?modal_id=7334525738793618688')).toBe('7334525738793618688');
  });

  it('支持 iesdouyin 分享域', () => {
    expect(awemeIdFromUrl('https://www.iesdouyin.com/share/video/6914948781100338440/')).toBe('6914948781100338440');
  });

  it('无匹配返回 undefined', () => {
    expect(awemeIdFromUrl('https://www.douyin.com/discover')).toBeUndefined();
  });
});

describe('firstUrlFromText', () => {
  it('从分享文案混排中抽出链接', () => {
    const text = '8.88 复制打开抖音 https://v.douyin.com/L5pbfdP/ 萧萧的视频';
    expect(firstUrlFromText(text)).toBe('https://v.douyin.com/L5pbfdP/');
  });

  it('中文标点截断链接', () => {
    expect(firstUrlFromText('看这个https://v.douyin.com/abc/，很赞')).toBe('https://v.douyin.com/abc/');
  });

  it('无 URL 返回 undefined', () => {
    expect(firstUrlFromText('纯文案没有链接')).toBeUndefined();
  });
});

describe('awemeTypeKind', () => {
  it('视频类型码', () => {
    for (const code of [0, 4, 51, 55, 58, 61]) expect(awemeTypeKind(code)).toBe('video');
  });

  it('图集类型码与未知码归为 image', () => {
    for (const code of [2, 68, 150]) expect(awemeTypeKind(code)).toBe('image');
    expect(awemeTypeKind(undefined)).toBe('image');
    expect(awemeTypeKind(999)).toBe('image');
  });
});

describe('secUserIdFromUrl', () => {
  it('提取主页 sec_user_id', () => {
    expect(secUserIdFromUrl('https://www.douyin.com/user/MS4wLjABAAAAabc123')).toBe('MS4wLjABAAAAabc123');
  });

  it('带查询参数与/profile 不误判', () => {
    expect(secUserIdFromUrl('https://www.douyin.com/user/MS4wLjABxxxx?from=share')).toBe('MS4wLjABxxxx');
    expect(secUserIdFromUrl('https://www.douyin.com/profile/self?showTab=post')).toBeUndefined();
  });
});

describe('videoShortName', () => {
  it('去栏目前缀与编号，取冒号前主题词', () => {
    expect(videoShortName('【这就是大模型】085、中期训练：夯实模型关键能力 衔接预训练与微调')).toBe('中期训练');
    expect(videoShortName('084、预训练：让模型掌握通用语言规律')).toBe('预训练');
  });

  it('无冒号取第一个标点前', () => {
    expect(videoShortName('用AI效率低，因为你总在解决个性问题')).toBe('用AI效率低');
    expect(videoShortName('002、普通人学大模型，为什么要先抓住机器学习这根线头？')).toBe('普通人学大模型');
  });

  it('英文词不切断且合法', () => {
    expect(videoShortName('053、Transformer全貌：完整架构一览')).toBe('Transformer全貌');
    expect(videoShortName('065、FlashAttention：破解模型推理的数据难题')).toBe('FlashAttention');
    expect(videoShortName('066、KV Cache：根除大模型的重复计算顽疾')).toBe('KV Cache');
  });

  it('清理引号与文件名非法字符', () => {
    expect(videoShortName('大模型的“大”麻烦。数据层面的风险')).toBe('大模型的大麻烦');
  });

  it('主题太短退化取开头并按宽度截断', () => {
    // 空格不再作为分隔符，问号前整段截到 10 宽（英文词不切）
    expect(videoShortName('普通人为什么越学 AI 越焦虑？')).toBe('普通人为什么越学 AI');
  });

  it('只剩标签时从标签提取', () => {
    expect(videoShortName('#AI #监督学习')).toBe('AI 监督学习');
    expect(videoShortName('##')).toBe('未命名');
  });
});

describe('clipTitleUnits', () => {
  it('中文计 1 ASCII 计 0.5', () => {
    expect(clipTitleUnits('预训练')).toBe('预训练');
    expect(clipTitleUnits('从150条到万亿级别')).toBe('从150条到万亿级别');
    expect(clipTitleUnits('零冗余优化器ZeRO')).toBe('零冗余优化器ZeRO');
  });
});

describe('sortByLessonNumber', () => {
  const item = (title: string): DouyinUserVideoItem => ({
    videoId: title, title, publishTime: null, publishTimestamp: null, durationSeconds: null, like: 0, comment: 0,
  });
  it('编号课程升序在前，无编号排后', () => {
    const sorted = sortByLessonNumber([item('杂谈'), item('085、中期训练'), item('001、入门'), item('普通分享')]);
    expect(sorted.map((s) => s.title)).toEqual(['001、入门', '085、中期训练', '杂谈', '普通分享']);
  });
});

describe('lessonNumber', () => {
  it('提取编号与栏目前缀', () => {
    expect(lessonNumber('085、中期训练')).toBe(85);
    expect(lessonNumber('【这就是大模型】001、标题')).toBe(1);
    expect(lessonNumber('【从零系统学AI】1.1、AI发展史')).toBe(1.1);
    expect(lessonNumber('无编号标题')).toBeNull();
  });

  it('正文中的编号不算（锚定开头）', () => {
    expect(lessonNumber('掌握这个方法，学习 AI 原理很简单！重点是 1、如何算出奖励信号')).toBeNull();
    expect(lessonNumber('重点如下 085、中期训练')).toBeNull();
  });
});

describe('netscapeToCookieHeader', () => {
  it('正常条目转分号连接的 header 格式', () => {
    const txt = [
      '# Netscape HTTP Cookie File',
      '.douyin.com\tTRUE\t/\tTRUE\t1999999999\tsessionid\tabc123',
      '.douyin.com\tTRUE\t/\tFALSE\t1999999999\tttwid\txyz',
    ].join('\n');
    expect(netscapeToCookieHeader(txt)).toBe('sessionid=abc123; ttwid=xyz');
  });

  it('忽略注释与过期条目', () => {
    const txt = [
      '# comment',
      '#HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t1999999999\ta\t1',
      '.douyin.com\tTRUE\t/\tTRUE\t1000\texpired\told',
      'bad line no tabs',
    ].join('\n');
    expect(netscapeToCookieHeader(txt)).toBe('a=1');
  });
});

describe('inspectDouyinCookie', () => {
  it('健康登录 cookie', () => {
    const txt = [
      '.douyin.com\tTRUE\t/\tTRUE\t1999999999\tsessionid\tabc',
      '.douyin.com\tTRUE\t/\tFALSE\t1999999999\tttwid\tx',
    ].join('\n');
    const h = inspectDouyinCookie(txt);
    expect(h).toMatchObject({ total: 2, hasSessionId: true, sessionIdExpired: false });
    expect(h.sessionIdExpiry).toBe(1999999999);
  });

  it('sessionid 已过期（expiry 小于当前时间）', () => {
    const txt = '.douyin.com\tTRUE\t/\tTRUE\t1000\tsessionid\tabc\n.douyin.com\tTRUE\t/\tFALSE\t1999999999\tttwid\tx';
    const h = inspectDouyinCookie(txt);
    expect(h.hasSessionId).toBe(false); // 过期条目已跳过，视为无登录态
    expect(h.total).toBe(1);
  });

  it('游客 cookie（无 sessionid）与会话 cookie（expiry 为 0 无法静态判断）', () => {
    const guest = '.douyin.com\tTRUE\t/\tFALSE\t1999999999\tttwid\tx';
    expect(inspectDouyinCookie(guest).hasSessionId).toBe(false);
    const session = '.douyin.com\tTRUE\t/\tTRUE\t0\tsessionid\tabc';
    const h = inspectDouyinCookie(session);
    expect(h).toMatchObject({ hasSessionId: true, sessionIdExpired: false });
    expect(h.sessionIdExpiry).toBe(0);
  });
});

describe('formatDouyinTime', () => {
  it('秒级时间戳格式化', () => {
    expect(formatDouyinTime(1716540374)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('escapeMdCell 与 markdown 表格', () => {
  it('转义竖线与换行', () => {
    expect(escapeMdCell('a|b\nc')).toBe('a\\|b c');
  });

  it('表格包含表头与逐条行', () => {
    const items: DouyinUserVideoItem[] = [
      { videoId: '111', title: '第一个|视频', publishTime: '2025-09-10 12:00', publishTimestamp: 1, durationSeconds: 30, like: 100, comment: 5 },
      { videoId: '222', title: '', publishTime: null, publishTimestamp: null, durationSeconds: null, like: 0, comment: 0 },
    ];
    const md = userVideosToMarkdown(items, { author: '测试主播', secUserId: 'MS4test' });
    expect(md).toContain('# 测试主播 的抖音作品列表');
    expect(md).toContain('| # | 标题 | 发布时间 | 点赞 | 时长 | 链接 |');
    expect(md).toContain('https://www.douyin.com/video/111');
    expect(md).toContain('第一个\\|视频');
    expect(md).toContain('(无文案)');
  });
});

describe('normalizeDouyinVideo', () => {
  const videoFixture: DouyinAwemeDetailPayload = {
    status_code: 0,
    aweme_detail: {
      aweme_id: '7372484719365098803',
      aweme_type: 0,
      desc: '你对我的好我一直记得',
      create_time: 1716540374,
      author: { nickname: '萧萧不吃辣' },
      video: { duration: 15230, play_addr: { url_list: ['https://v95-zjwz2tc-web.douyinvod.com/8b05.mp4'] } },
      statistics: { digg_count: 313684, comment_count: 4080, share_count: 79943 },
    },
  };

  it('视频字段完整映射', () => {
    const r = normalizeDouyinVideo(videoFixture);
    expect(r.platform).toBe('douyin');
    expect(r.type).toBe('video');
    expect(r.title).toBe('你对我的好我一直记得');
    expect(r.author).toBe('萧萧不吃辣');
    expect(r.publishTime).toBe(new Date(1716540374 * 1000).toISOString());
    expect(r.durationSeconds).toBeCloseTo(15.23);
    expect(r.videoUrls).toHaveLength(1);
    expect(r.imageUrls).toEqual([]);
    expect(r.stats).toEqual({ like: 313684, comment: 4080, share: 79943 });
  });

  it('图集分支映射 images', () => {
    const imageFixture: DouyinAwemeDetailPayload = {
      aweme_detail: {
        aweme_id: '123',
        aweme_type: 68,
        desc: '图集',
        author: {},
        images: [{ url_list: ['https://a.jpg', 'https://b.jpg'] }, null, {}],
      },
    };
    const r = normalizeDouyinVideo(imageFixture);
    expect(r.type).toBe('image');
    expect(r.imageUrls).toEqual(['https://a.jpg']);
    expect(r.videoUrls).toEqual([]);
    expect(r.author).toBe('');
  });

  it('统计缺失兜底为 0', () => {
    const r = normalizeDouyinVideo({ aweme_detail: { aweme_id: '1', desc: '' } });
    expect(r.stats).toEqual({ like: 0, comment: 0, share: 0 });
    expect(r.publishTime).toBeNull();
  });
});
