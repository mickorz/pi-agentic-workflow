import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { CliError } from '@clibase/core';
import type { TranscriptSegment, TranscribeResult } from './types.js';

/** 百炼开放网关（对齐 oil-subtitle dashscope_client.py 的默认地址） */
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com';
/**
 * 录音文件识别模型（与 oil-subtitle 默认一致）。
 * 可选升级：qwen-audio-3.0-asr-flash-filetrans（Qwen3-Audio 文件转写版，同一异步协议只换模型名）；
 * qwen-audio-3.0-asr-flash 是短音频/实时同步版，不适合本命令的文件转写链路。
 */
export const BAILIAN_ASR_MODEL = 'fun-asr';
const POLL_INTERVAL_MS = 3000;

/**
 * 解析百炼 API Key：环境变量 DASHSCOPE_API_KEY 优先，
 * 其次读取 oil-subtitle 的密钥文件 ~/.config/oil-subtitle/dashscope_api_key。
 */
export function resolveDashscopeApiKey(): string | undefined {
  const env = process.env.DASHSCOPE_API_KEY?.trim();
  if (env) return env;
  const file = path.join(os.homedir(), '.config', 'oil-subtitle', 'dashscope_api_key');
  try {
    const v = fs.readFileSync(file, 'utf-8').trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** 毫秒时间戳转秒（对齐 oil-subtitle _ms） */
function msToSec(value: unknown): number {
  return Math.round((Number(value ?? 0) / 1000) * 1000) / 1000;
}

/** 统一解析 DashScope JSON 响应：HTTP 非 2xx 或 code 非空都视为失败 */
async function parseDashscope(res: Response, action: string): Promise<Record<string, unknown>> {
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    throw new CliError(`百炼${action}响应不是 JSON（HTTP ${res.status}）`, '百炼转录');
  }
  if (!res.ok || body.code) {
    throw new CliError(`百炼${action}失败：${String(body.code ?? res.status)}: ${String(body.message ?? '')}`, '百炼转录',
      body.request_id ? `request_id=${String(body.request_id)}` : undefined);
  }
  return body;
}

/** 获取文件上传临时凭证（官方协议：GET /api/v1/uploads?action=getPolicy&model=xxx） */
async function getUploadPolicy(apiKey: string, model: string, fileName: string) {
  const res = await fetch(
    `${DASHSCOPE_BASE}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const body = await parseDashscope(res, '获取上传凭证');
  const data = body.data as Record<string, string> | undefined;
  if (!data?.upload_host || !data.upload_dir || !data.policy || !data.signature || !data.oss_access_key_id) {
    throw new CliError('百炼上传凭证缺少必要字段', '百炼转录', JSON.stringify(body).slice(0, 300));
  }
  return {
    host: data.upload_host,
    dir: data.upload_dir.replace(/\/$/, ''),
    uploadPolicy: data.policy,
    accessKeyId: data.oss_access_key_id,
    signature: data.signature,
    objectAcl: data.x_oss_object_acl || 'private',
    forbidOverwrite: data.x_oss_forbid_overwrite || 'true',
    fileName,
  };
}

/** OSS PostObject 上传本地文件，返回可提交转写的 oss:// 临时地址（48 小时有效） */
async function uploadToOss(
  audioPath: string,
  cred: Awaited<ReturnType<typeof getUploadPolicy>>,
): Promise<string> {
  const key = `${cred.dir}/${cred.fileName}`;
  const form = new FormData();
  form.append('OSSAccessKeyId', cred.accessKeyId);
  form.append('Signature', cred.signature);
  form.append('policy', cred.uploadPolicy);
  form.append('x-oss-object-acl', cred.objectAcl);
  form.append('x-oss-forbid-overwrite', cred.forbidOverwrite);
  form.append('key', key);
  form.append('success_action_status', '200');
  form.append('file', new Blob([await fs.promises.readFile(audioPath)]), cred.fileName);

  const res = await fetch(cred.host, { method: 'POST', body: form });
  if (res.status !== 200) {
    throw new CliError(`百炼 OSS 上传失败（HTTP ${res.status}）`, '百炼转录', (await res.text()).slice(0, 300));
  }
  return `oss://${key}`;
}

/** 提交异步转写任务，返回 task_id */
async function submitTask(apiKey: string, ossUrl: string, model: string, lang: string): Promise<string> {
  const parameters: Record<string, unknown> = { channel_id: [0] };
  if (lang && lang !== 'auto') parameters.language_hints = [lang];
  const res = await fetch(`${DASHSCOPE_BASE}/api/v1/services/audio/asr/transcription`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
      // OSS 内部资源解析：允许 file_urls 指向上一步上传的 org 内部地址（对应 SDK parameters.headers）
      'X-DashScope-OssResourceResolve': 'enable',
    },
    body: JSON.stringify({ model, input: { file_urls: [ossUrl] }, parameters }),
  });
  const body = await parseDashscope(res, '提交转写任务');
  const output = body.output as Record<string, unknown> | undefined;
  const taskId = output?.task_id;
  if (!taskId) throw new CliError('百炼提交转写任务未返回 task_id', '百炼转录', JSON.stringify(body).slice(0, 300));
  return String(taskId);
}

