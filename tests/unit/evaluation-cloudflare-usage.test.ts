import type { Pool } from 'pg';
import { expect, test, vi } from 'vitest';
import { auditAcceptedAnswerUsage, auditUsage } from '../../evals/usage';
import { exportUsageEvidence, usageEvidenceSchema, type EvaluationUsageBinding } from '../../evals/usage-evidence';
import { GEMINI_MODEL } from '../../src/agent/model-id';
import { CLOUDFLARE_MODEL, CLOUDFLARE_PRICE_BASIS } from '../../src/agent/cloudflare-wire';
import * as referenceCosts from '../../src/server/model-cost';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = uuid(1), trip = uuid(2), run = uuid(3), invocation = uuid(4), reservation = uuid(5);
const accountId = 'a'.repeat(32);
const binding = { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId } as const;
const time = '2026-09-26T00:00:00.000Z';
function rows(gemini = false) {
  return { invocations: [{ id: invocation, run_id: run, reservation_id: reservation, ledger_reservation_id: reservation,
    reservation_owner_id: owner, logical_run_id: run, reservation_status: 'settled',
    provider: gemini ? 'gemini' : 'cloudflare', model: gemini ? GEMINI_MODEL : CLOUDFLARE_MODEL,
    account_id: gemini ? null : accountId, kind: 'start', status: 'settled', max_cost_micros: '100',
    charged_cost_micros: gemini ? '17' : '5', actual_cost_micros: gemini ? '17' : '5', created_at: time, expires_at: time } as Record<string, unknown>],
  calls: [{ invocation_id: invocation, run_id: run, call_id: 'synthetic-call', status: 'completed',
    usage: { promptTokens: 20, outputTokens: 8, totalTokens: 28 }, provider_evidence: gemini ? null
      : { provider: 'cloudflare', returnedModel: `${CLOUDFLARE_MODEL}-external`, priceBasis: CLOUDFLARE_PRICE_BASIS },
    started_at: time, completed_at: time } as Record<string, unknown>] };
}
function mockPool(data = rows(), schema = `test_${'a'.repeat(32)}`, owns = true) {
  const query = vi.fn(async (sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    if (sql.includes('current_schema()')) return { rows: [{ name: schema }], rowCount: 1 };
    if (sql.includes('SELECT r.id FROM agent_runs')) return { rows: owns ? [{ id: run }] : [], rowCount: owns ? 1 : 0 };
    if (sql.includes('FROM model_calls')) return { rows: data.calls, rowCount: data.calls.length };
    if (sql.includes('FROM agent_invocations')) return { rows: data.invocations, rowCount: data.invocations.length };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn(); const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect, query } as unknown as Pool, query, release, connect };
}

