export const meta = {
  name: "mock_sticker_cards",
  description: "WX-MOCK fixture：小绿书卡片化确定性全链（build→render→normalize→审图→verify→发布授权→mock 入草稿箱），零 LLM 零外部服务",
}
// args: { articleDir, outFile, mode }  mode: full(缺省) | duplicate | unknown-recover
// 产物：outFile = "markers=<逗号标记>\nexit=0\n"
// 断言（场景按 mode）：
//   full:            markers 含 BUILD,RENDER,NORMALIZE,APPROVED,VERIFY,FP,PUBLISH-DRAFTED
//   duplicate:       先 full 语义执行，再重复 execute -> markers 含 PUBLISH-REJECTED（CONSUMED 拒绝）
//   unknown-recover: inject add-timeout -> UNKNOWN-OBSERVED；clear-pending 恢复 -> PUBLISH-DRAFTED
// 术语（2026-11 定案）：贴图=小绿书；publish 走 --mock，零真实费用
// 注意：本文件顶层不得使用 require（workflow 运行时为 ESM）；全部文件/PNG 操作经 node -e 子进程。

const RUNNER = [
  "const { spawnSync } = require('child_process');",
  "let py = null;",
  "for (const c of ['python3', 'python', 'py']) {",
  "  if (spawnSync(c, ['-c', 'import sys'], { encoding: 'utf8' }).status === 0) { py = c; break; }",
  "}",
  "if (!py) { console.error('no usable python'); process.exit(49); }",
  "const r = spawnSync(py, process.argv.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });",
  "process.stdout.write((r.stdout || '') + (r.stderr || ''));",
  "process.exit(r.status);",  // 透传原码（UNKNOWN=2/FAILED=1 等语义由上层区分）,
].join("\n")

// fixture 准备 + PNG 生成（全部在 node -e 子进程：含合法 CRC32 的 1080x1440 PNG）
const PREP_SRC = [
  "const fs = require('fs'), path = require('path'), zlib = require('zlib');",
  "const artDir = process.argv[1];",
  "const card = path.join(artDir, '_cards');",
  "fs.mkdirSync(path.join(card, 'render'), { recursive: true });",
  "const CRC_TABLE = (() => { const t = new Int32Array(256);",
  "  for (let n = 0; n < 256; n++) { let c = n;",
  "    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();",
  "function crc32(buf) { let c = 0xffffffff;",
  "  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);",
  "  return (c ^ 0xffffffff) >>> 0; }",
  "function png(w, h, rgb) {",
  "  const rows = [];",
  "  for (let i = 0; i < h; i++) { const line = Buffer.alloc(1 + w * 3); line[0] = 0;",
  "    for (let x = 0; x < w; x++) { line[1 + x * 3] = rgb[0]; line[2 + x * 3] = rgb[1]; line[3 + x * 3] = rgb[2]; }",
  "    rows.push(line); }",
  "  function chunk(t, d) { const len = Buffer.alloc(4); len.writeUInt32BE(d.length);",
  "    const type = Buffer.from(t); const crc = Buffer.alloc(4);",
  "    crc.writeUInt32BE(crc32(Buffer.concat([type, d])));",
  "    return Buffer.concat([len, type, d, crc]); }",
  "  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);",
  "  ihdr[8] = 8; ihdr[9] = 2;",
  "  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),",
  "    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]); }",
  "const pages = { schema_version: 2, style_mode: 'editorial', theme: 'ink-classic',",
  "  title: 'WXMOCK 小绿书', content: 'Gate B 确定性全链配文。',",
  "  pages: [",
  "    { no: 1, role: 'cover', source: 'html', layout: 'cover-hook',",
  "      copy: { title: '卡片化全链', points: ['构建', '审图', '发布'] }, emphasis: '确定性构建' },",
  "    { no: 2, role: 'point', source: 'html', layout: 'text-card',",
  "      copy: { title: '第二页观点', body: '渲染与验收全部确定性完成。' } },",
  "  ] };",
  "fs.writeFileSync(path.join(card, 'pages.json'), JSON.stringify(pages, null, 1));",
  "fs.writeFileSync(path.join(card, 'render', 'xhs-01.png'), png(1080, 1440, [40, 60, 90]));",
  "fs.writeFileSync(path.join(card, 'render', 'xhs-02.png'), png(1080, 1440, [80, 100, 130]));",
  "fs.mkdirSync(path.join(artDir, '.aws-article'), { recursive: true });",
  "fs.writeFileSync(path.join(artDir, 'aws.env'), 'WECHAT_1_APPID=wxmock\\nWECHAT_1_APPSECRET=s1\\n');",
  "fs.writeFileSync(path.join(artDir, '.aws-article', 'config.json'), '{}');",
  "console.log('fixture ready');",
].join("\n")

const SC = "dev-examples/wx-article/scripts/sticker_cards"
const PUBLISH = "dev-examples/wx-article/scripts/draft_manager/publish.py"
const RENDER = "thirdparties/guizang-social-card-skill/scripts/render.mjs"

// python 脚本确定性执行（node -e 探测 python + 参数数组直传）
async function py(scriptPath, args) {
  return command({
    executable: "node",
    args: ["-e", RUNNER, scriptPath].concat(args),
    timeoutMs: 180000,
  })
}

phase("准备fixture")
await command({
  executable: "node",
  args: ["-e", PREP_SRC, String(args.articleDir)],
  timeoutMs: 60000,
})

