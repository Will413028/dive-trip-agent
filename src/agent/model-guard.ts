import { randomUUID } from 'node:crypto';
import { BaseLlm, isFunctionTool, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import type { z } from 'zod';
import { agentToolParameters } from './tool-schemas.ts';
import { toolArgumentDiagnostic } from './tool-diagnostic.ts';
import { answerPlanSchema } from '../domain/answer.ts';

export const MODEL_LIMITS = Object.freeze({ modelCalls: 7, toolCalls: 6,
  inputBytes: 96_000, outputBytes: 32_000, outputTokens: 2048, deadlineMs: 50_000 });
const allowed = new Set(['find_destinations', 'find_items', 'calculate_budget', 'validate_changes', 'propose_changes']);
export const FINAL_RESPONSE_TOOL = 'set_model_response';
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
type Counts = { modelCalls: number; toolCalls: number; callIds?: string[]; proposed?: boolean };

/** Policy around ADK's model interface, NOT a replacement model/tool loop.
 * Validate a whole non-streamed candidate before ADK can execute any tool.
 * Final outputs are strict plans. The compiler alone creates public answers.
 */
export class GuardedModel extends BaseLlm {
  private readonly source: BaseLlm;
  private readonly counts: Counts;
  private readonly deadline = AbortSignal.timeout(MODEL_LIMITS.deadlineMs);
  private readonly callIds = new Set<string>();
  private proposed = false;
  private readonly outputSchema: z.ZodType;
  private answered = false;
  constructor(source: BaseLlm, previous: Counts = { modelCalls: 0, toolCalls: 0 }, outputSchema: z.ZodType = answerPlanSchema) {
    super({ model: source.model });
    if ([previous.modelCalls, previous.toolCalls].some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('AGENT_MODEL_LIMIT');
    this.source = source; this.counts = { ...previous }; this.outputSchema = outputSchema;
    for (const id of previous.callIds ?? []) this.callIds.add(id);
    this.proposed = previous.proposed ?? false;
  }
  /** Detached observation of the policy's counters; callers cannot reset them. */
  get callCounts(): Readonly<{ modelCalls: number; toolCalls: number }> {
    return { modelCalls: this.counts.modelCalls, toolCalls: this.counts.toolCalls };
  }
  async *generateContentAsync(request: LlmRequest, _stream = false, signal?: AbortSignal): AsyncGenerator<LlmResponse> {
    void _stream; // unary candidates are validated atomically before ADK sees them
    const combined = AbortSignal.any([this.deadline, ...(signal ? [signal] : [])]);
    const abortError = () => new Error(this.deadline.aborted ? 'AGENT_TIMEOUT' : 'AGENT_ABORTED');
    if (combined.aborted) throw abortError();
    if (this.answered) throw new Error('AGENT_ANSWER_ALREADY_COMPLETED');
    if (this.counts.modelCalls >= MODEL_LIMITS.modelCalls) throw new Error('AGENT_MODEL_LIMIT');
    request.config = { ...request.config, maxOutputTokens: MODEL_LIMITS.outputTokens, candidateCount: 1,
      thinkingConfig: { includeThoughts: false } };
    if (bytes({ contents: request.contents, config: request.config }) > MODEL_LIMITS.inputBytes) throw new Error('AGENT_CONTEXT_LIMIT');
    this.counts.modelCalls++;
    const iterator = this.source.generateContentAsync(request, false, combined);
    const next = async () => {
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError());
        combined.addEventListener('abort', onAbort, { once: true });
        if (combined.aborted) onAbort();
      });
      try { return await Promise.race([iterator.next(), aborted]); }
      finally { combined.removeEventListener('abort', onAbort); }
    };
    try {
      const first = await next();
      if (first.done) throw new Error('AGENT_MODEL_RESPONSE');
      this.validate(first.value, request);
      // No partial candidate may escape before a later error / malformed tail.
      if (!(await next()).done) throw new Error('AGENT_MODEL_RESPONSE');
      if (combined.aborted) throw abortError();
      yield first.value;
    } finally {
      // An uncooperative adapter cannot hold the invocation beyond its deadline.
      void iterator.return().catch(() => undefined);
    }
  }
  private validate(response: LlmResponse, request: LlmRequest): void {
    if (bytes(response) > MODEL_LIMITS.outputBytes) throw new Error('AGENT_OUTPUT_LIMIT');
    if (response.errorCode || response.interrupted || response.partial) throw new Error('AGENT_MODEL_RESPONSE');
    if (response.finishReason && response.finishReason !== 'STOP') {
      throw new Error(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION'].includes(response.finishReason)
        ? 'AGENT_MODEL_REFUSED' : 'AGENT_MODEL_RESPONSE');
    }
    const parts = response.content?.parts ?? [];
    // ADK outputKey joins text including thought parts. Reject these before it
    // can persist a value different from the exact structured value we checked.
    if (parts.some(part => part.thought)) throw new Error('AGENT_ANSWER_SCHEMA');
    if (response.content?.role && response.content.role !== 'model') throw new Error('AGENT_MODEL_RESPONSE');
    const calls = parts.flatMap(part => part.functionCall ? [part.functionCall] : []);
    if (!parts.some(part => !part.thought && (part.text?.trim() || part.functionCall))) throw new Error('AGENT_MODEL_RESPONSE');
    if (parts.some(part => part.functionResponse || part.inlineData || part.fileData || part.executableCode || part.codeExecutionResult
      || (part.thought && part.functionCall))) throw new Error('AGENT_MODEL_RESPONSE');
    if (this.counts.toolCalls + calls.length > MODEL_LIMITS.toolCalls) throw new Error('AGENT_TOOL_LIMIT');
    const finalCalls = calls.filter(call => call.name === FINAL_RESPONSE_TOOL);
    if (finalCalls.length && (calls.length !== 1
      || parts.some(part => !part.thought && part.text?.trim()))) throw new Error('AGENT_ANSWER_SCHEMA');
    if (calls.length === 0) {
      // Native schema-capable models may return JSON text instead of the tool.
      // Do not accept prose, fenced JSON, multiple text fragments or extra keys.
      const visible = parts.filter(part => !part.thought);
      let value: unknown;
      try { value = visible.length === 1 && visible[0].text ? JSON.parse(visible[0].text) : undefined; }
      catch { throw new Error('AGENT_ANSWER_SCHEMA'); }
      if (!this.outputSchema.safeParse(value).success) throw new Error('AGENT_ANSWER_SCHEMA');
    }
    const proposals = calls.filter(call => call.name === 'propose_changes');
    if (proposals.length && (this.proposed || calls.length !== 1)) throw new Error('AGENT_PROPOSAL_LIMIT');
    // Confirmation receipts are deterministic native tool results. They need
    // neither a further model call nor a reserved final-response tool slot.
    for (const call of calls) {
      const final = call.name === FINAL_RESPONSE_TOOL;
      if (!call.name || (!allowed.has(call.name) && !final)) throw new Error('AGENT_TOOL_NOT_ALLOWED');
      // Gemini may omit IDs; establish one before ADK persists/projects it.
      call.id ??= randomUUID();
      if (!call.id || call.id.length > 128 || this.callIds.has(call.id)) throw new Error('AGENT_MODEL_RESPONSE');
      this.callIds.add(call.id);
      const tool = request.toolsDict[call.name];
      if (!tool || !isFunctionTool(tool)) throw new Error('AGENT_TOOL_NOT_ALLOWED');
      // ADK converts this call to JSON text before FunctionTool.runAsync, so
      // neither the tool's schema nor beforeToolCallback can enforce this gate.
      if (final) {
        if (!this.outputSchema.safeParse(call.args).success) throw new Error('AGENT_ANSWER_SCHEMA');
        continue;
      }
      const schema = agentToolParameters[call.name as keyof typeof agentToolParameters];
      const parsed = schema.safeParse(call.args);
      if (!parsed.success) throw new Error(toolArgumentDiagnostic(call.name, parsed.error.issues));
    }
    this.counts.toolCalls += calls.length;
    this.proposed ||= proposals.length > 0;
    this.answered = finalCalls.length > 0 || calls.length === 0;
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('AGENT_LIVE_STREAM_DISABLED'); }
}
