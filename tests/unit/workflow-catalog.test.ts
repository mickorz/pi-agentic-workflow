import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderWorkflowCatalog, WORKFLOW_CATALOG_RE } from "../../src/gateway/catalog.js";
import type { WorkflowRegistration } from "../../src/contracts/wx.js";

function row(over: Partial<WorkflowRegistration>): WorkflowRegistration {
  return {
    workflowId: "demo-flow",
    scriptPath: "scripts/demo.js",
    name: "演示",
    description: "",
    argsSchema: { type: "object", properties: {} },
    riskLevel: "read-only",
    enabled: true,
    keywords: ["触发词"],
    ...over,
  };
}

describe("workflow.catalog 确定性目录查询", () => {
  it("命中固定话术（含空格/变体）", () => {
    const hits = ["查看公众号工作流", "公众号工作流", "查看公众号 工作流", "公众号的工作流", "列出公众号工作流支持", "看看公众号流程"];
    for (const t of hits) assert.ok(WORKFLOW_CATALOG_RE.test(t.replace(/\s+/g, "")), t);
  });

  it("不误伤普通句子", () => {
    const misses = [
      "准备 AI 提问的 4 个象限文章",
      "帮我看一下公众号工作流里哪条适合这篇文章", // 长句含词不算
      "公众号文章写好了吗",
      "查看工作流",
    ];
    for (const t of misses) assert.ok(!WORKFLOW_CATALOG_RE.test(t.replace(/\s+/g, "")), t);
  });

  it("渲染 enabled 条目并跳过 disabled；触发示例优先 examples", () => {
    const rows = [
      row({ workflowId: "obsidian-note-create", name: "创建笔记", riskLevel: "write", examples: ["xxx 保存到灵感"] }),
      row({ workflowId: "obsidian-note-search", name: "检索笔记", enabled: false }),
      row({ workflowId: "article-prepare", name: "文章处理入草稿箱", riskLevel: "external-side-effect", examples: ["准备 xxx 文章"] }),
    ];
    const out = renderWorkflowCatalog(rows);
    assert.match(out, /当前支持的工作流（2 条）/);
    assert.match(out, /【创建笔记】obsidian-note-create/);
    assert.match(out, /触发：xxx 保存到灵感（写入）/);
    assert.match(out, /【文章处理入草稿箱】article-prepare/);
    assert.match(out, /（外部副作用）/);
    assert.ok(!out.includes("obsidian-note-search"));
  });

  it("无 examples 时回退 keywords[0]", () => {
    const out = renderWorkflowCatalog([row({ keywords: ["灵感检索"] })]);
    assert.match(out, /触发：灵感检索（只读）/);
  });
});