const pyBase = ["--pages", args.articleDir + "/_cards/pages.json", "--cards-dir", args.articleDir + "/_cards"]
const markers = []

phase("构建与渲染")
const build = await py(SC + "/build_html.py",
  ["--pages", args.articleDir + "/_cards/pages.json",
   "--out", args.articleDir + "/_cards/index.html",
   "--cards-root", args.articleDir])
if (build.exitCode !== 0) throw new Error("build_html failed: " + build.stdout.slice(-200))
markers.push("BUILD")
const render = await command({
  executable: "node",
  args: [RENDER, args.articleDir + "/_cards/index.html", "--no-embed", "--out", args.articleDir + "/_cards/render"],
  timeoutMs: 300000,
})
if (render.exitCode !== 0) throw new Error("render failed: " + render.stdout.slice(-200))
markers.push("RENDER")

phase("规范化与验收")
const norm = await py(SC + "/normalize_cards.py", pyBase)
if (norm.exitCode !== 0) throw new Error("normalize failed: " + norm.stdout.slice(-200))
markers.push("NORMALIZE")
const rv = await py(SC + "/verify_cards.py", pyBase)
if (rv.exitCode !== 0) throw new Error("verify failed: " + rv.stdout.slice(-200))

phase("人工审图（mock 全 APPROVED）")
const manifest = JSON.parse(await (async () => {
  const r = await command({
    executable: "node",
    args: ["-e", "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))",
           args.articleDir + "/_cards/cards-manifest.json"],
    timeoutMs: 30000,
  })
  return r.stdout
})())
for (const p of manifest.pages) {
  const mr = await py(SC + "/mark_review.py",
    ["--manifest", args.articleDir + "/_cards/cards-manifest.json", "--no", String(p.no),
     "--status", "APPROVED", "--reviewer", "wxmock", "--notes", "gate b"])
  if (mr.exitCode !== 0) throw new Error("mark_review failed")
}
markers.push("APPROVED")
const vr = await py(SC + "/verify_cards.py", pyBase.concat(["--require-approved"]))
if (vr.exitCode !== 0) throw new Error("verify require-approved failed: " + vr.stdout.slice(-200))
markers.push("VERIFY")

phase("发布授权与执行（mock）")
const prep = await py(SC + "/publish_sticker_cards.py",
  pyBase.concat(["--config-dir", args.articleDir, "--prepare"]))
if (prep.exitCode !== 0) throw new Error("publish prepare failed: " + prep.stdout.slice(-200))
const fp = (prep.stdout.match(/发布授权指纹: ([0-9a-f]{64})/) || [])[1]
if (!fp) throw new Error("no fingerprint: " + prep.stdout.slice(-200))
markers.push("FP")

const PUB_ENTRY = SC + "/publish_sticker_cards.py"
const pubBase = pyBase.concat(["--config-dir", args.articleDir, "--mock",
  "--mock-store", args.articleDir + "/_cards/pub-store.json"])
const execPub = (inject) => py(PUB_ENTRY,
  pubBase.concat(["--execute", "--approval", fp])
    .concat(inject ? ["--inject", inject] : []))

const mode = args.mode || "full"
if (mode === "unknown-recover") {
  const bad = await execPub("add-timeout")
  if (bad.exitCode !== 2 || bad.stdout.indexOf("UNKNOWN") === -1) {
    throw new Error("expect UNKNOWN rc=2: " + bad.stdout.slice(-200))
  }
  markers.push("UNKNOWN-OBSERVED")
  const rec = await py(PUB_ENTRY,
    pubBase.concat(["--clear-pending"]))
  if (rec.exitCode !== 0) throw new Error("clear-pending failed: " + rec.stdout.slice(-200))
  const retry = await execPub(null)
  if (retry.exitCode !== 0) throw new Error("recover execute failed: " + retry.stdout.slice(-200))
  markers.push("PUBLISH-DRAFTED")
} else if (mode === "duplicate") {
  const first = await execPub(null)
  if (first.exitCode !== 0) throw new Error("first execute failed")
  markers.push("PUBLISH-DRAFTED")
  const approvalRaw = await (async () => {
    const r = await command({
      executable: "node",
      args: ["-e", "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))",
             args.articleDir + "/_cards/publish-approval.json"],
      timeoutMs: 30000,
    })
    return r.stdout
  })()
  const st = JSON.parse(approvalRaw)
  if (st.status !== "CONSUMED") throw new Error("expect CONSUMED, got " + st.status)
  const again = await py(SC + "/publish_sticker_cards.py",
    pyBase.concat(["--config-dir", args.articleDir, "--execute", "--approval", fp, "--mock",
                   "--mock-store", args.articleDir + "/_cards/pub-store.json"]))
  if (again.exitCode === 0) throw new Error("duplicate execute should be rejected")
  markers.push("PUBLISH-REJECTED")
} else {
  const first = await execPub(null)
  if (first.exitCode !== 0 || first.stdout.indexOf("draft_media_id") === -1) {
    throw new Error("publish failed: " + first.stdout.slice(-200))
  }
  markers.push("PUBLISH-DRAFTED")
}

// 产物落盘（场景断言）
await command({
  executable: "node",
  args: ["-e", "const fs=require('fs');fs.writeFileSync(process.argv[1], process.argv[2]);",
         String(args.outFile),
         "markers=" + markers.join(",") + "\nexit=0\n"],
  timeoutMs: 30000,
})
log("mock-sticker-cards 完成: " + markers.join(","))
return { ok: true, markers }
