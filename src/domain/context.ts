import { RequestError, requestEstimate, type Message, type Tool } from '../model/types.js';

// 只裁掉完整的旧轮次；最新输入、动态状态和工具调用链保持完整。
export function fitContext(messages: Message[], tools: Tool[], budget: number): Message[] {
  const result = messages.map((message) => ({
    ...message,
    cache: message.role === 'system' && message.cache,
  }));
  const dynamic = result.length - 1;
  let latestUser = -1;
  for (let index = dynamic - 1; index > 0; index--)
    if (result[index]!.role === 'user') {
      latestUser = index;
      break;
    }
  let protectedAt = latestUser < 0 ? dynamic : latestUser;
  while (requestEstimate(result, tools) > budget && protectedAt > 1) {
    let end = 2;
    while (end < protectedAt && result[end]!.role !== 'user') end++;
    const removed = end - 1;
    result.splice(1, removed);
    protectedAt -= removed;
  }
  if (requestEstimate(result, tools) > budget)
    throw new RequestError('最新输入与必要状态已超过输入预算', 'budget');
  if (result.length > 2) result[result.length - 2]!.cache = true;
  return result;
}
