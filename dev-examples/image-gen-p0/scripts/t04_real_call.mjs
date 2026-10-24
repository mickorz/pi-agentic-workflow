#!/usr/bin/env node
// P0 T0.4：pi-image-gen 真实调用验证（架构路径）
// 用 cc-switch 库中的智谱 key 配置自定义 provider，真实生成 1 张 cogview-3-flash。
// key 只在内存中流转，不落盘、不打印。
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { execSync } = require_('node:child_process');

// 从 cc-switch.db 读 pi provider 的 apiKey（仅本机实验）
const ZKEY = execSync(
  `python3 -c "import json,sqlite3;db=sqlite3.connect('/Users/michaelchang/.cc-switch/cc-switch.db');print(json.loads(db.execute(\\"SELECT settings_config FROM providers WHERE app_type='pi'\\").fetchone()[0])['apiKey'])"`,
  { encoding: 'utf8' }
).trim();

const { generateImage } = await import('@amaster.ai/pi-image-gen');

const settings = {
  defaultModel: 'cogview-3-flash',
  outputDir: 'out',
  customProviders: {
    zhipu: {
      api: 'openai', // openai 兼容 wire：POST {baseUrl}/images/generations
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: ZKEY,
      models: [{ id: 'cogview-3-flash' }],
    },
  },
};

console.log('[t04] calling pi-image-gen generateImage(cogview-3-flash) ...');
// 坑：智谱 openai 兼容端点对显式 n:1 报 HTTP429+code1314（企业套餐限制），
// pi-image-gen 的 openai adapter 固定发送 n。用 fetchImpl 扩展点改写 body 去掉 n（仅 n===1 时）。
const zhipuFetch = async (url, init) => {
  if (init?.body && typeof init.body === 'string' && init.body.includes('"n":1')) {
    const parsed = JSON.parse(init.body);
    if (parsed.n === 1) delete parsed.n;
    init = { ...init, body: JSON.stringify(parsed) };
    console.log('[t04] fetchImpl rewrite: dropped explicit n:1 (zhipu compat)');
  }
  return fetch(url, init);
};
const t0 = Date.now();
try {
  const res = await generateImage(
    { prompt: '一只戴着宇航员头盔的橘猫，扁平插画风格，暖色背景，无文字', filename: 't04-real', outputDir: 'out' },
    { cwd: process.cwd(), settings, signal: AbortSignal.timeout(120000), fetchImpl: zhipuFetch }
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[t04] OK in ${elapsed}s | model=${res.model} provider=${res.provider} images=${res.images?.length}`);
  for (const img of res.images ?? []) {
    const st = await stat(img.path ?? img.absolutePath ?? img.file).catch(() => null);
    console.log(`[t04]   file=${img.path ?? img.absolutePath ?? img.file} size=${st ? st.size + 'B' : 'unknown'} revisedPrompt=${img.revisedPrompt ? 'yes' : 'no'}`);
  }
} catch (e) {
  console.log(`[t04] FAILED in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, e.constructor.name, String(e.message).slice(0, 300));
  process.exit(1);
}
