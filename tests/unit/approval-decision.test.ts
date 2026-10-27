/**
 * 确定性审批解析单测（2026-10-27 真机教训：非精确「批准」掉进 LLM → 伪授权轮换）
 * 覆盖：精确/序号/纯数字、都批准族、名称消歧（唯一/多命中/零命中）、第N项、长文本护栏。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApprovalDecision } from "../../src/gateway/wechat-app.js";

const PENDINGS = [
  { workflowId: "github-research", resolvedTarget: "cathrynlavery/diagram-design", args: { repoUrl: "https://github.com/cathrynlavery/diagram-design" } },
  { workflowId: "github-research", resolvedTarget: "Plachtaa/V-Express", args: { repoUrl: "https://github.com/Plachtaa/V-Express" } },
];

test("精确形式：批准/拒绝/序号/纯数字（向后兼容）", () => {
  assert.deepEqual(parseApprovalDecision("批准", PENDINGS), { kind: "approve", index: 0 });
  assert.deepEqual(parseApprovalDecision("批准 2", PENDINGS), { kind: "approve", index: 1 });
  assert.deepEqual(parseApprovalDecision("2", PENDINGS), { kind: "approve", index: 1 });
  assert.deepEqual(parseApprovalDecision("拒绝", PENDINGS), { kind: "reject", index: 0 });
  assert.equal(parseApprovalDecision("3", PENDINGS), undefined, "越界序号交回 Agent");
});

test("都批准族：全部/两个都/批准全部 → approve_all；单项时退化为 index 0", () => {
  assert.deepEqual(parseApprovalDecision("都批准", PENDINGS), { kind: "approve_all" });
  assert.deepEqual(parseApprovalDecision("全部批准", PENDINGS), { kind: "approve_all" });
  assert.deepEqual(parseApprovalDecision("批准全部", PENDINGS), { kind: "approve_all" });
  assert.deepEqual(parseApprovalDecision("两个都批准", PENDINGS), { kind: "approve_all" });
  assert.deepEqual(parseApprovalDecision("都批准了", PENDINGS), { kind: "approve_all" });
  assert.deepEqual(parseApprovalDecision("都批准", [PENDINGS[0]!]), { kind: "approve", index: 0 });
});

test("名称消歧：repo 名/URL/动词后置唯一命中", () => {
  assert.deepEqual(parseApprovalDecision("批准 diagram-design", PENDINGS), { kind: "approve", index: 0 });
  assert.deepEqual(parseApprovalDecision("批准 V-Express", PENDINGS), { kind: "approve", index: 1 });
  assert.deepEqual(parseApprovalDecision("diagram-design 批准", PENDINGS), { kind: "approve", index: 0 });
  assert.deepEqual(parseApprovalDecision("批准 github.com/cathrynlavery/diagram-design", PENDINGS), { kind: "approve", index: 0 });
});

test("名称消歧：0/多命中 → ambiguous（回清单要序号，不猜）", () => {
  assert.deepEqual(parseApprovalDecision("批准 thinkrail", PENDINGS), { kind: "ambiguous" });
  assert.deepEqual(parseApprovalDecision("批准 github-research", PENDINGS), { kind: "ambiguous" }, "workflowId 共同命中多项");
});

test("第N项/第N个 → 序号", () => {
  assert.deepEqual(parseApprovalDecision("批准第2项", PENDINGS), { kind: "approve", index: 1 });
  assert.deepEqual(parseApprovalDecision("批准第 2 个", PENDINGS), { kind: "approve", index: 1 });
});

test("护栏：超长文本与长指令不劫持（交回 Agent）", () => {
  assert.equal(parseApprovalDecision("批准一下这篇文章然后帮我发布到草稿箱吧这句很长很长很长很长很长", PENDINGS), undefined);
  const long = "批准 " + "x".repeat(90);
  assert.equal(parseApprovalDecision(long, PENDINGS), undefined);
});
