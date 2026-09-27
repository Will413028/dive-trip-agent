/// <reference lib="esnext.temporal" />
// Offline P0 capability probe. No HTTP endpoint, environment loader or provider.
import { App, BaseLlm, DatabaseSessionService, FunctionTool, LlmAgent, Runner,
  type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Pool } from 'pg';
import { z } from 'zod';
import { GuardedModel } from '../../src/agent/model-guard.ts';
import { createReadTools } from '../../src/agent/tools.ts';
import { confirmationGates } from '../../src/agent/confirmation.ts';
import { validatedProposalParametersSchema } from '../../src/agent/tool-schemas.ts';
import { withAdkSchemaLock } from '../../src/server/adk-schema-lock.ts';
import { makeSnapshot } from '../../src/catalog/demo-fixtures.ts';

globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
const inputSchema = z.strictObject({ databaseUrl: z.string().regex(/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/dive_trip_test$/),
  schema: z.string().regex(/^test_[a-f0-9]{32}_adk$/), sessionId: z.uuid(),
  phase: z.enum(['start', 'resume', 'replay']), confirmed: z.boolean(),
  readCalls: z.union([z.literal(0), z.literal(3)]).default(0),
  resumeExtraRead: z.boolean().default(false), repeatId: z.boolean().default(false) });
const answerSchema = z.strictObject({ intent: z.literal('receipt'), references: z.array(z.string()).length(1) });

