import { EventType, type BaseEvent } from '@ag-ui/core';
import { z } from 'zod';
import { acceptedAnswerSchema, ANSWER_EVENT_NAME } from '../domain/answer.ts';

export const publicToolNameSchema = z.enum(['find_destinations', 'find_items', 'calculate_budget', 'validate_changes', 'propose_changes']);
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const publicEventSchema = z.union([
  z.strictObject({ type: z.literal(EventType.CUSTOM), name: z.literal(ANSWER_EVENT_NAME), value: acceptedAnswerSchema }),
  z.strictObject({ type: z.literal(EventType.TOOL_CALL_START), toolCallId: id, toolCallName: publicToolNameSchema }),
  z.strictObject({ type: z.literal(EventType.TOOL_CALL_END), toolCallId: id }),
  // Progress only. The server compiler owns all facts; private tool payloads
  // and model prose never cross IPC, SSE, refresh or replay as an alternate UI.
  z.strictObject({ type: z.literal(EventType.TOOL_CALL_RESULT), messageId: id, toolCallId: id,
    role: z.literal('tool'), content: z.literal('{}') }),
]);
export function parsePublicAgentEvent(raw: unknown, runId: string): BaseEvent {
  const event = publicEventSchema.parse(raw);
  if (event.type === EventType.CUSTOM && event.value.runId !== runId) throw new Error('AGENT_ANSWER_RUN_CONFLICT');
  return event;
}
