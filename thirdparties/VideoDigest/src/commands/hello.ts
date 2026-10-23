import { defineCommand } from '@clibase/core';

/**
 * 示例命令 展示 clibase 基座用法
 * 失败抛 CliError 成功返回 CommandResult 错误与退出由 createCli 统一处理
 */
export const helloCommand = defineCommand({
  name: 'hello',
  description: '示例命令 问候指定名字',
  args: { name: 'name', description: '要问候的名字 省略时默认 世界', required: false },
  options: [{ flags: '--upper', description: '输出大写' }],
  action: async (ctx) => {
    const who = ctx.args[0] ?? '世界';
    const message = ctx.options.upper ? `你好 ${who}`.toUpperCase() : `你好 ${who}`;
    return { success: true, message };
  },
});
