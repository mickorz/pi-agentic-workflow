import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunSupervisor } from "../../src/server/worker-supervisor.ts";
import { createRunApplicationService } from "../../src/application/run-service.ts";
import { readManifest } from "../../src/persistence/run-store.ts";

const repoRoot = process.cwd();
const base = fs.mkdtempSync(path.join(os.tmpdir(), "cp-last-probe-"));
fs.mkdirSync(path.join(base, "proj"), { recursive: true });
const script = path.join(base, "proj", "cp-last.js");
fs.writeFileSync(script, `export const meta = { name: "cp" }\nconst ok = await checkpoint("deploy?")\nreturn { ok }\n`);

const sup = new RunSupervisor({
  baseDir: base,
  maxConcurrentRuns: 2,
  workerCommand: [process.execPath, "--import", "tsx", path.join(repoRoot, "src/server/worker-main.ts")],
  heartbeatIntervalMs: 200,
  heartbeatTimeoutMs: 10000,
  cancelGraceMs: 3000,
  envExtra: { PI_WORKFLOW_TEST_RUNNER: "fake", PI_WORKFLOW_FAKE_DELAY_MS: "0" },
});
const service = createRunApplicationService({ baseDir: base, supervisor: sup, maxConcurrentRuns: 2 });
const { runId } = await service.start({ scriptPath: script });
const t0 = Date.now();
const log = (m: string) => console.log(`[+${Date.now() - t0}ms] ${m}`);

let last = "";
const timer = setInterval(() => {
  const m = readManifest(base, runId);
  const s = m ? `${m.status}` : "(none)";
  if (s !== last) { log(`manifest: ${s}`); last = s; }
  if (["completed", "failed", "cancelled", "interrupted"].includes(s)) {
    clearInterval(timer);
    (async () => {
      const events = await sup.readEventsSince(runId, 0);
      log(`events: ${events.map((e) => `${e.sequence}:${e.type}`).join(" ")}`);
      process.exit(0);
    })();
  }
}, 50);

await new Promise((r) => setTimeout(r, 3000));
const detail = await service.get(runId);
const pending = detail?.checkpoints.find((c) => c.status === "pending");
log(`pending: ${JSON.stringify(pending)}`);
// (skip manual)

const decided = await service.decideCheckpoint(runId, pending!.checkpointId, { decision: "approve", expectedVersion: pending!.version }).catch((e) => `ERR ${e}`);
log(`decide: ${JSON.stringify(decided)}`);

setTimeout(() => {
  const m = readManifest(base, runId);
  log(`final: ${m?.status}`);
  process.exit(1);
}, 10000).unref?.();
