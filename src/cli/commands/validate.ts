/**
 * pi-workflow validate <script.js> —— 校验脚本（P0：meta 信封 + 确定性快检 + JS 语法）
 */

import fs from "node:fs";
import path from "node:path";
import { parseWorkflowScript } from "../../runtime/vm.js";

export async function validate(argv: string[]): Promise<number> {
  const target = argv[0];
  if (!target || target.startsWith("--")) {
    process.stderr.write("用法：pi-workflow validate <script.js>\n");
    return 2;
  }

  const file = path.resolve(target);
  let script: string;
  try {
    script = fs.readFileSync(file, "utf-8");
  } catch (error) {
    process.stderr.write(`无法读取脚本：${file}\n${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  try {
    const { meta } = parseWorkflowScript(script);
    process.stdout.write(
      `${JSON.stringify({ valid: true, file, meta }, null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`校验失败：${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
