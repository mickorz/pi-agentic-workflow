/**
 * workflow 脚本解析与 VM 执行（迁移自参考仓库 src/runtime/vm.ts，语义一致）
 *
 * 解析流程：
 *  DETERMINISM_BLOCKLIST 正则快检
 *   -> acorn 解析（module 模式）
 *   -> 首语句必须是 export const meta = 字面量
 *   -> evaluateLiteral 求值 meta（仅允许 对象/数组/字符串/数字/布尔/一元负号）
 *   -> 剥离 meta 语句，剩余为 body
 *
 * 执行流程：
 *  vm.createContext(仅注入运行时函数，不注入宿主内建)
 *   -> DETERMINISM_PRELUDE（vm 域内中和 Math.random / Date.now / new Date()）
 *   -> 包裹为 (async () => { body })() 执行
 *
 * 注意：vm 不是安全沙箱，防的是可信脚本的"意外非确定性"，不是攻击。
 */

import { parse, type Node } from "acorn";
import vm from "node:vm";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import type { WorkflowMeta } from "./types.js";

/** 解析期快检（真正的强制在 DETERMINISM_PRELUDE 运行时中和） */
const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

/**
 * 运行时确定性加固，在 vm 域内、用户脚本之前执行：
 *   - Math.random()        -> 抛错
 *   - Date.now()           -> 抛错
 *   - Date() / new Date()  -> 抛错（无参）；new Date(arg) 仍可用
 */
const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

type AnyNode = Node & { [key: string]: any; start: number; end: number };

/** 解析 workflow 脚本：校验 meta 信封并剥离，返回 meta 与可执行 body */
export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  if (DETERMINISM_BLOCKLIST.test(script)) {
    throw new WorkflowError(
      "workflow 脚本必须可确定性重放：Date.now() / Math.random() / new Date() 不可用",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new WorkflowError(
      "脚本首条语句必须是 `export const meta = { name, description, phases }`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowError("meta 导出必须是 `export const meta = ...`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  if (declaration.declarations.length !== 1) {
    throw new WorkflowError("meta 导出只能声明 `meta` 一个变量", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new WorkflowError("meta 导出必须声明为 `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  if (!declarator.init) {
    throw new WorkflowError("meta 必须有字面量值", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
  }

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

/** 仅允许纯字面量（对象/数组/字符串/数字/布尔/null），防 meta 中藏代码 */
function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`${path} 中不允许 spread`);
        if (prop.type !== "Property") throw new Error(`${path} 中只允许普通属性`);
        if (prop.computed) throw new Error(`${path} 中不允许计算属性名`);
        if (prop.kind !== "init" || prop.method) throw new Error(`${path} 中不允许方法/存取器`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`${path} 中不允许保留键名: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`${path} 中不允许稀疏数组`);
        if (element.type === "SpreadElement") throw new Error(`${path} 中不允许 spread`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`${path} 中模板字符串不允许插值`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`${path} 中只允许负数字面量的一元表达式`);
    default:
      throw new Error(`${path} 中不允许 ${node.type}，meta 只能是纯字面量`);
  }
}

function propertyKey(key: AnyNode, path: string): string {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return String(key.value);
  throw new Error(`${path} 的属性名必须是标识符或字符串`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta 必须是对象字面量");
  const value = meta as Record<string, unknown>;
  if (typeof value.name !== "string" || !/^[a-z][a-z0-9_]*$/i.test(value.name)) {
    throw new Error("meta.name 必须是非空的 snake_case 字符串");
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error("meta.description 必须是字符串");
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases 必须是数组");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as { title?: unknown }).title !== "string") {
        throw new Error("meta.phases 的每一项必须含 title 字符串");
      }
    }
  }
  // P1a Phase W（方案 §3）：能力声明仅元数据（如 "obsidian-write"）；
  // 写能力门在 workflow-runtime（meta.capabilities ⊕ shared.authorized）
  if (value.capabilities !== undefined) {
    if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
      throw new Error("meta.capabilities 必须是非空字符串数组");
    }
    const seen = new Set<string>();
    for (const cap of value.capabilities) {
      if (typeof cap !== "string" || !/^[a-z][a-z0-9-]*$/.test(cap)) {
        throw new Error(`meta.capabilities 条目非法（kebab-case）：${String(cap)}`);
      }
      if (seen.has(cap)) {
        throw new Error(`meta.capabilities 条目重复：${cap}`);
      }
      seen.add(cap);
    }
  }
}

/** 在 vm 沙箱中执行 workflow body，返回脚本 return 值 */
export async function runScriptInVm(
  body: string,
  metaName: string,
  globals: Record<string, unknown>,
): Promise<unknown> {
  const context = vm.createContext({
    ...globals,
    // Object/Array/JSON/Math/Date/Promise 等来自 vm 域自身——刻意不注入宿主内建，
    // 其 .constructor 会是宿主 Function（绕过确定性护栏）；Math/Date 由 PRELUDE 在域内中和
  });

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  const script = new vm.Script(wrapped, { filename: `${metaName || "workflow"}.js` });
  return (await script.runInContext(context)) as unknown;
}
