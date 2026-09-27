import { BaseLlm, type LlmRequest, type LlmResponse } from '@google/adk';
import { randomUUID } from 'node:crypto';
import { AgentProviderError, type ProviderErrorCode } from './provider-errors.ts';
import { error, bounded, bodyOf, RestBodyError } from './bounded-json-transport.ts';
import { providerDiagnosticErrorCode, restProviderFailure, type RestProvider, type RestFailureStage } from './provider-diagnostic.ts';

export type UnaryRestOptions<E> = {
  provider: RestProvider; apiKey: string; model: string; endpoint: string; deadlineMs: number;
  onCallStart(callId: string): Promise<void> | void;
  onEvidence(evidence: E, callId: string): Promise<void> | void;
  request(input: LlmRequest): unknown;
  evidence(raw: unknown): E;
  validateEvidence(evidence: E): void;
  response(raw: unknown): LlmResponse;
};

/** Unary model transport only; ADK/GuardedModel retain tools, confirmation and AG-UI. */
export class UnaryRestModel<E> extends BaseLlm {
  private readonly options: UnaryRestOptions<E>;
  constructor(options: UnaryRestOptions<E>) { super({ model: options.model }); this.options = options; }
  async connect(): Promise<never> { throw error('AGENT_PROVIDER_CONFIG'); }
  async *generateContentAsync(input: LlmRequest, _stream = false, abortSignal?: AbortSignal): AsyncGenerator<LlmResponse, void> {
    void _stream;
    const remaining = Math.min(30_000, this.options.deadlineMs - Date.now());
    if (remaining <= 0) throw error('AGENT_PROVIDER_TIMEOUT');
    const signal = AbortSignal.any([AbortSignal.timeout(remaining), ...(abortSignal ? [abortSignal] : []),
      ...(input.config?.abortSignal ? [input.config.abortSignal] : [])]);
    const callId = randomUUID();
    let started = false;
    let evidence = this.options.evidence(null);
    let result: LlmResponse | undefined;
    let failure: AgentProviderError | undefined;
    let stage: RestFailureStage = 'request';
    try {
      const body = JSON.stringify(this.options.request(input));
      if (Buffer.byteLength(body) > 96_000) throw error('AGENT_PROVIDER_BAD_REQUEST');
      stage = 'call-start';
      await bounded(() => this.options.onCallStart(callId), signal);
      if (signal.aborted) throw error('AGENT_PROVIDER_TIMEOUT');
      started = true;
      stage = 'fetch';
      const response = await bounded(() => fetch(this.options.endpoint, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' }, body }), signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        const codes: Record<number, ProviderErrorCode> = { 400: 'AGENT_PROVIDER_BAD_REQUEST', 401: 'AGENT_PROVIDER_AUTH',
          402: 'AGENT_PROVIDER_BILLING', 403: 'AGENT_PROVIDER_PERMISSION', 404: 'AGENT_PROVIDER_NOT_FOUND',
          408: 'AGENT_PROVIDER_TIMEOUT', 429: 'AGENT_PROVIDER_RATE_LIMIT', 504: 'AGENT_PROVIDER_TIMEOUT' };
        const code = codes[response.status] ?? (response.status >= 500 ? 'AGENT_PROVIDER_UNAVAILABLE' : 'AGENT_PROVIDER_ERROR');
        throw code === 'AGENT_PROVIDER_ERROR'
          ? restProviderFailure(this.options.provider, { stage: 'http', httpStatus: response.status }) : error(code);
      }
      stage = 'body-read';
      const raw = await bodyOf(response, signal);
      stage = 'evidence';
      evidence = this.options.evidence(raw);
      this.options.validateEvidence(evidence);
      stage = 'response';
      result = this.options.response(raw);
    } catch (cause) {
      // Keep known provider codes and select timeout precedence at one boundary.
      // Unexpected callback/transport errors never retain their message or cause.
      failure = cause instanceof AgentProviderError
        ? cause.code === 'AGENT_PROVIDER_ERROR' && providerDiagnosticErrorCode(cause.message) !== 'AGENT_PROVIDER_ERROR'
          ? restProviderFailure(this.options.provider, { stage }) : cause
        : signal.aborted ? error('AGENT_PROVIDER_TIMEOUT')
          : restProviderFailure(this.options.provider, { stage: cause instanceof RestBodyError ? cause.stage : stage });
    }
    if (started) {
      const remainingSave = this.options.deadlineMs - Date.now();
      if (remainingSave <= 0) throw error('AGENT_PROVIDER_TIMEOUT');
      // Caller cancellation cannot discard evidence for an already dispatched call.
      try { await bounded(() => this.options.onEvidence(evidence, callId), AbortSignal.timeout(remainingSave)); }
      catch { throw restProviderFailure(this.options.provider, { stage: 'evidence-save' }); }
    }
    if (failure) throw failure;
    if (signal.aborted) throw error('AGENT_PROVIDER_TIMEOUT');
    if (!result) throw error('AGENT_PROVIDER_INVALID_RESPONSE');
    yield result;
  }
}
