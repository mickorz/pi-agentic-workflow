import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { defineCommand, CliError, ensureDir, loadModelConfig } from '@clibase/core';
import type { CommandContext, LlmConfig } from '@clibase/core';
import type { DigestOptions, DigestResult, LinkFailure, PlatformInfo } from '../lib/types.js';
import { detectPlatform } from '../lib/platform.js';
import { resolveTool, dirOf } from '../lib/tools.js';
import { dumpMetadata, fetchAudio } from '../lib/download.js';
import { sanitizeFilename } from './download.js';
import { transcribeAudio } from '../lib/transcribe.js';
import { segmentsToSrt } from '../lib/srt.js';
import { cdpLaunch, exportDomainCookies } from '../lib/cookies.js';
import { extractNoteOnChrome } from '../lib/pageread.js';
import { summarizeTranscript } from '../lib/summarize.js';
import { removeWorkDir, killDebugChrome } from '../lib/cleanup.js';
import type { LogLink, RunLog } from '../lib/runlog.js';
import { writeRunLog } from '../lib/runlog.js';

/** 秒数格式化为 h:mm:ss 或 m:ss */
function formatDuration(sec: number | null): string {
  if (!sec || sec <= 0) return '未知';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`
    : `${m}:${String(rs).padStart(2, '0')}`;
}

/** 渲染纯文本结果（无 emoji） */
function renderText(r: DigestResult): string {
  const lines: string[] = [];
  lines.push(`类型：${r.resultKind === 'note' ? '图文笔记' : '视频'}`);
  lines.push(`标题：${r.metadata.title}`);
  lines.push(`作者：${r.metadata.uploader}`);
  if (r.resultKind !== 'note') {
    lines.push(`时长：${formatDuration(r.metadata.durationSeconds)}`);
  }
  lines.push(`链接：${r.metadata.webpageUrl}`);
  if (r.resultKind === 'note' && r.note && r.note.imageUrls.length > 0) {
    lines.push(`图片数：${r.note.imageUrls.length}`);
  }
  if (r.srtFile) lines.push(`SRT：${r.srtFile}`);
  lines.push('');
  if (r.summary) {
    lines.push('重点提炼：');
    lines.push(r.summary);
  } else {
    lines.push(`重点提炼：（${r.summarySkipped ? '内容过短，未生成' : r.summaryError ? `提炼失败：${r.summaryError}` : '已跳过'}）`);
  }
  lines.push('');
  lines.push('———————————');
  if (r.resultKind === 'note') {
    lines.push('正文：');
    lines.push(r.transcript);
    if (r.note && r.note.imageUrls.length > 0) {
      lines.push('');
      lines.push('图片：');
      for (const u of r.note.imageUrls) lines.push(`- ${u}`);
    }
  } else {
    lines.push('完整逐字稿：');
    lines.push(r.transcript);
  }
  return lines.join('\n');
}

/** 渲染单条失败链接的占位段落（用于合并文本文件，保证文件是完整批次报告） */
function renderFailure(f: LinkFailure): string {
  return `链接：${f.url}\n\n处理失败：${f.error.message}${f.error.step ? `（步骤：${f.error.step}）` : ''}`;
}

/** 结果文件内多条之间的分隔线 */
const RESULT_SEP = '\n\n===============================\n\n';

/**
 * 结果文件增量写出器：每处理完一条立即落盘，进程中途挂掉已完成成果不丢。
 * 文本模式：批次头 + 逐条追加（分隔线连接，失败链接以占位段落体现）。
 * JSON 模式：多链接写 NDJSON（每行一个结果对象，失败行为 {url,error} 对象），
 *           单链接仍写缩进美化后的纯对象（与旧版兼容）。
 */
function createResultWriter(ctx: CommandContext, o: DigestOptions, total: number) {
  const file = o.output ? path.resolve(String(o.output)) : undefined;
  const startTimeStr = new Date().toLocaleString('zh-CN');
  let count = 0;
  if (file) {
    ensureDir(path.dirname(file));
    if (o.json) {
      if (total > 1) fs.writeFileSync(file, '', 'utf-8'); // 多链接 NDJSON 从空文件开始逐行追加
    } else {
      // 批次头：命令与时间，便于事后对照
      const head = `# 批量提取结果（${total} 条，${startTimeStr} 开始）\n`;
      fs.writeFileSync(file, head, 'utf-8');
    }
  }

  return {
    /** 单条结果（成功或失败）立即追加落盘 */
    append(result: DigestResult | LinkFailure): void {
      if (!file) return;
      count++;
      const sep = count > 1 ? (o.json ? '' : RESULT_SEP) : o.json ? '' : '\n';
      const body = o.json
        ? JSON.stringify('url' in result && 'error' in result ? { url: result.url, error: result.error } : result) + '\n'
        : 'url' in result && 'error' in result
          ? renderFailure(result)
          : renderText(result);
      fs.appendFileSync(file, sep + body, 'utf-8');
      ctx.logger.success(`已保存第 ${count}/${total} 条 -> ${file}`);
    },
    /**
     * 阶段二用：全量重写结果文件（每条提炼完成后调用，把带提炼的最新内容整体落盘）。
     * 重写而不是追加：提炼结果要嵌入到已有条目中，只能整体重构。
     */
    rewrite(items: Array<DigestResult | LinkFailure>): void {
      if (!file) return;
      if (o.json) {
        // JSON 模式：多链接逐行 NDJSON 重写；单链接保持纯对象
        const text =
          total === 1
            ? JSON.stringify(items[0] ?? null, null, 2) + '\n'
            : items.map((it) => JSON.stringify(it)).join('\n') + (items.length > 0 ? '\n' : '');
        fs.writeFileSync(file, text, 'utf-8');
        return;
      }
      const parts = items.map((it) => ('url' in it && 'error' in it ? renderFailure(it) : renderText(it)));
      const head = `# 批量提取结果（${total} 条，${startTimeStr} 开始）\n`;
      fs.writeFileSync(file, head + '\n' + parts.join(RESULT_SEP) + '\n', 'utf-8');
    },
    /** 是否已配置输出文件 */
    enabled: !!file,
  };
}

