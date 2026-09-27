import { AgentProviderError, type ProviderErrorCode } from './provider-errors.ts';
export const error = (code: ProviderErrorCode) => new AgentProviderError(code);

/** Safe transport-local location. The provider boundary still owns public-code
 * selection and timeout precedence; no raw exception is retained as a cause. */
export class RestBodyError extends Error {
  readonly stage: 'body-read' | 'body-json';
  constructor(stage: 'body-read' | 'body-json') { super('REST_BODY_FAILURE'); this.name = 'RestBodyError'; this.stage = stage; }
}
export async function bounded<T>(work: () => Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw error('AGENT_PROVIDER_TIMEOUT');
  let abort: () => void = () => {};
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
      abort = () => reject(error('AGENT_PROVIDER_TIMEOUT'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
export async function bodyOf(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw error('AGENT_PROVIDER_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let stage: 'body-read' | 'body-json' = 'body-read';
  try {
    while (true) {
      const item = await bounded(() => reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 65_536) throw error('AGENT_PROVIDER_INVALID_RESPONSE');
      chunks.push(item.value);
    }
    stage = 'body-json';
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (cause) {
    if (cause instanceof AgentProviderError) throw cause;
    throw new RestBodyError(stage);
  } finally { void reader.cancel().catch(() => undefined); }
}
