/**
 * 微信 Bot PM2 生态配置（P0-B 使用，P0-A 先定型启动形态）
 *
 * 形态：node --import tsx src/cli/index.ts wechat start —— 单进程，无重执行包装，
 * PM2 托管的就是实际 Bot 进程（需求 §7.4 风险备忘第 1 条）。
 *
 * 使用（P0-B 起生效）：仓库根执行 `pm2 start dev-examples/wechat-service/ecosystem.config.cjs`
 *
 * 配置项依据需求 §7.2 评审清单；shutdown_with_message 为 Windows 优雅停止关键项，
 * Bot 侧 process.on("message", "shutdown") 在 P0-B 实现。
 */
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "wechat-bot",
      script: "src/cli/index.ts", // 入口（TS，经 node_args 的 tsx loader 加载）
      args: "wechat start",
      node_args: "--import tsx",
      cwd: path.resolve(__dirname, "../.."), // 仓库根：registry/scripts/data 缺省路径锚点
      exec_mode: "fork",
      instances: 1,
      shutdown_with_message: true,
      kill_timeout: 10000, // 优雅停止超时后强杀兜底
      exp_backoff_restart_delay: 1000, // 崩溃重启退避
      min_uptime: "30s",
      max_restarts: 10, // 连续不稳定重启上限（非全时间窗总数）
      out_file: ".pi-wechat/logs/out.log",
      error_file: ".pi-wechat/logs/err.log",
      time: true,
    },
  ],
};