/** 轮询任务直到 SUCCEEDED / FAILED，返回 results[0] */
async function waitTask(apiKey: string, taskId: string, timeoutMs: number, onProgress?: (msg: string) => void) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new CliError(`百炼转写超时（>${Math.round(timeoutMs / 60000)} 分钟）`, '百炼转录', `task_id=${taskId}`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(`${DASHSCOPE_BASE}/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await parseDashscope(res, '查询转写任务');
    const output = body.output as Record<string, unknown> | undefined;
    const status = String(output?.task_status ?? '');
    if (status === 'SUCCEEDED') {
      const results = output?.results as Array<Record<string, unknown>> | undefined;
      const item = results?.[0];
      if (!item) throw new CliError('百炼转写完成但无 results', '百炼转录');
      if (item.subtask_status !== 'SUCCEEDED') {
        throw new CliError(`百炼转写子任务失败：${String(item.message ?? item.code ?? item.subtask_status)}`, '百炼转录');
      }
      const url = item.transcription_url;
      if (!url) throw new CliError('百炼转写结果缺少 transcription_url', '百炼转录');
      return String(url);
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      throw new CliError(`百炼转写任务${status}：${String(output?.message ?? '')}`, '百炼转录', `task_id=${taskId}`);
    }
    onProgress?.(status);
  }
}

/** 转写结果 JSON（transcription_url 下载内容）转 segments，对齐 oil-subtitle _convert_bailian_result */
export function convertBailianResult(data: unknown): TranscriptSegment[] {
  const transcripts = (data as { transcripts?: Array<Record<string, unknown>> })?.transcripts ?? [];
  const sentences = (transcripts[0]?.sentences ?? []) as Array<Record<string, unknown>>;
  const segments: TranscriptSegment[] = [];
  for (const s of sentences) {
    const text = String(s.text ?? '').trim();
    if (!text) continue;
    const words = ((s.words ?? []) as Array<Record<string, unknown>>)
      .map((w) => {
        // word 文本 + 尾随标点（对齐 _word_text）
        const wordText = String(w.text ?? w.word ?? '').trim() + String(w.punctuation ?? '').trim();
        const begin = w.begin_time ?? w.start;
        const end = w.end_time ?? w.end;
        if (!wordText.trim() || begin == null || end == null) return null;
        return { start: msToSec(begin), end: msToSec(end), text: wordText.trim() };
      })
      .filter((w): w is { start: number; end: number; text: string } => w !== null);
    segments.push({ start: msToSec(s.begin_time ?? s.start), end: msToSec(s.end_time ?? s.end), text, words });
  }
  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  return segments;
}

/**
 * 百炼 FunAudio 录音文件转写（Node 复刻 oil-subtitle transcribe_audio_file）：
 * 取上传凭证 -> OSS 直传 -> 提交异步任务 -> 轮询 -> 下载结果 -> transcript.json 中间格式。
 */
export async function transcribeWithBailian(opts: {
  audioPath: string;
  apiKey: string;
  lang: string;
  model?: string;
  /** 轮询超时毫秒（默认 30 分钟） */
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
}): Promise<TranscribeResult> {
  const model = opts.model ?? BAILIAN_ASR_MODEL;
  if (!fs.existsSync(opts.audioPath)) throw new CliError(`音频文件不存在：${opts.audioPath}`, '百炼转录');

  opts.onProgress?.('获取百炼上传凭证');
  const cred = await getUploadPolicy(
    opts.apiKey,
    model,
    // 上传文件名用安全字符（避免中文在 OSS key 编码上的坑），随机前缀防同名覆盖
    `vcli-${crypto.randomBytes(4).toString('hex')}-${path.basename(opts.audioPath).replace(/[^\w.-]+/g, '_')}`,
  );
  opts.onProgress?.('上传音频到百炼临时存储');
  const ossUrl = await uploadToOss(opts.audioPath, cred);

  opts.onProgress?.('已提交转写任务，等待百炼识别');
  const taskId = await submitTask(opts.apiKey, ossUrl, model, opts.lang);
  const startMs = Date.now();
  const transcriptionUrl = await waitTask(opts.apiKey, taskId, opts.timeoutMs ?? 30 * 60 * 1000, (status) =>
    opts.onProgress?.(`百炼转写中（${status}，已等待 ${Math.round((Date.now() - startMs) / 1000)} 秒）`),
  );

  opts.onProgress?.('下载转写结果');
  const resultRes = await fetch(transcriptionUrl);
  if (!resultRes.ok) throw new CliError(`下载转写结果失败（HTTP ${resultRes.status}）`, '百炼转录');
  const payload = (await resultRes.json()) as Record<string, unknown>;

  const segments = convertBailianResult(payload);
  if (segments.length === 0) {
    throw new CliError('转录结果为空（可能为纯音乐或无语音），无法生成内容', '百炼转录');
  }
  return { text: segments.map((s) => s.text).join(''), segments };
}
