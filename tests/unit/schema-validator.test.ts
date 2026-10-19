/** P1-06：JSON Schema 校验器——缺字段/类型错误被拒绝（不止顶层必填键） */

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateJsonSchema, SchemaValidationError } from "../../src/adapters/pi/schema-validator.js";

const schema = {
  type: "object",
  properties: {
    real: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 1 },
    tags: { type: "array", items: { type: "string" }, minItems: 1 },
    meta: {
      type: "object",
      properties: { source: { type: "string" } },
      required: ["source"],
    },
  },
  required: ["real", "score"],
};

test("合法值通过", () => {
  validateJsonSchema({ real: true, score: 0.5, tags: ["a"], meta: { source: "x" } }, schema);
});

test("缺必填键被拒绝（顶层）", () => {
  assert.throws(
    () => validateJsonSchema({ score: 0.5 }, schema),
    (e: unknown) => e instanceof SchemaValidationError && e.issues.some((i) => i.keyword === "required"),
  );
});

test("嵌套对象缺必填键被拒绝（P1-06：不止顶层）", () => {
  assert.throws(
    () => validateJsonSchema({ real: true, score: 0.5, meta: {} }, schema),
    (e: unknown) => e instanceof SchemaValidationError && e.issues.some((i) => i.path === ".meta" && i.keyword === "required"),
  );
});

test("类型错误被拒绝（含数组元素与嵌套）", () => {
  assert.throws(
    () => validateJsonSchema({ real: "true", score: 0.5 }, schema),
    (e: unknown) => e instanceof SchemaValidationError && e.issues.some((i) => i.path === ".real" && i.keyword === "type"),
  );
  assert.throws(
    () => validateJsonSchema({ real: true, score: 0.5, tags: ["a", 42] }, schema),
    (e: unknown) => e instanceof SchemaValidationError && e.issues.some((i) => i.path === ".tags[1]" && i.keyword === "type"),
  );
  assert.throws(
    () => validateJsonSchema({ real: true, score: 0.5, meta: { source: 7 } }, schema),
    (e: unknown) => e instanceof SchemaValidationError && e.issues.some((i) => i.path === ".meta.source" && i.keyword === "type"),
  );
});

test("数值范围与数组长度约束", () => {
  assert.throws(
    () => validateJsonSchema({ real: true, score: 1.5 }, schema),
    (e: unknown) => e instanceof SchemaValidationError && e.issues.some((i) => i.keyword === "maximum"),
  );
  assert.throws(
    () => validateJsonSchema({ real: true, score: 0.5, tags: [] }, schema),
    (e: unknown) => e instanceof SchemaValidationError && e.issues.some((i) => i.keyword === "minItems"),
  );
});

test("不做类型强转：字符串 \"true\" 不接受为 boolean", () => {
  assert.throws(() => validateJsonSchema({ real: "true", score: 0.5 }, schema), SchemaValidationError);
});

test("enum 与 additionalProperties=false", () => {
  const s = {
    type: "object",
    properties: { level: { type: "string", enum: ["low", "high"] } },
    required: ["level"],
    additionalProperties: false,
  };
  validateJsonSchema({ level: "low" }, s);
  assert.throws(() => validateJsonSchema({ level: "mid" }, s), SchemaValidationError);
  assert.throws(() => validateJsonSchema({ level: "low", extra: 1 }, s), SchemaValidationError);
});

test("integer 类型区分", () => {
  assert.throws(() => validateJsonSchema(1.5, { type: "integer" }), SchemaValidationError);
  validateJsonSchema(2, { type: "integer" });
});
