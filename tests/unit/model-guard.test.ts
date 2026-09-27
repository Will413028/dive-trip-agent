import { expect, test, vi } from 'vitest';
import { BaseLlm, FunctionTool, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import { z } from 'zod';
import { GuardedModel, MODEL_LIMITS } from '../../src/agent/model-guard';
import { validatedProposalParametersSchema } from '../../src/agent/tool-schemas';

class Script extends BaseLlm {
  calls = 0;
  constructor(readonly responses: LlmResponse[]) { super({ model: 'offline-guard-test' }); }
  async *generateContentAsync() { this.calls++; yield* this.responses; }
  async connect(): Promise<BaseLlmConnection> { throw new Error('NO_NETWORK'); }
}
function request(): LlmRequest {
  const tool = new FunctionTool({ name: 'find_items', description: 'test',
    parameters: z.strictObject({ destinationId: z.literal('xiaoliuqiu') }), execute: () => ({}) });
  return { contents: [{ role: 'user', parts: [{ text: '請查詢' }] }], liveConnectConfig: {}, toolsDict: { find_items: tool } };
}
const text: LlmResponse = { content: { role: 'model', parts: [{ text: JSON.stringify({ version: '1', answer: { kind: 'clarify', fields: ['people'] } }) }] } };
const call = (id: string, name = 'find_items', args: unknown = { destinationId: 'xiaoliuqiu' }) => ({
  functionCall: { id, name, args: args as Record<string, unknown> },
});
async function collect(model: GuardedModel, input = request(), signal?: AbortSignal) {
  const values = []; for await (const value of model.generateContentAsync(input, false, signal)) values.push(value);
  return values;
}
test('第8次模型呼叫在provider之前拒絕；輸出token/config有界', async () => {
  const source = new Script([text]); const model = new GuardedModel(source, { modelCalls: 6, toolCalls: 0 });
  const input = request();
  expect(await collect(model, input)).toEqual([text]);
  await expect(collect(new GuardedModel(source, { modelCalls: 7, toolCalls: 0 }))).rejects.toThrow('AGENT_MODEL_LIMIT');
  expect(source.calls).toBe(1);
  expect(input.config?.maxOutputTokens).toBe(MODEL_LIMITS.outputTokens);
  expect(input.config?.thinkingConfig).toEqual({ includeThoughts: false });
});
test('整批7工具預先拒絕，沒有任何call yield給ADK執行', async () => {
  const model = new GuardedModel(new Script([{ content: { role: 'model', parts: Array.from({ length: 7 }, (_, i) => call(String(i))) } }]));
  const seen: LlmResponse[] = [];
  await expect((async () => { for await (const response of model.generateContentAsync(request())) seen.push(response); })()).rejects.toThrow('AGENT_TOOL_LIMIT');
  expect(seen).toEqual([]);
});
test.each([
  ['未知工具', call('a', 'send_email'), 'AGENT_TOOL_NOT_ALLOWED'],
  ['額外權限參數', call('a', 'find_items', { destinationId: 'xiaoliuqiu', actor: 'user' }), 'AGENT_TOOL_ARGUMENTS'],
  ['不存在的目的地', call('a', 'find_items', { destinationId: 'nowhere' }), 'AGENT_TOOL_ARGUMENTS'],
] as const)('%s在執行前失敗', async (_name, part, code) => {
  await expect(collect(new GuardedModel(new Script([{ content: { role: 'model', parts: [part] } }])))).rejects.toThrow(code);
});
test('跨多次輸出、已有歷史工具也共用6次上限', async () => {
  const source = new Script([{ content: { role: 'model', parts: [call('last')] } }]);
  const model = new GuardedModel(source, { modelCalls: 3, toolCalls: 5 });
  await collect(model);
  await expect(collect(model)).rejects.toThrow('AGENT_TOOL_LIMIT');
});
test('resume不重設已提案旗標或歷史call IDs', async () => {
  const proposal = { functionCall: { id: 'new-proposal', name: 'propose_changes', args: { changes: [{ kind: 'remove', entryId: 'tour' }] } } };
  const model = new GuardedModel(new Script([{ content: { parts: [proposal] } }]),
    { modelCalls: 2, toolCalls: 2, proposed: true, callIds: ['old-read', 'old-proposal'] });
  await expect(collect(model)).rejects.toThrow('AGENT_PROPOSAL_LIMIT');
  await expect(collect(new GuardedModel(new Script([{ content: { parts: [call('old-read')] } }]),
    { modelCalls: 2, toolCalls: 2, callIds: ['old-read'], proposed: true }))).rejects.toThrow('AGENT_MODEL_RESPONSE');
});
test.each([
  { modelCalls: 6, toolCalls: 0 }, { modelCalls: 5, toolCalls: 5 }, { modelCalls: 6, toolCalls: 5 },
])('提案可用第7次模型／第6次工具，不預留receipt額度（歷史$modelCalls/$toolCalls）', async previous => {
  const response: LlmResponse = { content: { role: 'model', parts: [call('proposal', 'propose_changes',
    { validationId: '00000000-0000-4000-8000-000000000001' })] } };
  const source = new Script([response]);
  const model = new GuardedModel(source, previous);
  const input = request();
  input.toolsDict.propose_changes = new FunctionTool({ name: 'propose_changes', description: 'test',
    parameters: validatedProposalParametersSchema, execute: () => ({}) });
  expect(await collect(model, input)).toEqual([response]);
  expect(source.calls).toBe(1);
  expect(model.callCounts).toEqual({ modelCalls: previous.modelCalls + 1, toolCalls: previous.toolCalls + 1 });
});
test('Gemini省略functionCall ID時，服務端補上穩定事件ID', async () => {
  const part = { functionCall: { name: 'find_items', args: { destinationId: 'xiaoliuqiu' } } };
  const response = await collect(new GuardedModel(new Script([{ content: { parts: [part] } }])));
  expect(response[0].content?.parts?.[0].functionCall?.id).toMatch(/^[0-9a-f-]{36}$/);
});
test.each([
  [], [{}], [{ content: { role: 'model', parts: [] } }],
  [{ partial: true, content: { role: 'model', parts: [{ text: 'partial' }] } }],
  [text, text],
].map(responses => ({ responses })))('空／partial／只有thought／多筆回應不冒充成功 %#', async ({ responses }) => {
  await expect(collect(new GuardedModel(new Script(responses as LlmResponse[])))).rejects.toThrow('AGENT_MODEL_RESPONSE');
});
test('thought與未驗證正文不能走舊raw模式', async () => {
  for (const parts of [[{ text: 'secret', thought: true }], [{ text: '自由價格 TWD 330' }]]) {
    await expect(collect(new GuardedModel(new Script([{ content: { parts } }])))).rejects.toThrow('AGENT_ANSWER_SCHEMA');
  }
});
test('截斷／拒答與錯誤終態不可執行工具', async () => {
  for (const finishReason of ['MAX_TOKENS', 'SAFETY', 'MALFORMED_FUNCTION_CALL']) {
    await expect(collect(new GuardedModel(new Script([{ ...text, finishReason: finishReason as LlmResponse['finishReason'] }])))).rejects.toThrow();
  }
});
test('UTF8輸入與輸出上限，不靜默截斷工具JSON', async () => {
  const source = new Script([text]); const input = request();
  input.contents[0].parts = [{ text: '潛'.repeat(MODEL_LIMITS.inputBytes / 2) }];
  await expect(collect(new GuardedModel(source), input)).rejects.toThrow('AGENT_CONTEXT_LIMIT');
  expect(source.calls).toBe(0);
  await expect(collect(new GuardedModel(new Script([{ content: { parts: [{ text: 'x'.repeat(MODEL_LIMITS.outputBytes) }] } }])))).rejects.toThrow('AGENT_OUTPUT_LIMIT');
});
test('不信任模型functionResponse／重複call id／批次多提案', async () => {
  for (const parts of [[{ functionResponse: { name: 'find_items', response: {} } }], [call('same'), call('same')]]) {
    await expect(collect(new GuardedModel(new Script([{ content: { parts } }])))).rejects.toThrow('AGENT_MODEL_RESPONSE');
  }
});
test('已取消零provider呼叫；無回應provider也受deadline限制', async () => {
  const source = new Script([text]);
  await expect(collect(new GuardedModel(source), request(), AbortSignal.abort())).rejects.toThrow('AGENT_ABORTED');
  expect(source.calls).toBe(0);
  vi.spyOn(source, 'generateContentAsync').mockImplementation(async function* () { await new Promise(() => {}); yield text; });
  await expect(collect(new GuardedModel(source), request(), AbortSignal.timeout(15))).rejects.toThrow('AGENT_ABORTED');
});
