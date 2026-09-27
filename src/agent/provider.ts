import { Gemini, type GeminiParams, type LlmRequest, type LlmResponse } from '@google/adk';
import { randomUUID } from 'node:crypto';

import { GEMINI_MODEL } from './model-id.ts';
export { GEMINI_MODEL } from './model-id.ts';
import { AgentProviderError } from './provider-errors.ts';
export { PROVIDER_ERROR_CODES, AgentProviderError, type ProviderErrorCode } from './provider-errors.ts';
export type ProviderUsage = Readonly<{
  promptTokens: number; outputTokens: number; totalTokens: number;
  cachedTokens?: number; thoughtTokens?: number;
}>;
export type GeminiProviderOptions = {
  apiKey: string;
  /** Absolute epoch milliseconds, shared with the owning invocation. */
  deadlineMs: number;
  /** Await durable acknowledgement before any transport. */
  onCallStart?: (callId: string) => void | Promise<void>;
  /** Await durable accounting before yielding; null means unknown, never zero. */
  onUsage: (usage: ProviderUsage | null, callId: string) => void | Promise<void>;
};

async function accounting(callback: () => void | Promise<void>, deadlineMs: number, signal?: AbortSignal): Promise<void> {
  const remaining = Math.floor(deadlineMs - Date.now());
  if (remaining <= 0 || signal?.aborted) throw new AgentProviderError('AGENT_PROVIDER_TIMEOUT');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    const stopped = new Promise<never>((_, reject) => {
      aborted = () => reject(new AgentProviderError('AGENT_PROVIDER_TIMEOUT'));
      timer = setTimeout(aborted, remaining);
      signal?.addEventListener('abort', aborted, { once: true });
    });
    await Promise.race([callback(), stopped]);
    if (Date.now() >= deadlineMs || signal?.aborted) throw new AgentProviderError('AGENT_PROVIDER_TIMEOUT');
  } catch (error) { throw classify(error, signal?.aborted ?? false); }
  finally {
    if (timer) clearTimeout(timer);
    if (aborted) signal?.removeEventListener('abort', aborted);
  }
}

function usageOf(value: LlmResponse['usageMetadata']): ProviderUsage | null {
  if (!value) return null;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000;
  const { promptTokenCount: promptTokens, candidatesTokenCount: outputTokens, totalTokenCount: totalTokens,
    cachedContentTokenCount: cachedTokens, thoughtsTokenCount: thoughtTokens, toolUsePromptTokenCount: toolTokens } = value;
  if (!valid(promptTokens) || !valid(outputTokens) || !valid(totalTokens)
    || (cachedTokens !== undefined && (!valid(cachedTokens) || cachedTokens > promptTokens))
    || (thoughtTokens !== undefined && !valid(thoughtTokens))
    || (toolTokens !== undefined && !valid(toolTokens))) return null;
  // Installed genai 2.23 metadata defines total as prompt + candidates +
  // tool-use prompt + thoughts. Cached tokens are already part of prompt.
  if (totalTokens < promptTokens + outputTokens + (thoughtTokens ?? 0) + (toolTokens ?? 0)) return null;
  return Object.freeze({ promptTokens, outputTokens, totalTokens,
    ...(cachedTokens === undefined ? {} : { cachedTokens }), ...(thoughtTokens === undefined ? {} : { thoughtTokens }) });
}

