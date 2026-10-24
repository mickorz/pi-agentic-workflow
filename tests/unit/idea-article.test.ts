import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const START_SCRIPT = "dev-examples/wx-article/scripts/idea_article_start.js";
const TURN_SCRIPT = "dev-examples/wx-article/scripts/idea_article_turn.js";

const CANDIDATES = [
  { label: "A", 标题: "框架收藏家的困境", 目标读者: "AI 工具爱好者", 核心观点: "收藏≠学习", 读者收益: "识别囤积心态", 写作角度: "痛点自嘲" },
  { label: "B", 标题: "用做产品的方式学框架", 目标读者: "想做产品的开发者", 核心观点: "以终为始选型", 读者收益: "一套选型清单", 写作角度: "方法论" },
  { label: "C", 标题: "框架是梯子不是天花板", 目标读者: "技术管理者", 核心观点: "抽象层认知", 读者收益: "认知升级", 写作角度: "反常识" },
];

function labelRunner(impls: Record<string, () => unknown>) {
  return makeRunner(async (_prompt, options) => {
    const label = options?.label ?? "";
    const fn = impls[label];
    if (!fn) throw new Error("unexpected agent label: " + label);
    return { type: "structured" as const, value: fn() as object, sessionId: "fake-idea" };
  }).runner;
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** article.yaml 是行式 YAML：取顶层键值（status/currentStage 等） */
function yamlField(file: string, key: string): string {
  const m = readFileSync(file, "utf8").match(new RegExp(`^${key}:\\s*(\\S+)`, "m"));
  return m ? m[1] : "";
}

describe("idea-article start/turn（Phase B e2e：T02–T05/T13/T17）", () => {
  let vault: string;
  let ideaRoot: string;
  let prevEnv: string | undefined;

  before(() => {
    vault = mkdtempSync(path.join(tmpdir(), "idea-art-"));
    ideaRoot = path.join(vault, "60_Workspace", "写作", "灵感");
    mkdirSync(ideaRoot, { recursive: true });
    prevEnv = process.env.OBSIDIAN_VAULT_ROOT;
    process.env.OBSIDIAN_VAULT_ROOT = vault; // command() 子进程继承 process.env → idea_files.py 配置链 env 通道
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.OBSIDIAN_VAULT_ROOT;
    else process.env.OBSIDIAN_VAULT_ROOT = prevEnv;
    rmSync(vault, { recursive: true, force: true });
  });

  const startArgs = {
    content: "为什么你学了那么多 AI 框架，还是做不出产品？收藏从未停止，学习从未开始。\"选型\"就是逃避。",
    message_id: "wxm-test-0001",
  };

  async function runStart(runner: Parameters<typeof runWorkflow>[1]["agent"], args: Record<string, unknown> = startArgs) {
    const result = await runWorkflow(await import("node:fs").then((fs) => fs.readFileSync(path.join(repoRoot, START_SCRIPT), "utf8")), {
      agent: runner,
      cwd: repoRoot,
      args,
    });
    return JSON.parse(JSON.stringify(result.result));
  }

  async function runTurn(runner: Parameters<typeof runWorkflow>[1]["agent"], args: Record<string, unknown>) {
    const result = await runWorkflow(readFileSync(path.join(repoRoot, TURN_SCRIPT), "utf8"), {
      agent: runner,
      cwd: repoRoot,
      args,
    });
    return JSON.parse(JSON.stringify(result.result));
  }

  it("T02 start 全链路：登记+选题+落盘+播报", async () => {
    const labels: string[] = [];
    const runner = labelRunner({
      标题提取: () => { labels.push("标题提取"); return { title: "学框架做不出产品" } },
      选题分析: () => { labels.push("选题分析"); return { candidates: CANDIDATES, suggestion: "推荐 B", questions: ["预期字数?"] } },
      启动播报: () => ({ message: "已创建任务，三个候选见内。" }),
    });
    const r = await runStart(runner);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.articleId, /^art_\d{8}_/);
    const dir = path.join(ideaRoot, "学框架做不出产品");
    assert.ok(existsSync(path.join(dir, "1-idea.md")), "1-idea.md 落盘");
    assert.equal(readFileSync(path.join(dir, "1-idea.md"), "utf8"), startArgs.content, "灵感原文逐字保存");
    const topic = readFileSync(path.join(dir, "2-topic.md"), "utf8");
    assert.match(topic, /### A\. 框架收藏家的困境/);
    assert.match(topic, /## 讨论记录/);
    const st = path.join(dir, "article.yaml");
    assert.equal(yamlField(st, "status"), "waiting_topic_confirmation");
    assert.equal(yamlField(st, "currentStage"), "topic");
    const msgs = readFileSync(path.join(dir, "messages.jsonl"), "utf8").trim().split("\n");
    assert.equal(msgs.length, 1, "init 写入首条用户消息");
    assert.deepEqual(labels, ["标题提取", "选题分析"]);
  });

  it("T03 同 message_id 重投 → 幂等重播不重复生成", async () => {
    const labels: string[] = [];
    const runner = labelRunner({
      标题提取: () => ({ title: "学框架做不出产品" }),
      重播播报: () => { labels.push("重播播报"); return { message: "任务已存在，重播候选。" } },
      选题分析: () => { labels.push("选题分析"); throw new Error("不应重新生成") },
    });
    const r = await runStart(runner);
    assert.equal(r.ok, true);
    assert.equal(r.idempotent, true, JSON.stringify(r));
    assert.deepEqual(labels, ["重播播报"]);
    const msgs = readFileSync(path.join(ideaRoot, "学框架做不出产品", "messages.jsonl"), "utf8").trim().split("\n");
    assert.equal(msgs.length, 1, "幂等不追加消息");
  });

  it("T03b 同标题不同 message_id → conflict 引导不覆盖", async () => {
    const runner = labelRunner({ 标题提取: () => ({ title: "学框架做不出产品" }) }); // 冲突路径其余零 agent 调用
    const r = await runStart(runner, { ...startArgs, message_id: "wxm-test-0002" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "conflict");
    assert.match(r.message, /已有同名文章任务/);
  });

  it("T04 turn 选B → Brief 落盘 + brief_confirmed", async () => {
    const labels: string[] = [];
    const runner = labelRunner({
      "Brief 生成": () => { labels.push("Brief 生成"); return { brief_md: "# 写作 Brief\n\n## 最终选题与标题\n用做产品的方式学框架：以终为始的选型方法论\n\n## 目标读者\n想用 AI 框架做出真实产品的开发者，有技术背景但困于选型\n\n## 核心观点\n框架是手段不是目的，从产品要交付什么反推技术选型，才能避免收藏式学习\n\n## 读者收益\n一套可复用的以终为始选型清单，摆脱囤积心态\n\n## 结构建议\n痛点场景→反例（收藏家）→方法（三步选型）→案例→清单总结\n\n## 语气与风格\n直白、略带自嘲、给 actionable 建议\n\n## 关键素材与事实\n灵感原文中的两句金句与用户讨论中的转行读者背景\n\n## 风险与注意\n不虚构数据；不贬低任何具体框架\n\n## 验收标准\n三段式完稿，含选型清单，读者可直接照做\n\n## 确认记录\n用户于本轮确认方向: B\n" } },
      播报: () => ({ message: "Brief 已生成，回复「继续写文章」开始正文。" }),
    });
    const r = await runTurn(runner, { title: "学框架做不出产品", message: "选B" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.branch, "choose_B");
    const dir = path.join(ideaRoot, "学框架做不出产品");
    const brief = readFileSync(path.join(dir, "3-brief.md"), "utf8");
    assert.match(brief, /## 目标读者/);
    assert.match(brief, /用户于本轮确认方向: B/);
    assert.equal(yamlField(path.join(dir, "article.yaml"), "status"), "brief_confirmed");
    const msgs = readFileSync(path.join(dir, "messages.jsonl"), "utf8").trim().split("\n");
    assert.equal(msgs.length, 3, "user+assistant 各一条追加");
    assert.deepEqual(labels, ["Brief 生成"]);
  });

  it("T04b turn Brief 已确认后再选 → already_confirmed 不重写", async () => {
    const runner = labelRunner({ 播报: () => ({ message: "方向已确认，Brief 已生成。" }) });
    const r = await runTurn(runner, { title: "学框架做不出产品", message: "A" });
    assert.equal(r.ok, true);
    assert.equal(r.branch, "already_confirmed");
    const dir = path.join(ideaRoot, "学框架做不出产品");
    const brief = readFileSync(path.join(dir, "3-brief.md"), "utf8");
    assert.match(brief, /确认方向: B/, "Brief 未被重写");
  });

  it("T05 turn 修改/补充讨论 → 讨论段记录 + 状态不变", async () => {
    // 新任务（未选方向）做讨论分支
    const startRunner = labelRunner({
      标题提取: () => ({ title: "AI 学习路径" }),
      选题分析: () => ({ candidates: CANDIDATES, suggestion: "推荐 A", questions: [] }),
      启动播报: () => ({ message: "ok" }),
    });
    const r0 = await runStart(startRunner, { content: "AI 学习路径的困惑", message_id: "wxm-test-0100" });
    assert.equal(r0.ok, true);
    const runner = labelRunner({ 讨论回应: () => ({ message: "已记录：目标读者调整为转行者。" }) });
    const r = await runTurn(runner, { title: "AI 学习路径", message: "目标读者改成想转行做 AI 产品的人，别太技术向" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.branch, "modify");
    const topic = readFileSync(path.join(ideaRoot, "AI 学习路径", "2-topic.md"), "utf8");
    assert.match(topic, /- 用户: 目标读者改成想转行做 AI 产品的人/);
    assert.equal(yamlField(path.join(ideaRoot, "AI 学习路径", "article.yaml"), "status"), "waiting_topic_confirmation", "讨论不改状态");
  });

  it("T13 turn 暂停 → paused + 恢复话术", async () => {
    const runner = labelRunner({ 播报: () => ({ message: "已暂停，随时回来说「继续 AI 学习路径」。" }) });
    const r = await runTurn(runner, { title: "AI 学习路径", message: "先暂停" });
    assert.equal(r.ok, true);
    assert.equal(r.branch, "pause");
    assert.equal(yamlField(path.join(ideaRoot, "AI 学习路径", "article.yaml"), "status"), "paused");
  });

  it("T17 turn 换方向 → 重新生成候选（避开旧候选）", async () => {
    // 新建一个任务到等待选择态
    const sr = labelRunner({
      标题提取: () => ({ title: "效率工具反思" }),
      选题分析: () => ({ candidates: CANDIDATES, suggestion: "推荐 C", questions: [] }),
      启动播报: () => ({ message: "ok" }),
    });
    await runStart(sr, { content: "效率工具越用越低效", message_id: "wxm-test-0200" });
    const NEW = [
      { label: "A", 标题: "工具极简主义", 目标读者: "重度工具用户", 核心观点: "少即是多", 读者收益: "删工具", 写作角度: "断舍离" },
      { label: "B", 标题: "流程先于工具", 目标读者: "团队负责人", 核心观点: "先理流程", 读者收益: "流程图", 写作角度: "组织视角" },
      { label: "C", 标题: "手动区的价值", 目标读者: "自动化爱好者", 核心观点: "保留手动", 读者收益: "边界感", 写作角度: "反直觉" },
    ];
    const runner = labelRunner({
      重新选题: () => ({ candidates: NEW, suggestion: "推荐 B", questions: [] }),
      播报: () => ({ message: "已换方向，三个新候选。" }),
    });
    const r = await runTurn(runner, { title: "效率工具反思", message: "换方向，都太泛了" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.branch, "regenerate");
    const topic = readFileSync(path.join(ideaRoot, "效率工具反思", "2-topic.md"), "utf8");
    assert.match(topic, /# 选题卡（重新生成）/);
    assert.match(topic, /### A\. 工具极简主义/);
    const hist = path.join(ideaRoot, "效率工具反思", ".history");
    assert.ok(readdirSync(hist).some((f) => /^2-topic-v\d+\.md$/.test(f)), "旧选题卡已备份");
  });

  it("含糊标题命中多任务 → 编号澄清（T06 语义）", async () => {
    // “AI”会命中 AI 学习路径（以及可能的其他 AI 标题任务）——用唯一前缀构造
    const sr = labelRunner({
      标题提取: () => ({ title: "AI 编程助手" }),
      选题分析: () => ({ candidates: CANDIDATES, suggestion: "推荐 A", questions: [] }),
      启动播报: () => ({ message: "ok" }),
    });
    await runStart(sr, { content: "AI 编程助手依赖症", message_id: "wxm-test-0300" });
    const runner = labelRunner({}); // 澄清路径零 agent 调用
    const r = await runTurn(runner, { title: "AI", message: "选A" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "ambiguous");
    assert.ok((r.candidates ?? []).length >= 2, "至少两个候选任务");
    assert.match(r.message, /多个任务匹配/);
  });

  it("turn 零命中 → 引导用主话术创建", async () => {
    const runner = labelRunner({});
    const r = await runTurn(runner, { title: "不存在的任务", message: "选A" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "not_found");
    assert.match(r.message, /做成文章/);
  });
});
