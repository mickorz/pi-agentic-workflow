#!/usr/bin/env node
// P0 T0.2/T0.3/T0.5 探针：验证 pi-ai 与 pi-image-gen 的运行时可用性（离线，无网络调用）
// 使命：1) 导入是否可用 2) 配置解析 3) 无凭证时的错误路径分类（A08 依据）
import { execSync } from 'node:child_process';

const out = [];
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); out.push(s); console.log(s); };

log('=== [1] pi-image-gen 运行时导入 ===');
try {
  const mod = await import('@amaster.ai/pi-image-gen');
  log('exports:', Object.keys(mod).sort().join(','));
  const settings = mod.loadImageGenSettings(process.cwd());
  log('settings keys:', Object.keys(settings).join(','));
  log('defaultModel:', JSON.stringify(settings.defaultModel ?? null), '| outputDir:', JSON.stringify(settings.outputDir ?? null));
  const r1 = mod.resolveModel('google/gemini-2.5-flash-image', settings);
  log('resolveModel("google/gemini-2.5-flash-image"):', 'error' in r1 ? `ERROR: ${r1.error}` : `OK provider=${r1.provider.id} remote=${r1.remoteModelId}`);
  const r2 = mod.resolveModel('nonexistent-model-xyz', settings);
  log('resolveModel("nonexistent-model-xyz"):', 'error' in r2 ? `ERROR: ${r2.error}` : `OK ${r2.provider.id}/${r2.remoteModelId}`);
  // 无凭证调用 → 错误路径（A08 验证：不得 crash，必须可分类）
  try {
    const res = await mod.generateImage(
      { prompt: 'p0 probe', filename: 'probe-nokey', outputDir: 'out' },
      { cwd: process.cwd(), settings }
    );
    log('generateImage(no-key) returned:', JSON.stringify({ keys: Object.keys(res), model: res.model, provider: res.provider, images: res.images?.length }));
  } catch (e) {
    log('generateImage(no-key) THREW:', e.constructor.name, String(e.message).slice(0, 200));
  }
} catch (e) {
  log('pi-image-gen import/call FAILED:', e.stack?.split('\n').slice(0, 3).join(' | '));
}

log('');
log('=== [2] pi-ai 运行时导入 ===');
try {
  const piAi = await import('@earendil-works/pi-ai');
  const all = await import('@earendil-works/pi-ai/providers/all');
  log('providers/all image exports:', Object.keys(all).filter(k => /Image/i.test(k)).join(','));
  // 目录核验：IMAGE_MODELS 60 模型、全 openrouter？
  const models = all.getBuiltinImageModels();
  log('builtin image models:', models.length);
  const byProv = {};
  for (const m of models) { const p = m.provider ?? m.id?.split('/')[0]; byProv[p] = (byProv[p] ?? 0) + 1; }
  log('by provider:', JSON.stringify(byProv));
  log('sample ids:', models.slice(0, 5).map(m => m.id).join(', '));
  const target = models.find(m => /gemini-2\.5-flash-image/.test(m.id));
  log('target model:', target ? `id=${target.id} provider=${target.provider ?? target.id.split('/')[0]}` : 'NOT FOUND');
  // 无凭证 Models.generateImages → 错误 AssistantImages（never rejects 承诺核验）
  try {
    const modelsApi = piAi.createModels();
    const res = await modelsApi.generateImages(target, { input: [{ type: 'text', text: 'p0 probe' }] }, { signal: AbortSignal.timeout(15000) });
    log('generateImages(no-auth) returned:', JSON.stringify({ stopReason: res.stopReason, errorMessage: res.errorMessage?.slice(0, 160), provider: res.provider, outputLen: res.output?.length }));
  } catch (e) {
    log('generateImages(no-auth) THREW (违反 never-rejects?):', e.constructor.name, String(e.message).slice(0, 200));
  }
} catch (e) {
  log('pi-ai import FAILED:', e.stack?.split('\n').slice(0, 3).join(' | '));
}

log('');
log('=== [3] 结论可写性 ===');
execSync(`mkdir -p out`, { stdio: 'ignore' });
log('PROBE DONE');
