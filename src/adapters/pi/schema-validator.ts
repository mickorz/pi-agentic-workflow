/**
 * JSON Schema 子集校验器（P1-06）
 *
 * 目标：对 agent 结构化输出做"完整"校验（不止顶层必填键），失败分类报告。
 * 支持的关键字（V1 子集）：
 *   type / properties / required / items / enum
 *   minimum / maximum / minLength / maxLength / minItems / maxItems
 *   additionalProperties（boolean）
 *   嵌套 object / array
 *
 * 不做：$ref / allOf / oneOf / patternProperties / format（backlog，按需加）。
 * 不做类型强转：字符串 "true" 不接受为 boolean（fail-fast，不假成功）。
 */

export interface SchemaIssue {
  /** 数据路径，如 ".votes[0].score" */
  path: string;
  /** 违反的关键字 */
  keyword: string;
  message: string;
}

export class SchemaValidationError extends Error {
  readonly issues: SchemaIssue[];

  constructor(issues: SchemaIssue[]) {
    super(
      `schema validation failed: ${issues
        .map((i) => `${i.path || "(root)"} [${i.keyword}] ${i.message}`)
        .join("; ")}`,
    );
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

const TYPEOF: Record<string, (v: unknown) => boolean> = {
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
};

/** 校验 value 是否符合 schema（JSON Schema 子集）；不符抛 SchemaValidationError */
export function validateJsonSchema(value: unknown, schema: Record<string, unknown>): void {
  const issues: SchemaIssue[] = [];
  validate(value, schema, "", issues);
  if (issues.length > 0) throw new SchemaValidationError(issues);
}

function validate(value: unknown, schema: Record<string, unknown>, path: string, issues: SchemaIssue[]): void {
  // type
  const type = schema.type;
  if (typeof type === "string" && !TYPEOF[type]?.(value)) {
    issues.push({ path, keyword: "type", message: `期望 ${type}，实际 ${typeName(value)}` });
    return; // 类型不对，后续关键字无意义
  }
  if (Array.isArray(type)) {
    const matched = type.some((t) => typeof t === "string" && TYPEOF[t]?.(value));
    if (!matched) {
      issues.push({ path, keyword: "type", message: `期望 ${type.join("|")}，实际 ${typeName(value)}` });
      return;
    }
  }

  // enum
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    issues.push({ path, keyword: "enum", message: `值不在枚举 ${JSON.stringify(schema.enum)} 中` });
  }

  if (value === null || typeof value !== "object") {
    // 标量约束
    validateScalar(value, schema, path, issues);
    return;
  }

  if (Array.isArray(value)) {
    validateArray(value, schema, path, issues);
    return;
  }

  validateObject(value as Record<string, unknown>, schema, path, issues);
}

function validateScalar(value: unknown, schema: Record<string, unknown>, path: string, issues: SchemaIssue[]): void {
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      issues.push({ path, keyword: "minimum", message: `${value} < minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      issues.push({ path, keyword: "maximum", message: `${value} > maximum ${schema.maximum}` });
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      issues.push({ path, keyword: "minLength", message: `长度 ${value.length} < minLength ${schema.minLength}` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      issues.push({ path, keyword: "maxLength", message: `长度 ${value.length} > maxLength ${schema.maxLength}` });
    }
  }
}

function validateArray(value: unknown[], schema: Record<string, unknown>, path: string, issues: SchemaIssue[]): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    issues.push({ path, keyword: "minItems", message: `元素数 ${value.length} < minItems ${schema.minItems}` });
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    issues.push({ path, keyword: "maxItems", message: `元素数 ${value.length} > maxItems ${schema.maxItems}` });
  }
  const items = schema.items;
  if (items && typeof items === "object" && !Array.isArray(items)) {
    value.forEach((item, i) => validate(item, items as Record<string, unknown>, `${path}[${i}]`, issues));
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): void {
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const key of required) {
      if (!(key in value)) {
        issues.push({ path, keyword: "required", message: `缺少必填键 "${key}"` });
      }
    }
  }
  const properties = schema.properties;
  if (properties && typeof properties === "object") {
    for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
      if (key in value && sub && typeof sub === "object") {
        validate(value[key], sub as Record<string, unknown>, `${path}.${key}`, issues);
      }
    }
  }
  if (schema.additionalProperties === false && properties && typeof properties === "object") {
    const allowed = new Set(Object.keys(properties as Record<string, unknown>));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        issues.push({ path, keyword: "additionalProperties", message: `多余键 "${key}"` });
      }
    }
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
