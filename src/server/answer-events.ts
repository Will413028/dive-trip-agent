import { EventType } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { z } from 'zod';
import { parsePublicAgentEvent } from '../agent/public-events';
import { acceptedAnswerSchema, ANSWER_EVENT_NAME } from '../domain/answer';
import { DomainError } from '../domain/errors';
import { publicAgentErrorCode } from './agent-error';

const id = z.string().min(1).max(128).refine(value => value.trim().length > 0 && !value.includes('\0'));
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
const startedSchema = z.strictObject({ type: z.literal(EventType.RUN_STARTED), threadId: z.uuid(), runId: z.uuid(), timestamp });
const finishedSchema = z.strictObject({ type: z.literal(EventType.RUN_FINISHED), threadId: z.uuid(), runId: z.uuid(), timestamp,
  outcome: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('success') }),
    z.strictObject({ type: z.literal('cancelled') }),
    z.strictObject({ type: z.literal('interrupt'), interrupts: z.array(z.strictObject({ id, reason: z.literal('approval'),
      message: z.literal('DEMO：請檢查差異後接受或拒絕修改。').optional() })).length(1) }),
  ]).optional(),
});
const errorSchema = z.strictObject({ type: z.literal(EventType.RUN_ERROR), code: id.optional(), message: z.string(), timestamp });
const invalid = (): never => { throw new DomainError('INVALID_RUN_EVENT'); };

export function runErrorEvent(code?: string) {
  const safeCode = code === 'STALE_VERSION' ? code : publicAgentErrorCode(new Error(code));
  return { type: EventType.RUN_ERROR as const, code: safeCode,
    message: safeCode === 'STALE_VERSION' ? '行程已更新，請重新整理後重新提案。' : '執行未完整完成，請重新讀取行程確認已保存結果。' };
}

/** Lifecycle events are server-owned and never accepted from worker hooks. */
export function parseStoredRunEvent(raw: unknown, runId: string) {
  try {
    const type = z.object({ type: z.string() }).parse(raw).type;
    if (type === EventType.RUN_STARTED) return startedSchema.parse(raw);
    if (type === EventType.RUN_FINISHED) return finishedSchema.parse(raw);
    if (type === EventType.RUN_ERROR) {
      const parsed = errorSchema.parse(raw);
      // Error.message/cause/stack is not persisted, even for trusted callers.
      return runErrorEvent(parsed.code);
    }
    // Validate before generic AG-UI parsing (which can strip extra fields), and
    // validate the JSON representation that will actually enter persistence.
    const parsed = parsePublicAgentEvent(raw, runId);
    const event = EventSchemas.parse(parsePublicAgentEvent(JSON.parse(JSON.stringify(parsed)), runId));
    if (event.type === EventType.CUSTOM) return { type: EventType.CUSTOM as const,
      name: ANSWER_EVENT_NAME, value: acceptedAnswerSchema.parse(event.value) };
    // The shared parser excludes lifecycle and all other AG-UI event types.
    if (event.type !== EventType.TOOL_CALL_START && event.type !== EventType.TOOL_CALL_END
      && event.type !== EventType.TOOL_CALL_RESULT) return invalid();
    return event;
  } catch { return invalid(); }
}
