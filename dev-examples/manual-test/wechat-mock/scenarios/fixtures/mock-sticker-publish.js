export const meta = {
  name: "mock_sticker_publish",
  description: "WX-MOCK fixture：小绿书发布通道（publish.py --xiaolvshu --mock）确定性回归，零 LLM 零外部服务",
}
// args: { articleDir: string, outFile: string }
// 产物：outFile 内容 = "exit=<码>\n" + publish.py stdout/stderr 全文
// 断言：含 "[5] DRAFT OK media_id=" 与 "=== ALL DONE draft_media_id="
// 术语（2026-11 定案）：贴图=小绿书；本 fixture 走 MockWechatClient，不触真实微信
phase("准备fixture目录")
// node -e 建文章目录：imgs/01.png,02.png + article.yaml + 独立 config root（aws.env + config.json）
await command({
  executable: "node",
  args: ["-e", `
const fs = require('fs'), path = require('path');
const artDir = process.argv[1];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050201f34a24d50000000049454e44ae426082', 'hex');
fs.mkdirSync(path.join(artDir, 'imgs'), { recursive: true });
fs.writeFileSync(path.join(artDir, 'imgs', '01.png'), PNG);
fs.writeFileSync(path.join(artDir, 'imgs', '02.png'), PNG);
fs.writeFileSync(path.join(artDir, 'article.yaml'), 'title: 小绿书WXMOCK\\ndigest: gate B 配文\\n');
const cfgDir = path.join(artDir, '_wxmockcfg');
fs.mkdirSync(path.join(cfgDir, '.aws-article'), { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'aws.env'), 'WECHAT_1_APPID=wxmock\\nWECHAT_1_APPSECRET=s1\\n');
fs.writeFileSync(path.join(cfgDir, '.aws-article', 'config.json'), '{}');
console.log('fixture ready: ' + artDir);
`, String(args.articleDir)],
})
phase("发布小绿书(mock)")
// node -e 探测 python（跨平台：python3/python/py）后调 publish.py --xiaolvshu --mock，stdout 落盘
const r = await command({
  executable: "node",
  args: ["-e", `
const { spawnSync } = require('child_process'), fs = require('fs');
const [publishPath, artDir, cfgDir, outFile] = process.argv.slice(1);
let py = null, prefix = [];
for (const c of ['python3', 'python', 'py']) {
  const probe = spawnSync(c, ['-c', 'import sys'], { encoding: 'utf8' });
  if (probe.status === 0) { py = c; break; }
}
if (!py) { fs.writeFileSync(outFile, 'exit=49\\n[FAIL] no usable python on PATH'); process.exit(1); }
const r = spawnSync(py, [...prefix, publishPath, '--article-dir', artDir, '--xiaolvshu', '--config-dir', cfgDir, '--mock'], { encoding: 'utf8' });
fs.writeFileSync(outFile, 'exit=' + r.status + '\\n' + (r.stdout || '') + (r.stderr || ''));
process.exit(r.status === 0 ? 0 : 1);
`,
    "dev-examples/wx-article/scripts/draft_manager/publish.py",
    String(args.articleDir),
    String(args.articleDir) + "/_wxmockcfg",
    String(args.outFile)],
  timeoutMs: 120000,
})
log("mock-sticker-publish 完成, exit=" + r.exitCode)
return { ok: r.exitCode === 0, exitCode: r.exitCode }
