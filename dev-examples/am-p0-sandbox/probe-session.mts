import { SessionManager } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-sess-"));
const file = path.join(dir, "u1.jsonl");
const m1 = SessionManager.open(file, dir, process.cwd());
console.log("fresh sessionId:", m1.getSessionId(), "persisted:", m1.isPersisted());
m1.appendMessage({ role: "user", content: [{ type: "text", text: "你好" }] });
console.log("file exists after append:", fs.existsSync(file));
const m2 = SessionManager.open(file, dir, process.cwd());
console.log("reopen sessionId:", m2.getSessionId(), "entries:", m2.getEntryCount());
console.log("replay ok:", JSON.stringify(m2.buildSessionContext()).includes("你好"));
console.log("same session file:", m2.getSessionFile());