async function execute(raw: unknown) {
  const input = inputSchema.parse(raw);
  const pool = new Pool({ connectionString: input.databaseUrl, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  const admin = await pool.connect();
  try {
    if ((await admin.query('SELECT current_database() AS name')).rows[0].name !== 'dive_trip_test') throw new Error('WRONG_DATABASE');
    const sessions = new DatabaseSessionService({ driver: PostgreSqlDriver, clientUrl: input.databaseUrl,
      schema: input.schema, debug: false, pool: { min: 0, max: 2 },
      driverOptions: { connectionTimeoutMillis: 3000, statement_timeout: 5000 } });
    await withAdkSchemaLock(admin, async () => {
      await admin.query(`CREATE SCHEMA IF NOT EXISTS "${input.schema}"`);
      await sessions.init();
    });
    const identity = { appName: 'structured_output_probe', userId: 'synthetic', sessionId: input.sessionId };
    let saved = await sessions.getSession(identity);
    if (!saved) {
      if (input.phase !== 'start') throw new Error('MISSING_SESSION');
      saved = await sessions.createSession({ ...identity, state: { applications: 0 } });
    }
    const snapshot = makeSnapshot(), catalog = snapshot.entries.map(entry => entry.item);
    const gate = confirmationGates(saved.events, snapshot, catalog).at(-1);
    let calls = 0;
    let restoredCounts: Readonly<{ modelCalls: number; toolCalls: number }> | null = null;
    if (input.phase !== 'replay') {
      class Script extends BaseLlm {
        constructor() { super({ model: 'offline-structured-probe' }); }
        async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
          calls++;
          const parts = request.contents.flatMap(content => content.parts ?? []);
          const reads = parts.filter(part => part.functionResponse?.name === 'find_destinations').length;
          const result = parts
            .findLast(part => part.functionResponse?.name === 'validate_changes' || part.functionResponse?.name === 'propose_changes')?.functionResponse;
          const call = input.phase === 'start' && reads < input.readCalls
            ? { name: 'find_destinations', id: `read-${reads + 1}`, args: {} }
            : result?.name === 'propose_changes'
            ? input.resumeExtraRead && !parts.some(part => part.functionResponse?.name === 'calculate_budget')
              ? { name: 'calculate_budget', id: 'extra-read', args: {} }
              : { name: 'set_model_response', id: input.repeatId ? 'validation' : 'answer', args: { intent: 'receipt', references: ['proposal'] } }
            : result?.name === 'validate_changes'
              ? { name: 'propose_changes', id: 'proposal', args: { validationId: result.response?.validationId } }
              : { name: 'validate_changes', id: 'validation', args: { changes: [{ kind: 'remove', entryId: 'transfer' }] } };
          yield { content: { role: 'model', parts: [{ functionCall: call }] } };
        }
        async connect(): Promise<BaseLlmConnection> { throw new Error('NETWORK_FORBIDDEN'); }
      }
      const previous = saved.events.filter(event => !event.partial && event.author === identity.appName);
      const modelTools = ['find_destinations', 'find_items', 'calculate_budget', 'validate_changes', 'propose_changes'];
      const previousCalls = previous.flatMap(event => event.content?.parts ?? []).flatMap(part =>
        part.functionCall && modelTools.includes(part.functionCall.name ?? '') ? [part.functionCall] : []);
      const previousModelCalls = previous.filter(event => event.content?.parts?.some(part => part.text
        || modelTools.includes(part.functionCall?.name ?? ''))).length;
      const model = new GuardedModel(new Script(), { modelCalls: previousModelCalls, toolCalls: previousCalls.length,
        callIds: previousCalls.map(call => call.id!), proposed: previousCalls.some(call => call.name === 'propose_changes') }, answerSchema);
      restoredCounts = model.callCounts;
      const tool = new FunctionTool({ name: 'propose_changes', description: 'Synthetic confirmed receipt, not a product mutation.',
        parameters: validatedProposalParametersSchema, requireConfirmation: true,
        execute: (_args, context) => {
          if (!context || input.phase !== 'resume' || !input.confirmed) throw new Error('MISSING_DECISION');
          context.state.set('applications', Number(context.state.get('applications')) + 1);
          return { status: 'applied', version: 2 };
        } });
      const runner = new Runner({ app: new App({ name: identity.appName,
        rootAgent: new LlmAgent({ name: identity.appName, model, tools: [...createReadTools({ snapshot, catalog }), tool],
          outputSchema: answerSchema, outputKey: 'answer' }), resumabilityConfig: { isResumable: true } }), sessionService: sessions });
      if (input.phase === 'resume' && !gate) throw new Error('MISSING_GATE');
      for await (const event of runner.runAsync({ userId: identity.userId, sessionId: identity.sessionId,
        newMessage: { role: 'user', parts: input.phase === 'resume' ? [{ functionResponse: {
          name: 'adk_request_confirmation', id: gate!.interruptId, response: { confirmed: input.confirmed },
        } }] : [{ text: 'Synthetic proposal' }] }, abortSignal: AbortSignal.timeout(10000),
        runConfig: { maxLlmCalls: 7, plainTextToolConfirmation: false, allowRemoteToolConfirmation: false },
      })) if (event.errorCode) throw new Error(event.errorMessage && /^AGENT_[A-Z_]+$/.test(event.errorMessage)
        ? event.errorMessage : 'PROBE_ADK_FAILED');
    }
    const final = await sessions.getSession(identity);
    if (!final) throw new Error('MISSING_FINAL_SESSION');
    const finalGate = confirmationGates(final.events, snapshot, catalog).at(-1);
    return { pid: process.pid, modelCalls: calls, restoredCounts, applications: final.state.applications, answer: final.state.answer ?? null,
      interruptId: finalGate?.interruptId ?? null, eventId: final.events.at(-1)?.id ?? null,
      skipSummarization: final.events.at(-1)?.actions.skipSummarization ?? false };
  } finally { admin.release(); await pool.end(); }
}
process.once('message', raw => {
  void execute(raw).then(result => process.send?.({ ok: true, result }, () => process.exit(0)))
    .catch(error => process.send?.({ ok: false, code: error instanceof Error && /^AGENT_[A-Z_]+$/.test(error.message)
      ? error.message : 'STRUCTURED_OUTPUT_PROBE_FAILED' }, () => process.exit(1)));
});
process.on('disconnect', () => process.exit(1));
