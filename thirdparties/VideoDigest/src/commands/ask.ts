import { defineCommand, CliError, chat, loadModelConfig } from '@clibase/core';

/**
 * 示例 LLM 命令 文本问答
 * 演示 clibase core 的 LLM 能力 配置见 README 的 LLM 能力节
 * 加自己的 AI 命令 在 src commands 建文件后注册进 index ts
 */
export const askCommand = defineCommand({
  name: 'ask',
  description: '示例 LLM 命令 向大模型提问',
  args: { name: 'question', description: '要问的问题', required: true, variadic: true },
  action: async (ctx) => {
    const question = ctx.args.join(' ').trim();
    if (!question) {
      throw new CliError('请提供问题', '参数校验');
    }
    const config = loadModelConfig(ctx.config, 'text');
    ctx.spinner.start('正在思考...');
    let answer: string;
    try {
      answer = await chat(
        {
          messages: [
            { role: 'system', content: '你是一个简洁的助手 直接回答问题' },
            { role: 'user', content: question },
          ],
        },
        config,
      );
    } finally {
      ctx.spinner.stop();
    }
    console.log(answer);
    return { success: true, message: '回答完成', data: { answer } };
  },
});
