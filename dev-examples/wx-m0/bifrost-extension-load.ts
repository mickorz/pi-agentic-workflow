/**
 * WX-P0 T4 实验 1（对照）：Bifrost 能否以 Pi Extension 形式作用于本项目独立 createAgentSession()
 *
 * 方法：DefaultResourceLoader + additionalExtensionPaths 指向 submodule 的 index.ts，
 * 建 in-memory 会话，观察扩展装载结果与 bifrost/auto 解析表现。
 * 预期（据源码判断）：装载层可能可行，但其分类/虚拟模型机制依赖 Extension 宿主交互生命周期
 * （TUI 命令、ux 状态、session hook），在无头子会话场景不可靠 → 为 LK-02 决策提供对照证据。
 *
 * 运行（仓库根）：npx tsx dev-examples/wx-m0/bifrost-extension-load.ts
 */

import path from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";

async function main(): Promise<number> {
  const extensionPath = path.resolve("thirdparties/pi-bifrost/index.ts");
  console.log(`── 扩展路径：${extensionPath}`);

  try {
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      // 实测：不显式指定 agentDir 时扩展装载报 undefined.startsWith；指定后可装载
      agentDir: path.join(process.env.HOME ?? "", ".pi", "agent"),
      additionalExtensionPaths: [extensionPath],
    });
    await loader.reload();
    const { session, extensionsResult } = await createAgentSession({
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });
    const names = extensionsResult.extensions.map((e: { name?: string; path?: string }) => e.name ?? e.path ?? "?");
    console.log(`   ✓ 会话创建成功；已装载扩展：${names.join(", ") || "（无）"}`);
    const bifrostLoaded = names.some((n) => String(n).includes("bifrost"));
    console.log(`   ${bifrostLoaded ? "✓ Bifrost 已装载" : "✗ Bifrost 未出现在装载列表"}`);
    if (extensionsResult.errors.length > 0) {
      console.log("   装载错误：");
      for (const err of extensionsResult.errors) console.log(`     - ${err.extension ?? "?"}: ${err.error.message}`);
    }
    session.dispose();
    console.log(
      bifrostLoaded
        ? "\n结论：扩展可装载（需显式 agentDir）；但分类器为 LLM 调用、依赖交互宿主生命周期，无头子会话路由行为未验证 → LK-02 主选抽取路径，扩展直挂留作备选"
        : "\n结论：扩展装载路径未生效 → 抽取路径（LK-02 路径 2）为确定选择",
    );
    return 0;
  } catch (e) {
    console.log(`   ✗ 装载失败：${e instanceof Error ? e.message : String(e)}`);
    console.log("\n结论：扩展装载路径不可行 → LK-02 落定抽取路径（纯逻辑模块已在 bifrost-pure-modules.ts 验证）");
    return 0; // 失败本身是有效实验结论，不算脚本错误
  }
}

main().then(
  (c) => (process.exitCode = c),
  (e) => {
    console.error(`❌ ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  },
);
