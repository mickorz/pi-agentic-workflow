export const meta = {
  name: "mock_fail",
  description: "WX-MOCK fixture：确定性失败（E2 断言错误回执与终态）",
}
// args: { reason: string }
// 脚本级 throw：runWorkflow 捕获 → run.failed → 任务 failed（服务存活）
throw new Error("mock failure: " + String(args.reason ?? "unspecified"))
