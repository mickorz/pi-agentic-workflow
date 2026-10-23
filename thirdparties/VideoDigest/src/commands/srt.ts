import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { defineCommand, CliError, ensureDir } from '@clibase/core';
import { resolveTool, dirOf } from '../lib/tools.js';
import { transcribeAudio, type TranscribeEngine } from '../lib/transcribe.js';
import { resolveDashscopeApiKey } from '../lib/bailian.js';
import { segmentsToSrt } from '../lib/srt.js';
import { resolveOutput } from './download.js';
import type { SrtOptions } from '../lib/types.js';
import { removeWorkDir } from '../lib/cleanup.js';

/**
 * srt 命令：本地音频（wav 等）-> SRT 字幕
 * 复用 digest 的转录链路：whisper -> transcript.json 中间格式（词级时间戳）-> SRT。
 * 单文件 -o 可指文件名；多文件 -o 须为目录；默认输出到各音频同目录。
 */
export const srtCommand = defineCommand({
  name: 'srt',
  description: '本地音频文件（wav 等）-> SRT 字幕文件（默认百炼 FunAudio 转录，可降级本地 whisper）',
  args: { name: 'file', description: '一个或多个本地音频文件（空格分隔，选项请放在文件名前面）', required: true, variadic: true },
  options: [
    { flags: '--engine <engine>', description: '转录引擎：bailian=阿里百炼（默认，需 DASHSCOPE_API_KEY），whisper=本地', default: 'bailian', choices: ['bailian', 'whisper'] },
    { flags: '--lang <lang>', description: '语言提示：zh / en / auto(自动识别)', default: 'auto', choices: ['zh', 'en', 'auto'] },
    { flags: '--whisper-model <model>', description: 'Whisper 模型大小（仅 engine=whisper）', default: 'base', choices: ['tiny', 'base', 'small', 'medium', 'large'] },
    { flags: '-o, --output <path>', description: 'SRT 输出位置：单文件可指文件名，多文件为目录（默认各音频同目录）' },
    { flags: '--keep-temp', description: '保留临时转录目录（含 transcript.json）便于排查' },
    { flags: '--whisper <path>', description: 'whisper 可执行文件路径（默认 VD_WHISPER 或 PATH）' },
    { flags: '--ffmpeg <path>', description: 'ffmpeg 可执行文件路径（默认 VD_FFMPEG 或 PATH）' },
  ],
  action: async (ctx) => {
    const o = ctx.options as SrtOptions;
    const files = [...new Set(ctx.args.map((a) => String(a).trim()).filter(Boolean))];
    if (files.length === 0) throw new CliError('请提供至少一个音频文件', '参数校验');
    for (const f of files) {
      if (!fs.existsSync(f)) throw new CliError(`音频文件不存在：${f}`, '参数校验');
    }

    const engine = (o.engine === 'whisper' ? 'whisper' : 'bailian') as TranscribeEngine;
    // 工具按引擎懒解析：百炼不需要本地 whisper/ffmpeg
    let whisper: string | undefined;
    let ffmpegDir: string | undefined;
    let apiKey: string | undefined;
    if (engine === 'whisper') {
      whisper = resolveTool('whisper', { optionPath: o.whisper });
      ffmpegDir = dirOf(resolveTool('ffmpeg', { optionPath: o.ffmpeg }));
    } else {
      apiKey = resolveDashscopeApiKey();
      if (!apiKey) {
        throw new CliError(
          '未找到百炼 API Key：设置环境变量 DASHSCOPE_API_KEY，或创建 ~/.config/oil-subtitle/dashscope_api_key 文件',
          '百炼转录',
        );
      }
    }

    const { outDir, outName } = resolveOutput(o.output, files.length > 1);
    // 分类子目录：srt 入 字幕/，md 入 文档/（对齐用户目录规范；单文件指定文件名时不分类）
    const srtDir = outName ? outDir : path.join(outDir, '字幕');
    const mdDir = outName ? outDir : path.join(outDir, '文档');
    ensureDir(srtDir);
    ensureDir(mdDir);

    const batchDir = path.join(os.tmpdir(), `vcli-srt-${crypto.randomUUID()}`);
    ensureDir(batchDir);

    const done: string[] = [];
    const failures: string[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const input = path.resolve(files[i]!);
        const tag = files.length > 1 ? `[${i + 1}/${files.length}] ` : '';
        const workdir = path.join(batchDir, `file-${i + 1}`);
        try {
          ctx.spinner.start(`${tag}百炼转写中（fun-asr${o.lang !== 'auto' ? `，语言 ${o.lang}` : '，自动识别'}）...`);
          const { segments } = await transcribeAudio({
            engine,
            audioPath: input,
            workdir,
            lang: o.lang,
            model: o.whisperModel,
            apiKey,
            whisper,
            ffmpegDir,
            onProgress: (msg) => ctx.spinner.start(`${tag}${msg}`),
          });
          // 单文件且 -o 指定了文件名时用它（强制 .srt 扩展），否则按输入名派生
          const base =
            i === 0 && outName
              ? outName.replace(/\.[^.]+$/, '')
              : path.basename(input, path.extname(input));
          const srtPath = path.join(srtDir, `${base}.srt`);
          fs.writeFileSync(srtPath, segmentsToSrt(segments), 'utf-8');
          // 同名 markdown：仅原文无时间轴，每段一句便于阅读
          const mdPath = path.join(mdDir, `${base}.md`);
          fs.writeFileSync(mdPath, segments.map((s) => s.text.trim()).filter(Boolean).join('\n\n') + '\n', 'utf-8');
          ctx.spinner.succeed(`${tag}${srtPath}（${segments.length} 段，含同名 md 原文）`);
          done.push(srtPath);
        } catch (e) {
          ctx.spinner.fail(`${tag}转换失败`);
          const ce = e instanceof CliError ? e : new CliError(e instanceof Error ? e.message : String(e), '转换');
          ctx.logger.error(`${tag}${ce.step ? `[${ce.step}] ` : ''}${ce.message}`);
          failures.push(`- ${input}: ${ce.message}`);
        }
      }

      if (done.length === 0) {
        throw new CliError(`${files.length} 个文件全部失败`, '转换', failures.join('\n'));
      }
      return {
        success: true,
        message:
          failures.length > 0
            ? `完成：${done.length}/${files.length} 个成功，${failures.length} 个失败（见上方错误）`
            : files.length > 1
              ? `完成：${done.length} 个 SRT 已生成`
              : `SRT 已生成：${done[0]}`,
      };
    } finally {
      if (o.keepTemp) {
        ctx.logger.info(`已保留临时目录 ${batchDir}（含 transcript.json）`);
      } else {
        removeWorkDir(batchDir);
      }
    }
  },
});
