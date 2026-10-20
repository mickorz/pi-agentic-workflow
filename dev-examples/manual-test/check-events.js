// 事件流断言：sequence 连续递增 + 关键事件类型齐全
// 用法：node check-events.js <events.jsonl>
const fs = require("fs");
const lines = fs
  .readFileSync(process.argv[2], "utf8")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const seqs = lines.map((e) => e.sequence);
const cont = seqs.every((s, i) => s === i + 1);
console.log(cont ? "SEQ_OK" : "SEQ_BROKEN");

const types = new Set(lines.map((e) => e.type));
const need = ["run.started", "node.started", "node.completed", "run.completed", "agent.session.created"];
const missing = need.filter((t) => !types.has(t));
console.log(missing.length === 0 ? "TYPES_OK" : "TYPES_MISSING:" + missing.join(","));
