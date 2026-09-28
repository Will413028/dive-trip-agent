import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { z } from 'zod';

const identity = z.string().regex(/^[a-f0-9]{32}$/);
const messageSchema = z.union([
  z.strictObject({ kind: z.literal('credential-request'), id: identity, commandId: identity }),
  z.strictObject({ kind: z.literal('result'), id: identity, ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ kind: z.literal('result'), id: identity, ok: z.literal(false),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/) }),
]);
type Operation = 'setup' | 'request' | 'audit' | 'capture' | 'finish';
type Pending = {
  id: string; generation: boolean; credentialRequested: boolean; canceled: boolean;
  resolve(value: unknown): void; reject(error: Error): void; cleanup(): void;
};

/** Private inherited duplex only. No listener, URL, environment credential or
 * generic worker flag can create a generation capability. The reviewed outer
 * controller supplies its existing gated credential loader. */
export class PythonEvaluationChannel {
  private pending?: Pending;
  private bytes = Buffer.alloc(0);
  private closed = false;
  private readonly stream: Duplex;
  private readonly loadCredential: () => Promise<string>;
  constructor(stream: Duplex, loadCredential: () => Promise<string>) {
    this.stream = stream;
    this.loadCredential = loadCredential;
    stream.on('data', (chunk: Buffer) => this.receive(chunk));
    stream.on('error', () => this.fail('EVAL_PYTHON_CHANNEL_FAILED'));
    stream.on('close', () => this.fail('EVAL_PYTHON_CHANNEL_CLOSED'));
    stream.on('end', () => this.fail('EVAL_PYTHON_CHANNEL_CLOSED'));
  }

  private fail(code: string) {
    this.closed = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.cleanup();
    pending?.reject(new Error(code));
    this.stream.destroy();
  }

  private write(value: unknown) {
    if (this.closed) throw new Error('EVAL_PYTHON_CHANNEL_CLOSED');
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length > 1_048_576) throw new Error('EVAL_PYTHON_INPUT_TOO_LARGE');
    this.stream.write(bytes, error => { if (error) this.fail('EVAL_PYTHON_CHANNEL_FAILED'); });
  }

  private receive(chunk: Buffer) {
    try {
      this.bytes = Buffer.concat([this.bytes, chunk]);
      for (;;) {
        const end = this.bytes.indexOf(10);
        if (end === -1) break;
        if (end > 8_388_608) throw new Error();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(0, end));
        this.bytes = this.bytes.subarray(end + 1);
        const message = messageSchema.parse(JSON.parse(text));
        const pending = this.pending;
        if (!pending) throw new Error();
        if (message.kind === 'credential-request') {
          if (message.commandId !== pending.id || !pending.generation
            || pending.credentialRequested || pending.canceled) throw new Error();
          pending.credentialRequested = true;
          void this.provideCredential(message.id, pending);
        } else {
          if (message.id !== pending.id) throw new Error();
          this.pending = undefined;
          pending.cleanup();
          if (pending.canceled) pending.reject(new Error('EVAL_PYTHON_ABORTED'));
          else if (message.ok) pending.resolve(message.value);
          else pending.reject(new Error(`EVAL_PYTHON_${message.code}`));
        }
      }
      if (this.bytes.length > 8_388_608) throw new Error();
    } catch { this.fail('EVAL_PYTHON_PROTOCOL_INVALID'); }
  }

  private async provideCredential(id: string, pending: Pending) {
    try {
      const value = await this.loadCredential();
      // A canceled phase cannot acquire a late generation capability.
      if (this.closed || this.pending !== pending || pending.canceled) return;
      if (!value || value.length > 8192) throw new Error();
      this.write({ kind: 'credential', id, value });
    } catch { this.fail('EVAL_PYTHON_CREDENTIAL_FAILED'); }
  }

  call(operation: Operation, input: Record<string, unknown>,
    { signal, generation = false }: { signal?: AbortSignal; generation?: boolean } = {}): Promise<unknown> {
    if (this.closed || this.pending) return Promise.reject(new Error('EVAL_PYTHON_CHANNEL_UNAVAILABLE'));
    if (generation && operation !== 'request') return Promise.reject(new Error('EVAL_PYTHON_CREDENTIAL_PHASE'));
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = randomBytes(16).toString('hex');
      const cancel = () => {
        if (this.pending?.id !== id || this.pending.canceled) return;
        this.pending.canceled = true;
        try { this.write({ kind: 'cancel', id }); }
        catch { this.fail('EVAL_PYTHON_CHANNEL_FAILED'); }
      };
      const deadline = setTimeout(cancel, 65_000);
      const drainDeadline = setTimeout(() => this.fail('EVAL_PYTHON_DRAIN_UNVERIFIED'), 115_000);
      this.pending = { id, generation, credentialRequested: false, canceled: false, resolve, reject,
        cleanup: () => { clearTimeout(deadline); clearTimeout(drainDeadline); signal?.removeEventListener('abort', cancel); } };
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.write({ kind: 'command', id, operation, input }); }
      catch { this.fail('EVAL_PYTHON_CHANNEL_FAILED'); }
    });
  }

  close() { this.fail('EVAL_PYTHON_CHANNEL_CLOSED'); }
}
