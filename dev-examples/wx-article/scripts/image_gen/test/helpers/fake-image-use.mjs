// 测试专用假 image-use CLI（P1.6 / IU 系列）：以 node 运行，模拟 vendored 脚本的进程契约。
// 注入：IMAGE_USE_PYTHON=<node 可执行文件> IMAGE_USE_SCRIPT=<本文件>
// 模式（环境变量 FAKE_MODE，缺省正常出图）：
//   normal        写合法 PNG 到 -o 路径，stdout 只打该路径（--quiet 契约）
//   uncertain     stderr 打已提交超时（含会话 URL），exit 1
//   rate-limit    stderr 打账号限流（未提交变体），exit 1
//   bad-output    stdout 空，exit 0
//   path-mismatch 文件写到旁路路径（同目录 .stray 后缀），stdout 打旁路路径，exit 0
//   sleep-pre     stderr 打早期时间线（无提交标记）后长睡（外部中断测 pre-submit）
//   sleep-post    stderr 打提交标记后长睡（外部中断/自超时测 post-submit）
//   crash         exit 3 + 乱 stderr
// 调用记录：FAKE_CALLS_FILE 非空时每次调用追加一行 JSONL（无误重试断言的事实源）。
import fsp from "node:fs/promises";
import path from "node:path";
import { encodePng } from "../../lib/providers/fake.mjs";

const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}
const outPath = argValue("-o");
const mode = process.env.FAKE_MODE || "normal";
const SLEEP_MS = 20_000;

if (process.env.FAKE_CALLS_FILE) {
  await fsp.appendFile(process.env.FAKE_CALLS_FILE, JSON.stringify({ mode, outPath, ts: Date.now() }) + "\n");
}

if (mode === "sleep-pre") {
  process.stderr.write("[  3.1s] opening ChatGPT via relay (drives your open Chrome)\n[  5.0s] using project 'imagegen'\n");
  await new Promise((r) => setTimeout(r, SLEEP_MS));
  process.exit(1);
}
if (mode === "sleep-post") {
  process.stderr.write("[  8.2s] pasting prompt\n[  8.4s] verified prompt (12 characters) and 0 reference image(s)\n[  8.5s] prompt submitted once\n");
  await new Promise((r) => setTimeout(r, SLEEP_MS));
  process.exit(1);
}
if (mode === "uncertain") {
  process.stderr.write(
    "[300.0s] timed out after 300s waiting to confirm the image (last phase: polling)\n" +
      "The prompt was already submitted; check the conversation before retrying: https://chatgpt.com/c/fake-conv-id\n",
  );
  process.exit(1);
}
if (mode === "rate-limit") {
  process.stderr.write("chatgpt.com rate-limited this account ('Too many requests') — the page surface temporarily blocked the account\n");
  process.exit(1);
}
if (mode === "crash") {
  process.stderr.write("weird internal crash\n");
  process.exit(3);
}
if (mode === "bad-output") {
  process.exit(0);
}

// normal / path-mismatch：写真实 PNG（复用 fake.mjs 确定性编码）
// 尺寸对齐 fake provider 的 body（1024×576，压后几十 KB）：64×48 压缩后仅几百字节且随 seed 波动，
// 在 verify 的 1024B 最小图阈值上下摇摆导致成功路径用例 flaky（T6 实测：同用例换 tmp 目录即 too-small）
const target = mode === "path-mismatch" ? outPath.replace(/(\.[a-z0-9]+)$/i, ".stray$1") : outPath;
await fsp.mkdir(path.dirname(target), { recursive: true }).catch(() => {});
await fsp.writeFile(target, encodePng(1024, 576, argv.join(" ")));
process.stdout.write(target + "\n");
process.exit(0);
