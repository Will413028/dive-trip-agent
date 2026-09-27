/** Offline-only bootstrap. Runtime forks this fixed path with one enum argument.
 * No native fetch reference is retained: every attempted model request is local.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseSnapshotStructure } from '../../src/domain/snapshot.ts';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire.ts';
import { answerPlanSchema, evidenceIdSchema, type AnswerPlan } from '../../src/domain/answer.ts';
import { requirementsEvidence } from '../../src/agent/answer-evidence.ts';
import { FINAL_RESPONSE_TOOL } from '../../src/agent/model-guard.ts';
import { offlineScenarioSchema } from '../../src/agent/offline-scenario.ts';

globalThis.fetch = async () => { throw new Error('AGENT_OFFLINE_TRANSPORT_REJECTED'); };

const scenario = offlineScenarioSchema.parse(process.argv[2]);
const partSchema = z.object({
  functionResponse: z.object({ name: z.string(), response: z.record(z.string(), z.unknown()) }).passthrough().optional(),
}).passthrough();
const bodySchema = z.object({
  contents: z.array(z.object({ parts: z.array(partSchema).optional() }).passthrough()),
  tools: z.array(z.object({ functionDeclarations: z.array(z.object({ name: z.string() }).passthrough()).optional() }).passthrough()).optional(),
}).passthrough();

process.once('message', (start: unknown) => {
  void (async () => {
    const message = z.object({ type: z.literal('start'), input: z.object({ snapshot: z.unknown(),
      ownerId: z.uuid(), tripId: z.uuid(), runId: z.uuid(), baseVersion: z.number().int().positive(),
      input: z.object({ kind: z.literal('start') }).passthrough() }).passthrough(),
      config: z.object({ provider: z.strictObject({ kind: z.enum(['gemini', 'openrouter', 'cloudflare']), model: z.string().optional(),
        accountId: z.string().optional(), deadlineMs: z.number().int().positive(), previousModelCalls: z.number().int().nonnegative() }),
        generation: z.strictObject({ apiKey: z.literal('offline-placeholder-not-a-credential') }),
        offlineScenario: z.literal(scenario) }).passthrough() }).passthrough().parse(start);
    const snapshot = parseSnapshotStructure(message.input.snapshot);
    const { ownerId, tripId, runId, baseVersion } = message.input;
    const requirementsRef = requirementsEvidence({ ownerId, tripId, runId, baseVersion }, snapshot).id;
    const finalArgs = (answer: AnswerPlan['answer']) => answerPlanSchema.parse({ version: '1', answer });
    // Validation expands this patch against the frozen base. Proposal copies
    // only the returned UUID; persisted domain changes still contain every field.
    const changes = [{ kind: 'requirements', value: { pace: 'relaxed' } }];
    const provider = message.config.provider.kind;
    const model = message.config.provider.model ?? 'gemini-3.1-flash-lite';
    globalThis.fetch = async (resource, init) => {
      const url = new URL(resource instanceof Request ? resource.url : String(resource));
      const headers = new Headers(init?.headers ?? (resource instanceof Request ? resource.headers : undefined));
      const geminiTransport = url.origin === 'https://generativelanguage.googleapis.com'
        && url.pathname === '/v1beta/models/gemini-3.1-flash-lite:generateContent'
        && !url.search && !url.hash && !url.username && !url.password
        && headers.get('x-goog-api-key') === 'offline-placeholder-not-a-credential';
      const openRouterTransport = url.origin === 'https://openrouter.ai'
        && url.pathname === '/api/v1/chat/completions' && !url.search && !url.hash && !url.username && !url.password
        && headers.get('authorization') === 'Bearer offline-placeholder-not-a-credential';
      const cloudflareTransport = url.origin === 'https://api.cloudflare.com'
        && url.pathname === `/client/v4/accounts/${'a'.repeat(32)}/ai/run/${CLOUDFLARE_MODEL}`
        && message.config.provider.accountId === 'a'.repeat(32) && model === CLOUDFLARE_MODEL
        && !url.search && !url.hash && !url.username && !url.password
        && headers.get('authorization') === 'Bearer offline-placeholder-not-a-credential';
      if ((!geminiTransport && provider === 'gemini') || (!openRouterTransport && provider === 'openrouter')
        || (!cloudflareTransport && provider === 'cloudflare')
        || init?.method !== 'POST') {
        throw new Error('AGENT_OFFLINE_TRANSPORT_REJECTED');
      }
      const signal = init?.signal;
      if (signal?.aborted) throw new DOMException('Offline cancellation', 'AbortError');
      if (scenario === 'hang') return new Promise<Response>((_, reject) => {
        if (!signal) { reject(new Error('AGENT_OFFLINE_SIGNAL_REQUIRED')); return; }
        signal.addEventListener('abort', () => reject(new DOMException('Offline cancellation', 'AbortError')), { once: true });
      });
      if (scenario === 'rate-limit') return Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Offline quota scenario' } }, { status: 429 });
      if (typeof init?.body !== 'string' || Buffer.byteLength(init.body, 'utf8') > 128_000) throw new Error('AGENT_OFFLINE_INVALID_BODY');
      // Assert actual worker → ADK → provider wiring, not just the prompt helper.
      const wire = JSON.parse(init.body);
      if (provider === 'cloudflare') z.object({
        stream: z.literal(false), max_completion_tokens: z.literal(2048),
        chat_template_kwargs: z.strictObject({ enable_thinking: z.literal(false) }),
      }).parse(wire);
      if (scenario === 'invalid-json') {
        if (provider === 'gemini') throw new Error('AGENT_OFFLINE_TRANSPORT_REJECTED');
        if (provider === 'openrouter') {
          z.literal('example/synthetic:free').parse(model);
          z.object({ model: z.literal('example/synthetic:free'), stream: z.literal(false), max_tokens: z.literal(2048),
            provider: z.strictObject({ allow_fallbacks: z.literal(false), require_parameters: z.literal(true),
              data_collection: z.literal('deny'), max_price: z.strictObject({ prompt: z.literal(0),
                completion: z.literal(0), request: z.literal(0), image: z.literal(0) }) }),
          }).parse(wire);
        }
        // Fixed REST fault after transport/wire checks; independent of prompt
        // contents and environment. Neither marker may survive diagnostics.
        return new Response('{private_body_marker', { status: 200,
          headers: { 'content-type': 'application/json', 'x-provider-debug': 'private_header_marker' } });
      }
      const userData = provider === 'gemini' ? JSON.stringify(wire.contents?.filter((item: { role?: string }) => item.role === 'user'))
        : JSON.stringify(wire.messages?.filter((item: { role?: string }) => item.role === 'user'));
      const expected = JSON.stringify({ requirementsEvidenceRef: requirementsRef });
      // Verify worker -> native ADK -> provider transport, not a test-only runner.
      if (!userData.includes(JSON.stringify(expected).slice(1, -1))) throw new Error('AGENT_OFFLINE_MISSING_REQUIREMENTS_REF');
      const system = provider === 'gemini' ? JSON.stringify(wire.systemInstruction)
        : String(wire.messages?.find((item: { role?: string }) => item.role === 'system')?.content);
      if (system.includes(expected) || system.includes(JSON.stringify(expected).slice(1, -1))) {
        throw new Error('AGENT_OFFLINE_UNSAFE_REQUIREMENTS_REF');
      }
      if (provider === 'openrouter' || provider === 'cloudflare') {
        const body = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown().nullable().optional() }).passthrough()),
          tools: z.array(z.unknown()).optional() }).passthrough().parse(JSON.parse(init.body));
        const results = body.messages.filter(message => message.role === 'tool').flatMap(message => {
          try { return [JSON.parse(String(message.content)) as Record<string, unknown>]; } catch { return []; }
        });
        let choice: Record<string, unknown>;
        const validation = results.findLast(result => typeof result.canApply === 'boolean');
        const call = (name: string, args: Record<string, unknown>) => {
          if (!body.tools?.some(tool => JSON.stringify(tool).includes(`"name":"${name}"`))) throw new Error('AGENT_OFFLINE_MISSING_TOOL');
          return { finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } };
        };
        const final = (answer: AnswerPlan['answer']) => call(FINAL_RESPONSE_TOOL, finalArgs(answer));
        if (scenario === 'invalid-tool-arguments') {
          choice = { finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'find_items',
              arguments: JSON.stringify({ destinationId: 'private_value_marker', private_key_marker: 'private_value_marker' }) } }] } };
        } else if (provider === 'cloudflare' && scenario === 'proposal' && message.config.lookupTimeout === true) {
          // Existing server-only isolated fault switch, never a live transport.
          if (results.some(result => result.error === 'CATALOG_TIMEOUT')) {
            // Only the saved requirements remain grounded. This is NOT proof
            // that the requested lookup/proposal task succeeded.
            choice = final({ kind: 'requirements', evidenceRef: requirementsRef });
          } else {
            choice = call('find_items', { destinationId: snapshot.requirements.destinationId });
          }
        } else if (scenario !== 'proposal') {
          choice = final({ kind: 'clarify', fields: ['people', 'divers'] });
        } else if (validation && validation.canApply !== true) {
          choice = final({ kind: 'conflict', evidenceRef: evidenceIdSchema.parse(validation.answerEvidenceRef) });
        } else {
          const name = validation ? 'propose_changes' : 'validate_changes';
          const args = validation ? { validationId: z.uuid().parse(validation.validationId) } : { changes };
          choice = call(name, args);
        }
        const result = { id: randomUUID(), model: provider === 'cloudflare' ? `${CLOUDFLARE_MODEL}-external`
          : model.endsWith(':free') ? model.slice(0, -5) : model,
          choices: [choice], usage: scenario === 'missing-usage' ? undefined
            : { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, ...(provider === 'openrouter' ? { cost: 0 } : {}),
              completion_tokens_details: { reasoning_tokens: 2 } } };
        return Response.json(provider === 'cloudflare' ? { success: true, result } : result);
      }
      const body = bodySchema.parse(JSON.parse(init.body));
      const call = (name: string, args: Record<string, unknown>) => {
        if (!body.tools?.some(tool => tool.functionDeclarations?.some(declaration => declaration.name === name))) throw new Error('AGENT_OFFLINE_MISSING_TOOL');
        return [{ functionCall: { id: randomUUID(), name, args } }];
      };
      const final = (answer: AnswerPlan['answer']) => call(FINAL_RESPONSE_TOOL, finalArgs(answer));
      let parts: { functionCall: { id: string; name: string; args: Record<string, unknown> } }[];
      if (scenario === 'invalid-tool-arguments') parts = [{ functionCall: { id: randomUUID(), name: 'find_items',
        args: { destinationId: 'private_value_marker', private_key_marker: 'private_value_marker' } } }];
      else if (scenario !== 'proposal') parts = final({ kind: 'clarify', fields: ['people', 'divers'] });
      else {
        const responses = body.contents.flatMap(content => content.parts ?? []).flatMap(part => part.functionResponse ? [part.functionResponse] : []);
        const validation = responses.findLast(response => response.name === 'validate_changes')?.response;
        if (validation && validation.canApply !== true) {
          parts = final({ kind: 'conflict', evidenceRef: evidenceIdSchema.parse(validation.answerEvidenceRef) });
        } else {
          const name = validation ? 'propose_changes' : 'validate_changes';
          const args = validation ? { validationId: z.uuid().parse(validation.validationId) } : { changes };
          parts = call(name, args);
        }
      }
      return Response.json({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
        ...(scenario === 'missing-usage' ? {} : { usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 30, thoughtsTokenCount: 2 } }),
      });
    };
    // Install the actual worker listener only after transport is closed over the
    // frozen start snapshot, then deliver the original untouched IPC envelope.
    await import('../../src/agent/worker.ts');
    process.emit('message', start);
  })().catch(error => {
    const code = error instanceof Error && /^AGENT_[A-Z_]+$/.test(error.message)
      ? error.message : 'AGENT_OFFLINE_BOOTSTRAP_FAILED';
    if (process.send && process.connected) process.send({ type: 'failure', code }, () => process.exit(1));
    else process.exit(1);
  });
});