test('explicit Cloudflare binding audits reference costs and exports version 2 with linked private evidence', async () => {
  const s = mockPool();
  expect(await auditUsage(s.pool, owner, trip, run, binding)).toEqual({ model: CLOUDFLARE_MODEL, runId: run,
    complete: true, modelCalls: 1, costMicros: 5 });
  const evidence = await exportUsageEvidence(s.pool, owner, trip, run, binding);
  expect(evidence).toMatchObject({ schemaVersion: 2, binding, runId: run,
    invocations: [{ provider: 'cloudflare', model: CLOUDFLARE_MODEL, account_id: accountId, run_id: run,
      reservation_id: reservation, logical_run_id: run, reservation_status: 'settled' }],
    calls: [{ run_id: run, invocation_id: invocation, provider_evidence: { provider: 'cloudflare', priceBasis: CLOUDFLARE_PRICE_BASIS } }] });
  expect(usageEvidenceSchema.parse(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
});

test('Gemini four-argument API and historical schemaVersion 1 stay compatible', async () => {
  const s = mockPool(rows(true));
  expect(await auditUsage(s.pool, owner, trip, run)).toEqual({ model: GEMINI_MODEL, runId: run,
    complete: true, modelCalls: 1, costMicros: 17 });
  const evidence = await exportUsageEvidence(s.pool, owner, trip, run);
  expect(evidence.schemaVersion).toBe(1);
  expect(evidence).not.toHaveProperty('binding');
  const historical = { schemaVersion: 1, runId: run,
    invocations: [{ id: invocation, reservation_id: reservation, kind: 'start', model: GEMINI_MODEL, status: 'settled',
      max_cost_micros: '100', charged_cost_micros: '100', actual_cost_micros: null, created_at: time, expires_at: time }],
    calls: [{ invocation_id: invocation, call_id: 'old-call', status: 'completed', usage: null, started_at: time, completed_at: time }] };
  expect(usageEvidenceSchema.parse(historical)).toEqual(historical);
});

test.each(['provider', 'model', 'account_id', 'run_id', 'reservation_id', 'reservation_owner_id', 'logical_run_id'] as const)(
  'audit/export rejects invocation binding mismatch: %s', async field => {
    const data = rows(); data.invocations[0][field] = field === 'provider' ? 'gemini' : field === 'model' ? GEMINI_MODEL
      : field === 'account_id' ? 'b'.repeat(32) : uuid(99);
    for (const fn of [auditUsage, exportUsageEvidence]) {
      await expect(fn(mockPool(data).pool, owner, trip, run, binding)).rejects.toThrow('EVAL_USAGE_BINDING_INVALID');
    }
  });

test.each(['run_id', 'invocation_id'] as const)('rejects cross-run call %s even if token totals match', async field => {
  const data = rows(); data.calls[0][field] = uuid(99);
  await expect(auditUsage(mockPool(data).pool, owner, trip, run, binding)).rejects.toThrow('EVAL_USAGE_BINDING_INVALID');
});

test.each([null, {}, { promptTokens: 20, outputTokens: 8, totalTokens: 30 },
  { promptTokens: 20, outputTokens: 8, totalTokens: 28, thoughtTokens: 2 },
  { promptTokens: 20, outputTokens: 8, totalTokens: 28, cachedTokens: 21 },
])('unknown or malformed Cloudflare usage stays null: %j', async usage => {
  const data = rows(); data.calls[0].usage = usage;
  data.invocations[0].actual_cost_micros = null; data.invocations[0].charged_cost_micros = '100';
  const s = mockPool(data);
  expect(await auditUsage(s.pool, owner, trip, run, binding)).toMatchObject({ complete: false, costMicros: null });
  const evidence = await exportUsageEvidence(s.pool, owner, trip, run, binding);
  expect(evidence.calls[0].usage).toBeNull();
  expect(evidence.invocations[0]).toMatchObject({ actual_cost_micros: null, charged_cost_micros: '100' });
});

test.each([null, { provider: 'openrouter', returnedModel: 'example/model', generationId: 'x', reportedCostMicros: 0 },
  { provider: 'cloudflare', returnedModel: '@cf/other/model', priceBasis: CLOUDFLARE_PRICE_BASIS },
  { provider: 'cloudflare', returnedModel: CLOUDFLARE_MODEL, priceBasis: 'wrong' },
])('foreign/missing cost evidence never becomes known usage: %j', async evidence => {
  const data = rows(); data.calls[0].provider_evidence = evidence;
  expect(await auditUsage(mockPool(data).pool, owner, trip, run, binding)).toMatchObject({ complete: false, costMicros: null });
});

test('reconciles each invocation rather than allowing ledger discrepancies to cancel', async () => {
  const data = rows();
  data.invocations.push({ ...data.invocations[0], id: uuid(6), reservation_id: uuid(7), ledger_reservation_id: uuid(7), kind: 'resume',
    actual_cost_micros: '6', charged_cost_micros: '6' });
  data.invocations[0].actual_cost_micros = '4'; data.invocations[0].charged_cost_micros = '4';
  data.calls.push({ ...data.calls[0], invocation_id: uuid(6), call_id: 'second' });
  expect(await auditUsage(mockPool(data).pool, owner, trip, run, binding)).toMatchObject({ complete: false, costMicros: null });
});

test('schema and owner guard run before ledger reads; read-only bounded export strips private payloads', async () => {
  for (const [schema, owns, code] of [['public', true, 'EVAL_TEST_SCHEMA_REQUIRED'],
    [`test_${'a'.repeat(32)}\n`, true, 'EVAL_TEST_SCHEMA_REQUIRED'],
    [`test_${'a'.repeat(32)}`, false, 'EVAL_AUDIT_OWNER_MISMATCH']] as const) {
    const s = mockPool(rows(), schema, owns);
    await expect(exportUsageEvidence(s.pool, owner, trip, run, binding)).rejects.toThrow(code);
    expect(s.query.mock.calls.some(([sql]) => sql.includes('FROM agent_invocations'))).toBe(false);
    expect(s.release).toHaveBeenCalled();
  }
  const data = rows(); data.invocations[0].api_key = 'private-payload'; data.calls[0].prompt = 'private-payload';
  const s = mockPool(data);
  expect(JSON.stringify(await exportUsageEvidence(s.pool, owner, trip, run, binding))).not.toContain('private-payload');
  const queries = s.query.mock.calls.map(([sql]) => sql).join('\n');
  expect(queries).toContain('REPEATABLE READ READ ONLY');
  expect(queries).toContain('LIMIT 3'); expect(queries).toContain('LIMIT 8');
  expect(queries).not.toMatch(/SELECT \*|\b(INSERT|UPDATE|DELETE|DROP)\b/);
});

test('binding is explicit, fixed and validated before any DB access', async () => {
  for (const selected of [{ ...binding, model: `${CLOUDFLARE_MODEL}-external` }, { ...binding, accountId: `${accountId}\n` },
    { ...binding, accountId: undefined }, { provider: 'openrouter', model: 'example/model:free' }]) {
    const s = mockPool();
    await expect(auditUsage(s.pool, owner, trip, run, selected as EvaluationUsageBinding)).rejects.toThrow('EVAL_USAGE_BINDING_INVALID');
    expect(s.connect).not.toHaveBeenCalled();
  }
  await expect(auditUsage(mockPool().pool, owner, trip, run)).rejects.toThrow('EVAL_USAGE_BINDING_INVALID');
  await expect(exportUsageEvidence(mockPool(rows(true)).pool, owner, trip, run, binding)).rejects.toThrow('EVAL_USAGE_BINDING_INVALID');
});

test('Gemini unknown usage remains incomplete and null in historical-format export', async () => {
  const data = rows(true); data.calls[0].usage = null;
  data.invocations[0].actual_cost_micros = null; data.invocations[0].charged_cost_micros = '100';
  const s = mockPool(data);
  expect(await auditUsage(s.pool, owner, trip, run)).toMatchObject({ complete: false, costMicros: null });
  expect(await exportUsageEvidence(s.pool, owner, trip, run)).toMatchObject({ schemaVersion: 1,
    calls: [{ usage: null }], invocations: [{ actual_cost_micros: null, charged_cost_micros: '100' }] });
});

test.each(['active', 'reservation-active', 'started', 'no-calls', 'empty', 'charged-mismatch'] as const)(
  'incomplete state remains exportable but never known cost: %s', async state => {
    const data = rows();
    if (state === 'active') data.invocations[0].status = 'active';
    if (state === 'reservation-active') data.invocations[0].reservation_status = 'reserved';
    if (state === 'started') { data.calls[0].status = 'started'; data.calls[0].completed_at = null; data.calls[0].usage = null; }
    if (state === 'no-calls' || state === 'empty') data.calls = [];
    if (state === 'empty') data.invocations = [];
    if (state === 'charged-mismatch') data.invocations[0].charged_cost_micros = '100';
    const s = mockPool(data);
    expect(await auditUsage(s.pool, owner, trip, run, binding)).toMatchObject({ complete: false, costMicros: null });
    expect((await exportUsageEvidence(s.pool, owner, trip, run, binding)).schemaVersion).toBe(2);
  });

test.each(['duplicate-invocation', 'duplicate-reservation', 'duplicate-call', 'too-many-invocations', 'too-many-calls', 'missing-ledger'] as const)(
  'invalid cardinality or duplicate linkage fails closed: %s', async failure => {
    const data = rows();
    if (failure === 'duplicate-invocation') data.invocations.push({ ...data.invocations[0], kind: 'resume' });
    if (failure === 'duplicate-reservation') data.invocations.push({ ...data.invocations[0], id: uuid(9), kind: 'resume' });
    if (failure === 'duplicate-call') data.calls.push({ ...data.calls[0] });
    if (failure === 'too-many-invocations') data.invocations = Array(3).fill(data.invocations[0]);
    if (failure === 'too-many-calls') data.calls = Array(8).fill(data.calls[0]);
    if (failure === 'missing-ledger') data.invocations[0].ledger_reservation_id = null;
    await expect(exportUsageEvidence(mockPool(data).pool, owner, trip, run, binding)).rejects.toThrow('EVAL_USAGE_BINDING_INVALID');
  });

test('serialized v2 rejects tampered account/run/call/reservation linkage', async () => {
  const evidence = await exportUsageEvidence(mockPool().pool, owner, trip, run, binding);
  if (evidence.schemaVersion !== 2) throw new Error('EXPECTED_CLOUDFLARE_EVIDENCE');
  for (const mutate of [
    (copy: typeof evidence) => { copy.binding.accountId = 'b'.repeat(32); },
    (copy: typeof evidence) => { copy.runId = uuid(99); },
    (copy: typeof evidence) => { copy.invocations[0].run_id = uuid(99); },
    (copy: typeof evidence) => { copy.invocations[0].logical_run_id = uuid(99); },
    (copy: typeof evidence) => { copy.calls[0].invocation_id = uuid(99); },
    (copy: typeof evidence) => { copy.calls[0].run_id = uuid(99); },
    (copy: typeof evidence) => { copy.calls[0].provider_evidence = null; },
    (copy: typeof evidence) => { copy.calls[0].completed_at = null; },
  ]) {
    const copy = structuredClone(evidence); mutate(copy);
    expect(usageEvidenceSchema.safeParse(copy).success).toBe(false);
  }
  const privatePayload = { ...evidence, apiKey: 'private-marker', calls: evidence.calls.map(call => ({ ...call, prompt: 'private-marker' })) };
  expect(JSON.stringify(usageEvidenceSchema.parse(privatePayload))).not.toContain('private-marker');
});

test('known CF output is not double counted and both fixed returned-model aliases are accepted', async () => {
  const data = rows();
  data.calls[0].usage = { promptTokens: 20, outputTokens: 8, totalTokens: 28, cachedTokens: 20 };
  data.calls[0].provider_evidence = { provider: 'cloudflare', returnedModel: CLOUDFLARE_MODEL, priceBasis: CLOUDFLARE_PRICE_BASIS };
  expect(await auditUsage(mockPool(data).pool, owner, trip, run, binding)).toMatchObject({ complete: true, costMicros: 5 });
});

function nativePool(summary: Record<string, unknown> = {}, options: {
  contract?: number; quiescent?: boolean; tables?: boolean; matches?: number;
  data?: ReturnType<typeof rows>; status?: string; zeroProof?: boolean; receipt?: unknown; invalidReceipt?: boolean;
} = {}) {
  const s = mockPool(options.data), originalQuery = s.query.getMockImplementation()!;
  const hasResume = options.data?.invocations.some(row => row.kind === 'resume') ?? false;
  s.query.mockImplementation(async sql => {
    if (sql.includes('SELECT r.answer_contract_version,')) return { rows: [{
      answer_contract_version: options.contract ?? 1, quiescent: options.quiescent ?? true,
      base_version: 1, proposal_id: hasResume ? uuid(8) : null, decision: hasResume ? true : null,
      status: options.status ?? 'succeeded' }], rowCount: 1 };
    if (sql.includes('WITH decision AS')) return { rows: [{
      receipt: options.receipt === undefined ? { runId: run, status: 'applied', version: 2 } : options.receipt,
      invalid: options.invalidReceipt ?? false }], rowCount: 1 };
    if (sql.includes('AS zero_resume_verified')) return { rows: [{ zero_resume_verified: options.zeroProof ?? false }], rowCount: 1 };
    if (sql.includes('to_regclass')) return { rows: [{ present: options.tables ?? true }], rowCount: 1 };
    if (sql.includes('AS matches FROM')) return { rows: [{ matches: options.matches ?? 1 }], rowCount: 1 };
    if (sql.includes('WITH bounded_events')) return { rows: [{ event_count: 2, model_events: 1, tool_calls: 1,
      invalid: false, fault_observed: false, ...summary }], rowCount: 1 };
    return originalQuery(sql);
  });
  return s;
}

test('new private audit adds bounded native metadata without changing historical accounting/export', async () => {
  const s = nativePool({ tool_calls: 2, fault_observed: true });
  const old = await auditUsage(s.pool, owner, trip, run, binding);
  const originalExport = await exportUsageEvidence(s.pool, owner, trip, run, binding);
  expect(await auditAcceptedAnswerUsage(s.pool, owner, trip, run, binding)).toEqual({ ...old,
    nativeToolCalls: 2, faultObserved: 'catalog-timeout', decisionReceipt: null });
  expect(await auditUsage(s.pool, owner, trip, run, binding)).toEqual(old);
  expect(await exportUsageEvidence(s.pool, owner, trip, run, binding)).toEqual(originalExport);
  const queries = s.query.mock.calls.map(([sql]) => sql).join('\n');
  expect(queries).toContain('REPEATABLE READ READ ONLY');
  expect(queries).toContain('LIMIT 129');
  expect(queries).not.toMatch(/SELECT \*|\b(INSERT|UPDATE|DELETE|DROP)\b/);
});

test.each([
  { event_count: 0 }, { event_count: 129 }, { model_events: 0 }, { model_events: 2 },
  { invalid: true }, { tool_calls: -1 }, { tool_calls: '1' }, { raw: 'private-marker' },
])('incomplete/invalid native metadata stays unknown: %j', async summary => {
  const result = await auditAcceptedAnswerUsage(nativePool(summary).pool, owner, trip, run, binding);
  expect(result).toMatchObject({ complete: true, costMicros: 5, nativeToolCalls: null, faultObserved: null });
  expect(JSON.stringify(result)).not.toContain('private-marker');
});

test.each([{ contract: 0 }, { quiescent: false }, { tables: false }, { matches: 0 }, { matches: 2 }])(
  'native history is not certified without a current quiescent bound session: %j', async options => {
    const s = nativePool({}, options);
    expect(await auditAcceptedAnswerUsage(s.pool, owner, trip, run, binding)).toMatchObject({ nativeToolCalls: null, faultObserved: null });
    expect(s.query.mock.calls.some(([sql]) => sql.includes('WITH bounded_events'))).toBe(false);
  });

test('native audit keeps an excessive count observable instead of capping it to six', async () => {
  expect(await auditAcceptedAnswerUsage(nativePool({ tool_calls: 7 }).pool, owner, trip, run, binding))
    .toMatchObject({ nativeToolCalls: 7 });
});

function zeroResumeRows(gemini = false) {
  const data = rows(gemini);
  data.invocations.push({ ...data.invocations[0], id: uuid(6), kind: 'resume',
    reservation_id: uuid(7), ledger_reservation_id: uuid(7), actual_cost_micros: '0', charged_cost_micros: '0' });
  return data;
}

test.each(['cloudflare', 'gemini'] as const)(
  '%s: only current verified zero-call resume is known; historical audit/export stay unchanged', async provider => {
    const selected = provider === 'cloudflare' ? binding : undefined;
    const data = zeroResumeRows(provider === 'gemini');
    data.invocations[1].max_cost_micros = '0'; // Current zero-model admission, not historical rewriting.
    const s = nativePool({ tool_calls: 2 }, { data, zeroProof: true });
    const original = await exportUsageEvidence(s.pool, owner, trip, run, selected);
    const historical = { model: provider === 'cloudflare' ? CLOUDFLARE_MODEL : GEMINI_MODEL, runId: run,
      complete: false, modelCalls: 1, costMicros: null };
    expect(await auditUsage(s.pool, owner, trip, run, selected)).toEqual(historical);
    expect(await auditAcceptedAnswerUsage(s.pool, owner, trip, run, selected)).toMatchObject({
      complete: true, costMicros: provider === 'cloudflare' ? 5 : 17, modelCalls: 1, nativeToolCalls: 2,
      decisionReceipt: { runId: run, status: 'applied', version: 2 } });
    expect(await auditUsage(s.pool, owner, trip, run, selected)).toEqual(historical);
    expect(await exportUsageEvidence(s.pool, owner, trip, run, selected)).toEqual(original);
    expect(original.invocations[1].max_cost_micros).toBe('0');
    expect(s.query).toHaveBeenCalledWith(expect.stringContaining("AND state->>'providerModel'=$5"),
      [run, owner, provider, provider === 'cloudflare' ? accountId : null, historical.model]);
    const queries = s.query.mock.calls.map(([sql]) => sql).join('\n');
    expect(queries).toContain('AS zero_resume_verified');
    expect(queries).toContain('skip_summarization');
    expect(queries).not.toMatch(/SELECT \*|\b(INSERT|UPDATE|DELETE|DROP)\b/);
  });

test.each([false, true])('current audit reads once and reconciles once, only after native proof=%s', async zeroProof => {
  const s = nativePool({}, { data: zeroResumeRows(), zeroProof });
  const originalQuery = s.query.getMockImplementation()!;
  const cost = vi.spyOn(referenceCosts, 'referenceProviderCost');
  s.query.mockImplementation(async sql => {
    if (sql.includes('AS zero_resume_verified')) {
      // The historical snapshot reader normalizes this one model call once.
      // Reconciliation must not have run before the independent proof.
      expect(cost).toHaveBeenCalledTimes(1);
    }
    return originalQuery(sql);
  });
  try {
    const result = await auditAcceptedAnswerUsage(s.pool, owner, trip, run, binding);
    expect(result).toMatchObject({ complete: zeroProof, costMicros: zeroProof ? 5 : null });
    // One unchanged normalization + one shared reconciliation, no correction
    // pass or second snapshot read after discovering an empty invocation.
    expect(cost).toHaveBeenCalledTimes(2);
    expect(s.query.mock.calls.filter(([sql]) => sql.includes('FROM agent_invocations i LEFT JOIN quota_reservations'))).toHaveLength(1);
    expect(s.query.mock.calls.filter(([sql]) => sql.includes('AS zero_resume_verified'))).toHaveLength(1);
  } finally { cost.mockRestore(); }
});

test.each(['cloudflare', 'gemini'] as const)(
  '%s: both version policies keep identical nonempty reconciliation and unknowns', async provider => {
    const selected = provider === 'cloudflare' ? binding : undefined;
    const callCost = provider === 'cloudflare' ? 5 : 17;
    for (const state of ['known', 'unknown-usage', 'offsetting-mismatch'] as const) {
      const data = zeroResumeRows(provider === 'gemini');
      data.invocations[1].actual_cost_micros = String(callCost);
      data.invocations[1].charged_cost_micros = String(callCost);
      data.calls.push({ ...data.calls[0], invocation_id: uuid(6), call_id: 'resume-model-call' });
      if (state === 'unknown-usage') data.calls[1].usage = null;
      if (state === 'offsetting-mismatch') {
        data.invocations[0].actual_cost_micros = data.invocations[0].charged_cost_micros = String(callCost - 1);
        data.invocations[1].actual_cost_micros = data.invocations[1].charged_cost_micros = String(callCost + 1);
      }
      const original = structuredClone(data);
      const s = nativePool({ model_events: 2 }, { data, zeroProof: true });
      const expected = { model: provider === 'cloudflare' ? CLOUDFLARE_MODEL : GEMINI_MODEL, runId: run,
        complete: state === 'known', modelCalls: 2, costMicros: state === 'known' ? callCost * 2 : null };
      expect(await auditUsage(s.pool, owner, trip, run, selected)).toEqual(expected);
      expect(await auditAcceptedAnswerUsage(s.pool, owner, trip, run, selected)).toMatchObject(expected);
      expect(s.query.mock.calls.some(([sql]) => sql.includes('AS zero_resume_verified'))).toBe(false);
      expect(data).toEqual(original);
    }
  });

test.each(['no-proof', 'null-cost', 'charged', 'resume-active', 'reservation-active', 'failed-run', 'legacy',
  'nonquiescent', 'start-empty', 'unknown-start', 'native-incomplete', 'no-receipt', 'session-model-mismatch'])(
  'zero-call resume does not hide missing evidence: %s', async mode => {
    const data = zeroResumeRows();
    if (mode === 'null-cost') data.invocations[1].actual_cost_micros = null;
    if (mode === 'charged') data.invocations[1].charged_cost_micros = '100';
    if (mode === 'resume-active') data.invocations[1].status = 'active';
    if (mode === 'reservation-active') data.invocations[1].reservation_status = 'reserved';
    if (mode === 'start-empty') { data.calls = []; data.invocations[0].actual_cost_micros = '0'; data.invocations[0].charged_cost_micros = '0'; }
    if (mode === 'unknown-start') data.calls[0].usage = null;
    const s = nativePool(mode === 'native-incomplete' ? { invalid: true } : {}, { data,
      zeroProof: mode !== 'no-proof', status: mode === 'failed-run' ? 'failed' : 'succeeded',
      contract: mode === 'legacy' ? 0 : 1, quiescent: mode !== 'nonquiescent',
      matches: mode === 'session-model-mismatch' ? 0 : 1,
      ...(mode === 'no-receipt' ? { receipt: null } : {}) });
    expect(await auditAcceptedAnswerUsage(s.pool, owner, trip, run, binding)).toMatchObject({ complete: false, costMicros: null });
    if (mode === 'session-model-mismatch') {
      expect(s.query.mock.calls.some(([sql]) => sql.includes('WITH bounded_events') || sql.includes('AS zero_resume_verified'))).toBe(false);
    }
  });

test('invalid product receipt fails closed without exposing raw receipt payload', async () => {
  const s = nativePool({}, { data: zeroResumeRows(), zeroProof: true, invalidReceipt: true });
  await expect(auditAcceptedAnswerUsage(s.pool, owner, trip, run, binding)).rejects.toThrow('EVAL_PRODUCT_RECEIPT_INVALID');
});
