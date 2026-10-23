import { chat } from '@clibase/core';
import type { LlmConfig, ChatMessage } from '@clibase/core';

/**
 * 提炼用的系统提示词。
 * 强制按 video-digest 的固定格式输出（一句话概括 + ①② 分点 + 核心观点），
 * 约束只基于逐字稿、纠正明显 ASR 错字、不确定的专有名词标 [?]。
 */
const SYSTEM = `你是一名严谨的内容编辑。基于用户提供的视频逐字稿提炼重点，严格遵守：
1. 只基于逐字稿真实内容，绝不补充逐字稿没有的信息，不臆测。
2. 纠正上下文中明显的语音识别错别字（同音、形近）。
3. 无法确认的专有名词（人名、产品名、术语）用 [?] 标注，不要猜测。
4. 输出严格采用下面的结构，使用纯文本，不要加代码围栏，不要输出结构之外的说明文字：

[一句话概括核心价值]

① 名称：具体说明
② 名称：具体说明
...

核心观点：[一句话总结]

其中 ①②… 为分点要点，逐字稿有几个实质要点就列几条（至少 1 条，通常 3 到 6 条）。`;

/** 用 LLM 按固定格式提炼逐字稿重点，返回纯文本 */
export async function summarizeTranscript(transcript: string, config: LlmConfig): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `以下是视频逐字稿，请按要求提炼：\n\n${transcript}` },
  ];
  // chat 已自动去掉代码围栏，返回纯文本
  return chat({ messages }, config);
}
