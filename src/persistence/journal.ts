/**
 * Journal —— append-only JSONL 持久化（P2）
 *
 * 契约：
 *  - 每行一个 JSON 对象：{ key, hash, result, ...元数据 }
 *  - append-only：只追加，不重写；损坏行跳过并计数（读端容忍）
 *  - key 为 scope 稳定身份（runId:callIndex / runId:wfK:callIndex）
 */

import fs from "node:fs";
import path from "node:path";
import type { JournalEntry } from "../runtime/types.js";

export type { JournalEntry };
export type Journal = Map<string, JournalEntry & { key: string }>;

/** 从 journal.jsonl 加载（损坏行跳过，返回条目数与跳过数） */
export function loadJournal(runDir: string): { journal: Journal; entries: number; skipped: number } {
  const file = journalPath(runDir);
  const journal: Journal = new Map();
  if (!fs.existsSync(file)) return { journal, entries: 0, skipped: 0 };
  let entries = 0;
  let skipped = 0;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as JournalEntry & { key: string };
      if (typeof parsed.key === "string" && typeof parsed.hash === "string") {
        journal.set(parsed.key, parsed);
        entries++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  return { journal, entries, skipped };
}

/** 追加一条 journal 条目（同步写：成功路径的耐久点） */
export function appendJournalEntry(runDir: string, entry: JournalEntry & { key: string }): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.appendFileSync(journalPath(runDir), `${JSON.stringify(entry)}\n`, "utf-8");
}

export function journalPath(runDir: string): string {
  return path.join(runDir, "journal.jsonl");
}
