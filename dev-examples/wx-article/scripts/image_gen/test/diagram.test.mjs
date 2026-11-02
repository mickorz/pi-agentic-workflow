// diagram Provider 单元测试（node --test，零费用）：E_NO_SOURCE、真实渲染、确定性、GIF 白名单间接验证。
// 运行：node --test test/diagram.test.mjs（在 image_gen/ 下；首次会触发 beautiful-mermaid 依赖自动安装，需网络）
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = await import("../lib/providers/diagram.mjs");
const provider = mod;

const MMD = `flowchart LR
    A["事件源"] --> B["规则过滤"]
    B --> R["Router"]
`;

test("E_NO_SOURCE：缺 diagram_source 不可恢复报错", async () => {
  const out = path.join(os.tmpdir(), `diag-test-${Date.now()}.png`);
  await assert.rejects(
    () => provider.generate({ outPath: out }),
    (e) => e.code === "E_NO_SOURCE" && e.recoverable === false,
  );
  assert.equal(fs.existsSync(out), false);
});

test("真实渲染：mermaid → PNG，尺寸有效、确定性（同源码同字节）", async () => {
  const dir = fsp.mkdtemp ? await fsp.mkdtemp(path.join(os.tmpdir(), "diag-")) : os.tmpdir();
  const out1 = path.join(dir, "04-架构.png");
  const r1 = await provider.generate({ diagramSource: MMD, outPath: out1 });
  assert.equal(fs.existsSync(out1), true);
  assert.ok(r1.bytes > 0);
  assert.equal(r1.provider, "diagram");
  assert.equal(r1.format, "png");
  assert.ok(r1.width >= 100 && r1.height >= 100, `尺寸异常：${r1.width}x${r1.height}`);
  const bytes1 = await fsp.readFile(out1);

  const out2 = path.join(dir, "04-架构-2.png");
  const r2 = await provider.generate({ diagramSource: MMD, outPath: out2 });
  const bytes2 = await fsp.readFile(out2);
  assert.deepEqual(bytes2, bytes1, "同源码两次渲染应字节级一致（确定性）");
  await fsp.rm(dir, { recursive: true, force: true });
});