const refusal = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'MODEL_ARMOR']);
function classify(error: unknown, aborted: boolean): AgentProviderError {
  if (error instanceof AgentProviderError) return error;
  const value = error && typeof error === 'object' ? error as {
    status?: unknown; code?: unknown; name?: unknown; message?: unknown; cause?: unknown;
  } : {};
  if (aborted || value.name === 'AbortError' || value.name === 'TimeoutError' || value.status === 408 || value.status === 504) return new AgentProviderError('AGENT_PROVIDER_TIMEOUT');
  if (value.status === 429 || value.code === 429) return new AgentProviderError('AGENT_PROVIDER_RATE_LIMIT');
  // GenAI 2.23 ApiError retains numeric HTTP status and a JSON body in message.
  // Inspect only bounded, exact ErrorInfo reasons. Never copy messages, metadata,
  // request URLs, arbitrary reason strings, or the original cause into the error.
  if (value.name === 'ApiError' && typeof value.status === 'number' && [400, 401, 403].includes(value.status)
    && typeof value.message === 'string' && value.message.length <= 32_768) {
    try {
      const body = JSON.parse(value.message);
      const details: unknown[] = Array.isArray(body?.error?.details) ? body.error.details.slice(0, 20) : [];
      for (const detail of details) {
        if (!detail || typeof detail !== 'object') continue;
        const info = detail as Record<string, unknown>;
        if (info['@type'] !== 'type.googleapis.com/google.rpc.ErrorInfo') continue;
        if (info.reason === 'API_KEY_INVALID' || info.reason === 'API_KEY_EXPIRED') return new AgentProviderError('AGENT_PROVIDER_AUTH');
      }
    } catch { /* Non-JSON or unexpected shape: numeric status remains enough. */ }
  }
  if (value.status === 400) return new AgentProviderError('AGENT_PROVIDER_BAD_REQUEST');
  if (value.status === 401) return new AgentProviderError('AGENT_PROVIDER_AUTH');
  if (value.status === 402) return new AgentProviderError('AGENT_PROVIDER_BILLING');
  if (value.status === 403) return new AgentProviderError('AGENT_PROVIDER_PERMISSION');
  if (value.status === 404) return new AgentProviderError('AGENT_PROVIDER_NOT_FOUND');
  if (typeof value.status === 'number' && value.status >= 500 && value.status <= 599) return new AgentProviderError('AGENT_PROVIDER_UNAVAILABLE');
  // Node fetch errors may keep transport codes in cause. Bounded depth also
  // handles cyclic causes; unknown codes never leave this function.
  let current: unknown = value;
  for (let i = 0; i < 3 && current && typeof current === 'object'; i++) {
    const item = current as { code?: unknown; cause?: unknown };
    const code = typeof item.code === 'string' ? item.code : '';
    if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) {
      return new AgentProviderError('AGENT_PROVIDER_TLS');
    }
    if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) {
      return new AgentProviderError('AGENT_PROVIDER_TIMEOUT');
    }
    if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code)) {
      return new AgentProviderError('AGENT_PROVIDER_NETWORK');
    }
    current = item.cause;
  }
  return new AgentProviderError('AGENT_PROVIDER_ERROR');
}

/** The SDK still owns Gemini request/response conversion. No model/tool loop here. */
class BoundedGemini extends Gemini {
  private readonly options: GeminiProviderOptions;
  constructor(options: GeminiProviderOptions) {
    const params: GeminiParams = { model: GEMINI_MODEL, apiKey: options.apiKey,
      vertexai: false, useInteractionsApi: false,
      // ADK 2.1 can override false through its enterprise flag. Explicit inert
      // values prevent fallback project/location lookup; reject that backend.
      project: 'disabled', location: 'disabled',
    };
    super(params);
    this.options = options;
    if (this.vertexai || this.useInteractionsApi) throw new AgentProviderError('AGENT_PROVIDER_CONFIG');
  }

  override get apiClient(): Gemini['apiClient'] {
    const client = super.apiClient;
    if (client.vertexai) throw new AgentProviderError('AGENT_PROVIDER_CONFIG');
    return client;
  }

  protected override getHttpOptions() {
    // Explicit HttpOptions outrank SDK global and environment base URLs.
    // Pin at client construction, not just in per-request configuration.
    return { ...super.getHttpOptions(), baseUrl: 'https://generativelanguage.googleapis.com', apiVersion: 'v1beta' };
  }

  override async connect(): Promise<never> { throw new AgentProviderError('AGENT_PROVIDER_CONFIG'); }