/**
 * digest 命令：一个或多个视频链接 -> 重点提炼 + 完整逐字稿
 *
 * 多链接批次：整批只启动一次调试 Chrome（首个需 cookie 平台时懒启动），
 * 每个平台域只导出一次 cookie（缓存于批次目录 cookies-<域>.txt），
 * 单条失败不中断批次，批末统一关闭 Chrome 与清理临时目录。
 *
 * 平台识别 -> （抖音/小红书）cdp-cli 取 cookie -> yt-dlp 下载转 wav ->
 * whisper 转录 -> LLM 提炼重点 -> 输出 -> 清理
 */
export const digestCommand = defineCommand({
  name: 'digest',
  description: '一个或多个视频链接 -> 重点提炼 + 完整逐字稿（yt-dlp + ffmpeg + whisper + 可选 cdp-cli 取 cookie + LLM 提炼）',
  args: { name: 'url', description: '一个或多个视频链接（空格分隔，选项请放在 URL 前面）', required: true, variadic: true },
  options: [
    { flags: '--lang <lang>', description: 'Whisper 语言提示：zh / en / auto(自动识别)', default: 'auto', choices: ['zh', 'en', 'auto'] },
    { flags: '--whisper-model <model>', description: 'Whisper 模型大小', default: 'base', choices: ['tiny', 'base', 'small', 'medium', 'large'] },
    { flags: '--skip-summary', description: '跳过 LLM 重点提炼，仅输出逐字稿' },
    { flags: '--srt', description: '同时生成 SRT 字幕文件（与 -o 同目录，无 -o 则当前目录，按视频标题命名）' },
    { flags: '-o, --output <file>', description: '把结果写入文件（文本或 json）' },
    { flags: '--json', description: '输出 JSON 而非文本（默认文本）' },
    { flags: '--keep-temp', description: '保留临时工作目录便于排查' },
    { flags: '--ytdlp <path>', description: 'yt-dlp 可执行文件路径（默认 VD_YTDLP 或 PATH）' },
    { flags: '--ffmpeg <path>', description: 'ffmpeg 可执行文件路径（默认 VD_FFMPEG 或 PATH）' },
    { flags: '--whisper <path>', description: 'whisper 可执行文件路径（默认 VD_WHISPER 或 PATH）' },
    { flags: '--cdp-cli <path>', description: 'cdp-cli 可执行文件路径（默认 VD_CDP_CLI 或 PATH，仅需 cookie 时解析）' },
    { flags: '--cookie-domain <kw>', description: '覆盖 cookie 域过滤词（高级，通常自动）' },
    { flags: '--cookies <file>', description: '直接使用现成 Netscape cookies.txt，跳过 cdp-cli 取 cookie' },
    { flags: '--login-timeout <sec>', description: '等待扫码登录的超时秒数（默认 120）', default: 120 },
  ],
  action: async (ctx) => {
    const o = ctx.options as DigestOptions;
    // variadic：ctx.args 是全部 URL；去重保序、过滤空白
    const urls = [...new Set(ctx.args.map((a) => String(a).trim()).filter(Boolean))];
    if (urls.length === 0) throw new CliError('请提供至少一个视频链接', '参数校验');
    const isBatch = urls.length > 1;

    // 用户显式给了 cookies 文件：校验存在性，fail fast（并跳过 cdp-cli 全流程）
    let userCookies: string | undefined;
    if (o.cookies) {
      userCookies = path.resolve(String(o.cookies).trim());
      if (!fs.existsSync(userCookies)) {
        throw new CliError(`--cookies 指定的文件不存在：${userCookies}`, '参数校验');
      }
    }

    // 工具解析（cdp-cli 延迟到首个需 cookie 平台时懒解析）
    const ytdlp = resolveTool('yt-dlp', { optionPath: o.ytdlp });
    const ffmpeg = resolveTool('ffmpeg', { optionPath: o.ffmpeg });
    const whisper = resolveTool('whisper', { optionPath: o.whisper });
    const ffmpegDir = dirOf(ffmpeg);

    // LLM 配置预加载（fail fast），避免下载转录跑完才发现没配
    const wantSummary = !o.skipSummary;
    let llmConfig: LlmConfig | undefined;
    if (wantSummary) llmConfig = loadModelConfig(ctx.config, 'text');

    // 批次根目录：所有链接共用，cookie 也落在这里；每链接独立子目录 link-N
    const batchDir = path.join(os.tmpdir(), `video-digest-${crypto.randomUUID()}`);
    ensureDir(batchDir);

    // 批级状态：全批唯一调试 Chrome + 平台 cookie 缓存
    let chromePort = 0;
    let cdpCli: string | undefined;
    const cookieCache = new Map<string, string>();
    const results: DigestResult[] = [];
    const failures: LinkFailure[] = [];

    // 运行日志（每条链接一份步骤时间线，逐条写盘）
    const runLog: RunLog = { command: `vcli digest ${urls.join(' ')}`, startedAt: new Date(), links: [] };
    const stamp = (d = new Date()) => {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    /**
     * 记录一个步骤到指定链接的日志，自动计算与上一步骤的耗时差。
     * 每条链接开始前调 markLinkStart 重置基准。
     */
    let linkStartMs = Date.now();
    let lastStepMs = Date.now();
    const markLinkStart = () => {
      linkStartMs = Date.now();
      lastStepMs = linkStartMs;
    };
    const logStep = (
      log: LogLink,
      name: string,
      status: 'ok' | 'fail' | 'info',
      note?: string,
    ) => {
      const now = Date.now();
      log.steps.push({ name, time: stamp(), elapsedMs: now - lastStepMs, status, note });
      lastStepMs = now;
    };

    /**
     * 确保调试 Chrome 已启动（批内首次调用时 launch，之后复用）。
     * 供 cookie 导出与图文提取两条路径共用。
     */
    const ensureChrome = async (): Promise<number> => {
      if (!chromePort) {
        ctx.logger.step('启动调试 Chrome（本批一次）');
        chromePort = await cdpLaunch(cdpCli ?? resolveTool('cdp-cli', { optionPath: o.cdpCli }));
      }
      return chromePort;
    };

    /**
     * 取某平台的 cookie 文件（批内缓存）。
     * 优先级：--cookies 显式文件 > 平台缓存 > （需要时）懒启动 Chrome 并导出。
     * 失败抛 CliError 归属当前链接；Chrome 即使刚启动也留给批末统一杀。
     * --cookies 对无需 cookie 的平台同样生效：用户显式给文件通常意味着该站需要登录态。
     */
    const cookieFileFor = async (platform: PlatformInfo): Promise<string | undefined> => {
      if (userCookies) return userCookies;
      if (!platform.needsCookie) return undefined;
      const kw = (o.cookieDomain ? String(o.cookieDomain).trim() : '') || platform.domainKeyword;
      const cached = cookieCache.get(kw);
      if (cached) return cached;
      cdpCli = resolveTool('cdp-cli', { optionPath: o.cdpCli });
      const port = await ensureChrome();
      const r = await exportDomainCookies({
        cdpPath: cdpCli,
        port,
        outDir: batchDir,
        domainKeyword: kw,
        siteUrl: platform.siteUrl,
        loginCookieNames: platform.loginCookieNames,
        loginTimeoutMs: Number(o.loginTimeout ?? 120) * 1000,
        logger: ctx.logger,
      });
      cookieCache.set(kw, r.cookiesFile);
      return r.cookiesFile;
    };

    /**
     * 判断链接是视频还是图文笔记（小红书与抖音：图文笔记 yt-dlp 报 No video formats found
     * 或 Unsupported URL /note/）。
     * 先用元数据探测：有 duration 字段视为视频；探测失败或无时长再开页面提取确认。
     * 提取到正文即按图文处理，否则按视频继续。
     */
    const detectNoteKind = async (
      url: string,
      cookiesFile: string | undefined,
      log: LogLink,
    ): Promise<{ isNote: boolean; noteRaw?: Awaited<ReturnType<typeof extractNoteOnChrome>> }> => {
      // 元数据探测：能拿到 duration 就是视频
      try {
        const probe = dumpMetadata({ ytdlp, url, cookiesFile });
        if (probe.durationSeconds && probe.durationSeconds > 0) {
          logStep(log, '类型检测', 'ok', '元数据含时长，判定为视频');
          return { isNote: false };
        }
        logStep(log, '类型检测', 'info', '元数据无时长，疑似图文，转页面提取确认');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logStep(log, '类型检测', 'info', `元数据探测失败（${msg.slice(0, 120)}），转页面提取确认`);
      }
      // 页面提取确认（复用批级 Chrome）：提取到正文即按图文处理。
      // 短链重定向后页面渲染较慢，首次 10 秒拿不到正文再用 20 秒重试一次
      cdpCli = resolveTool('cdp-cli', { optionPath: o.cdpCli });
      const port = await ensureChrome();
      for (const waitMs of [10000, 20000]) {
        try {
          const page = await extractNoteOnChrome({ cdpPath: cdpCli, port, url, waitMs });
          logStep(log, '类型检测', 'ok', `页面提取到正文（等待 ${waitMs / 1000} 秒），判定为图文笔记`);
          return { isNote: true, noteRaw: page };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (waitMs === 20000) {
            logStep(log, '类型检测', 'info', `页面提取失败（${msg.slice(0, 120)}），按视频继续`);
          }
        }
      }
      return { isNote: false };
    };

    /** 处理单条小红书图文笔记：标题/正文/图片（提炼在第二阶段统一做） */
    const digestNote = (
      url: string,
      platform: PlatformInfo,
      page: NonNullable<Awaited<ReturnType<typeof extractNoteOnChrome>>>,
      cookiesFile: string | undefined,
      log: LogLink,
    ): DigestResult => {
      const transcript = page.content.trim();
      logStep(log, '图文提取', 'ok', `正文 ${transcript.length} 字，图片 ${page.imageUrls.length} 张`);
      return {
        url,
        platform,
        metadata: { title: page.title || '(未取到标题)', uploader: '(未知)', durationSeconds: null, webpageUrl: url },
        transcript,
        summary: null,
        summarySkipped: false,
        cookiesUsed: !!cookiesFile,
        resultKind: 'note',
        note: { content: page.content, imageUrls: page.imageUrls },
      };
    };

    /** 处理单条视频链接：元数据 -> 下载转码 -> 转录（提炼在第二阶段统一做） */
    const digestVideo = async (
      url: string,
      platform: PlatformInfo,
      cookiesFile: string | undefined,
      linkDir: string,
      tag: string,
      log: LogLink,
    ): Promise<DigestResult> => {
      // 元数据
      ctx.logger.step(`${tag}获取元数据`);
      const metadata = dumpMetadata({ ytdlp, url, cookiesFile });
      logStep(log, '获取元数据', 'ok', metadata.title.slice(0, 80));

      // 下载转码
      ctx.spinner.start(`${tag}下载并转码音频（可能耗时）...`);
      const audioPath = await fetchAudio({ ytdlp, ffmpeg, url, workdir: linkDir, cookiesFile });
      ctx.spinner.succeed(`${tag}音频就绪`);
      logStep(log, '下载转码', 'ok');

      // 转录
      ctx.spinner.start(
        `${tag}转录中（模型 ${o.whisperModel}${o.lang !== 'auto' ? `，语言 ${o.lang}` : '，自动识别'}，长视频较慢）...`,
      );
      const transcriptResult = await transcribeAudio({
        engine: 'whisper',
        whisper,
        audioPath,
        workdir: linkDir,
        lang: o.lang,
        model: o.whisperModel,
        ffmpegDir,
      });
      ctx.spinner.succeed(`${tag}转录完成`);
      logStep(log, '转录', 'ok', `${transcriptResult.text.length} 字`);

      // SRT 落盘：与 -o 同目录，无 -o 则当前目录，按视频标题命名（批次天然不冲突）
      let srtFile: string | undefined;
      if (o.srt) {
        const dir = o.output ? path.dirname(path.resolve(String(o.output))) : process.cwd();
        srtFile = path.join(dir, `${sanitizeFilename(metadata.title)}.srt`);
        fs.writeFileSync(srtFile, segmentsToSrt(transcriptResult.segments), 'utf-8');
        logStep(log, '生成SRT', 'ok', srtFile);
      }

      return {
        url,
        platform,
        metadata,
        transcript: transcriptResult.text,
        summary: null,
        summarySkipped: false,
        cookiesUsed: !!cookiesFile,
        resultKind: 'video',
        srtFile,
      };
    };

    try {
      // 结果增量写出器：每处理完一条立即落盘，中途挂掉已完成成果不丢
      const writer = createResultWriter(ctx, o, urls.length);

      // 逐链接处理：单条失败不影响后续
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i]!;
        const linkDir = path.join(batchDir, `link-${i + 1}`);
        ensureDir(linkDir);
        const tag = isBatch ? `[${i + 1}/${urls.length}] ` : '';
        const platform = detectPlatform(url);
        const log: LogLink = { url, outcome: '失败', steps: [] };
        runLog.links.push(log);
        markLinkStart();
        logStep(log, '平台识别', 'ok', platform.displayName);
        ctx.logger.step(`${tag}平台识别：${platform.displayName}${platform.needsCookie ? '（需要 cookie，将走 cdp-cli）' : ''}`);

        try {
          // 1) cookie（--cookies / 批内缓存 / 懒启动导出）
          const cookiesFile = await cookieFileFor(platform);

          // 2) 类型检测（小红书/抖音可能是图文笔记，yt-dlp 提不出视频流或报 Unsupported URL）
          let result: DigestResult;
          if (platform.kind === 'xiaohongshu' || platform.kind === 'douyin') {
            const kind = await detectNoteKind(url, cookiesFile, log);
            if (kind.isNote && kind.noteRaw) {
              ctx.logger.step(`${tag}图文笔记，转图文提取`);
              result = digestNote(url, platform, kind.noteRaw, cookiesFile, log);
            } else {
              result = await digestVideo(url, platform, cookiesFile, linkDir, tag, log);
            }
          } else {
            logStep(log, '类型检测', 'info', `${platform.displayName}，按视频处理`);
            result = await digestVideo(url, platform, cookiesFile, linkDir, tag, log);
          }
          log.outcome = '成功';
          log.kind = result.resultKind === 'note' ? '图文' : '视频';
          log.totalMs = Date.now() - linkStartMs;
          results.push(result);

          // 阶段一：原稿（含元数据）完成即保存；无 -o 的文本模式逐条打印
          writer.append(result);
          if (!o.json && !writer.enabled) {
            console.log(renderText(result));
            if (i < urls.length - 1) console.log('');
          }
          // 运行日志也逐条落盘（覆盖式重写，中途挂掉也有已完成部分）
          writeRunLog(runLog);
        } catch (e) {
          // 收尾 spinner 避免悬挂，再记录失败并继续下一条
          ctx.spinner.fail(`${tag}处理失败`);
          const ce = e instanceof CliError ? e : new CliError(e instanceof Error ? e.message : String(e), '处理链接');
          ctx.logger.error(`${tag}${ce.step ? `[${ce.step}] ` : ''}${ce.message}`);
          logStep(log, ce.step ?? '处理链接', 'fail', `${ce.message}${ce.details ? ` | 详情: ${ce.details.slice(0, 200)}` : ''}`);
          log.totalMs = Date.now() - linkStartMs;
          const failure: LinkFailure = { url, error: { message: ce.message, step: ce.step } };
          failures.push(failure);
          writer.append(failure);
          writeRunLog(runLog);
        }
      }

      // —— 阶段二：统一 LLM 重点提炼 ——
      // 全部原稿提取完成后才开始，LLM 超时/失败只影响提炼本身，原稿已在结果文件中不丢。
      // 每条提炼完成即全量重写结果文件（提炼嵌在条目内，只能整体重构）。
      if (wantSummary && results.length > 0) {
        ctx.logger.step(`第二阶段：LLM 重点提炼（${results.length} 条原稿已保存）`);
        for (let i = 0; i < results.length; i++) {
          const r = results[i]!;
          const log = runLog.links.find((l) => l.url === r.url);
          const tag = isBatch ? `[${i + 1}/${results.length}] ` : '';
          markLinkStart();
          if (r.transcript.length <= 50) {
            r.summarySkipped = true;
            ctx.logger.warn(`${tag}内容过短（<=50 字），跳过提炼`);
            logStep(log ?? { url: r.url, outcome: '成功', steps: [] }, '重点提炼', 'info', '内容过短，跳过');
            continue;
          }
          try {
            ctx.spinner.start(`${tag}LLM 重点提炼中（${r.transcript.length} 字）...`);
            r.summary = await summarizeTranscript(r.transcript, llmConfig!);
            ctx.spinner.succeed(`${tag}提炼完成`);
            logStep(log ?? { url: r.url, outcome: '成功', steps: [] }, '重点提炼', 'ok', '已生成');
          } catch (e) {
            ctx.spinner.fail(`${tag}提炼失败（原稿保留）`);
            const msg = e instanceof Error ? e.message : String(e);
            ctx.logger.error(`${tag}${msg}`);
            r.summaryError = msg.slice(0, 200);
            logStep(log ?? { url: r.url, outcome: '成功', steps: [] }, '重点提炼', 'fail', msg.slice(0, 200));
          }
          // 每条提炼完立即重写结果文件 + 日志落盘
          writer.rewrite([...results, ...failures]);
          writeRunLog(runLog);
        }
        // 终端模式补打一遍带提炼的完整结果（阶段一打印过无提炼版本）
        if (!o.json && !writer.enabled) {
          for (const r of results) console.log(renderText(r));
        }
      }

      // 批末输出 JSON 到终端（无 -o 时）；-o 已逐条落盘
      if (o.json && !writer.enabled) {
        const payload =
          results.length === 1 && failures.length === 0 ? results[0] : { results, failures };
        console.log(JSON.stringify(payload, null, 2));
      }

      // 汇总返回 + 运行日志补汇总
      const summaryLine =
        results.length === 0
          ? `${urls.length} 条链接全部失败`
          : failures.length > 0
            ? `批次完成：${results.length}/${urls.length} 条成功，${failures.length} 条失败`
            : isBatch
              ? `批次完成：${results.length}/${urls.length} 条`
              : `完成：${results[0]!.metadata.title}`;
      runLog.summary = summaryLine;
      const logFile = writeRunLog(runLog);
      if (logFile) ctx.logger.info(`运行日志已写入 ${logFile}`);

      if (results.length === 0) {
        // 全部失败：首条错误作为主因，全部错误进 details
        const first = failures[0]!.error;
        const rest = failures.map((f) => `- ${f.url}: ${f.error.message}`);
        throw new CliError(`${urls.length} 条链接全部失败`, first.step, rest.join('\n'));
      }
      if (failures.length > 0) {
        return {
          success: true,
          message: `批次完成：${results.length}/${urls.length} 条成功，${failures.length} 条失败（见上方各条错误信息）`,
        };
      }
      return { success: true, message: summaryLine };
    } finally {
      // 清理顺序：先杀 Chrome 再删目录（Chrome 可能持有临时 profile 文件句柄，先杀后删才删得干净）
      if (chromePort) killDebugChrome(chromePort);
      if (o.keepTemp) {
        ctx.logger.info(`已保留批次目录 ${batchDir}`);
      } else {
        removeWorkDir(batchDir);
      }
    }
  },
});
