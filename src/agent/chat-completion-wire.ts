import { isFunctionTool, type LlmRequest, type LlmResponse } from '@google/adk';
import { z } from 'zod';
import { agentToolParameters } from './tool-schemas.ts';
import { AgentProviderError } from './provider-errors.ts';
import { answerPlanSchema } from '../domain/answer.ts';
import { FINAL_RESPONSE_TOOL } from './model-guard.ts';
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const invalid = (): never => { throw new AgentProviderError('AGENT_PROVIDER_INVALID_RESPONSE'); };

/** Only this project's text/function vocabulary is supported. ADK owns the loop. */
export function chatCompletionRequest(input: LlmRequest) {
  const messages: Record<string, unknown>[] = [];
  const instruction = input.config?.systemInstruction;
  if (instruction) {
    const parts = typeof instruction === 'string' ? [{ text: instruction }]
      : Array.isArray(instruction) ? instruction.map(part => typeof part === 'string' ? { text: part } : part)
      : 'parts' in instruction ? instruction.parts ?? [] : [instruction];
    const textParts = z.array(z.strictObject({ text: z.string() })).safeParse(parts);
    if (!textParts.success) return invalid();
    messages.push({ role: 'system', content: textParts.data.map(part => part.text).join('\n') });
  }
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  for (const content of input.contents) {
    if (content.role !== 'user' && content.role !== 'model') invalid();
    const texts: string[] = [];
    const calls: unknown[] = [];
    const results: Record<string, unknown>[] = [];
    for (const part of content.parts ?? []) {
      if (Object.keys(part).some(key => !['text', 'functionCall', 'functionResponse'].includes(key))
        || [part.text, part.functionCall, part.functionResponse].filter(v => v !== undefined).length !== 1) invalid();
      if (part.text !== undefined) texts.push(part.text);
      if (part.functionCall) {
        const call = part.functionCall;
        if (content.role !== 'model' || !identifier.safeParse(call.id).success
          || !identifier.safeParse(call.name).success || seen.has(call.id!)) invalid();
        seen.add(call.id!); pending.set(call.id!, call.name!);
        calls.push({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } });
      }
      if (part.functionResponse) {
        const result = part.functionResponse;
        if (content.role !== 'user' || !result.id || !result.name || pending.get(result.id) !== result.name) invalid();
        pending.delete(result.id!);
        results.push({ role: 'tool', tool_call_id: result.id, content: JSON.stringify(result.response ?? {}) });
      }
    }
    if (results.length) {
      if (texts.length || calls.length) invalid();
      messages.push(...results);
    } else {
      if (!texts.length && !calls.length) invalid();
      messages.push({ role: content.role === 'model' ? 'assistant' : 'user', content: texts.join('\n') || null,
        ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  if (pending.size) invalid();
  const names = Object.keys(input.toolsDict).filter(name => !input.allowedTools || input.allowedTools.includes(name) || name === FINAL_RESPONSE_TOOL);
  const tools = names.map(name => {
    if ((!Object.hasOwn(agentToolParameters, name) && name !== FINAL_RESPONSE_TOOL) || !isFunctionTool(input.toolsDict[name])) invalid();
    return { type: 'function', function: { name, description: input.toolsDict[name]!.description,
      parameters: z.toJSONSchema(name === FINAL_RESPONSE_TOOL ? answerPlanSchema : agentToolParameters[name as keyof typeof agentToolParameters]) } };
  });
  return { messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) };
}

export function chatCompletionResponse(value: unknown): LlmResponse {
  const parsed = z.object({ error: z.unknown().optional(), choices: z.array(z.object({ error: z.unknown().optional(),
    finish_reason: z.enum(['stop', 'tool_calls']), message: z.object({ role: z.literal('assistant'),
      content: z.string().nullable(), refusal: z.string().nullable().optional(),
      tool_calls: z.array(z.object({ id: identifier, type: z.literal('function'),
        function: z.object({ name: identifier, arguments: z.string().max(32_000) }) })).max(6).optional(),
    }) })).length(1) }).safeParse(value);
  if (!parsed.success || parsed.data.error) return invalid();
  const choice = parsed.data.choices[0]!;
  if (choice.error || choice.message.refusal) invalid();
  const calls = choice.message.tool_calls ?? [];
  if ((choice.finish_reason === 'tool_calls') !== (calls.length > 0)
    || new Set(calls.map(call => call.id)).size !== calls.length) invalid();
  const parts: NonNullable<NonNullable<LlmResponse['content']>['parts']> = [];
  if (choice.message.content?.trim()) parts.push({ text: choice.message.content });
  for (const call of calls) {
    let args: unknown;
    try { args = JSON.parse(call.function.arguments); } catch { invalid(); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) invalid();
    parts.push({ functionCall: { id: call.id, name: call.function.name, args: args as Record<string, unknown> } });
  }
  if (!parts.length) invalid();
  return { content: { role: 'model', parts } };
}