  override async *generateContentAsync(input: LlmRequest, stream = false, abortSignal?: AbortSignal): AsyncGenerator<LlmResponse, void> {
    void stream; // Accounting requires the final unary response, even for streaming callers.
    let usage: ProviderUsage | null = null;
    let response: LlmResponse | undefined;
    let failure: AgentProviderError | undefined;
    const callId = randomUUID();
    let started = false;
    const deadline = new AbortController();
    const signal = AbortSignal.any([deadline.signal, ...(abortSignal ? [abortSignal] : []),
      ...(input.config?.abortSignal ? [input.config.abortSignal] : [])]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (this.options.deadlineMs <= Date.now() || signal.aborted) throw new AgentProviderError('AGENT_PROVIDER_TIMEOUT');
      // The SDK mutates its input. Keep the caller's request intact and never
      // allow per-request model, transport, retry or endpoint overrides.
      const config = { ...input.config };
      delete config.abortSignal;
      delete config.httpOptions;
      const safe: LlmRequest = { ...input, model: GEMINI_MODEL,
        contents: structuredClone(input.contents), config: { ...structuredClone(config), abortSignal: signal },
      };
      if (this.options.onCallStart) await accounting(() => this.options.onCallStart!(callId), this.options.deadlineMs, signal);
      started = true;
      const timeout = Math.min(30_000, Math.floor(this.options.deadlineMs - Date.now()));
      if (timeout <= 0 || signal.aborted) throw new AgentProviderError('AGENT_PROVIDER_TIMEOUT');
      safe.config!.httpOptions = { timeout, retryOptions: { attempts: 1 } };
      timer = setTimeout(() => deadline.abort(), timeout);
      // Use one unary SDK response even when ADK asks for streaming: usage is
      // captured before handing output to a guard that may reject/stop iteration.
      const iterator = super.generateContentAsync(safe, false, signal);
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new AgentProviderError('AGENT_PROVIDER_TIMEOUT'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      const result = await Promise.race([iterator.next(), cancelled]);
      response = result.done ? undefined : result.value;
      usage = usageOf(response?.usageMetadata);
      if (signal.aborted) throw new AgentProviderError('AGENT_PROVIDER_TIMEOUT');
      const reason = response?.finishReason ?? response?.errorCode;
      if (reason && refusal.has(reason)) throw new AgentProviderError('AGENT_PROVIDER_REFUSAL');
      if (!response || response.errorCode || !response.content?.parts?.length
        || (reason !== undefined && reason !== 'STOP')) throw new AgentProviderError('AGENT_PROVIDER_INVALID_RESPONSE');
      // Do not expose raw provider diagnostics or unbounded usage detail fields.
      response = { content: response.content, finishReason: response.finishReason,
        ...(usage ? { usageMetadata: { promptTokenCount: usage.promptTokens, candidatesTokenCount: usage.outputTokens,
          totalTokenCount: usage.totalTokens, cachedContentTokenCount: usage.cachedTokens, thoughtsTokenCount: usage.thoughtTokens } } : {}) };
    } catch (error) { failure = classify(error, signal.aborted); }
    finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    // Caller cancellation must not skip accounting for a dispatched call.
    // The shared invocation deadline still bounds this final durable callback.
    if (started) await accounting(() => this.options.onUsage(usage, callId), this.options.deadlineMs);
    if (failure) throw failure;
    if (!response) throw new AgentProviderError('AGENT_PROVIDER_INVALID_RESPONSE');
    yield response;
  }
}

export function createGeminiProvider(options: GeminiProviderOptions): Gemini {
  if (!options || typeof options.apiKey !== 'string' || !options.apiKey.trim()
    || !Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0 || typeof options.onUsage !== 'function'
    || (options.onCallStart !== undefined && typeof options.onCallStart !== 'function')) {
    throw new AgentProviderError('AGENT_PROVIDER_CONFIG');
  }
  try { return new BoundedGemini({ ...options }); }
  catch { throw new AgentProviderError('AGENT_PROVIDER_CONFIG'); }
}
