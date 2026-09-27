import { execFileSync } from 'node:child_process';
import { FunctionTool, type Context } from '@google/adk';
import { expect, test } from 'vitest';
import { createReadTools, TOOL_ITEMS_LIMIT, TOOL_OUTPUT_MAX_BYTES } from '../../src/agent/tools.ts';
import { agentChangesSchema, agentToolParameters, proposalParametersSchema, validatedProposalParametersSchema } from '../../src/agent/tool-schemas.ts';
import { buildProposal } from '../../src/domain/proposal.ts';
import { makeSnapshot } from '../../src/catalog/demo-fixtures.ts';
import type { CatalogItem, Change, Snapshot } from '../../src/domain/types.ts';

function setup(snapshot = makeSnapshot(), catalog = snapshot.entries.map(e => e.item)) {
  const tools = createReadTools({ snapshot, catalog });
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(tool => tool.name === name);
    if (!tool) throw new Error('MISSING_TEST_TOOL');
    // No tool reads a context or touches context.state, artifacts or services.
    return tool.runAsync({ args, toolContext: {} as Context });
  };
  return { tools, call, snapshot, catalog };
}

test('isolated evaluation lookup fault returns explicit timeout without fabricated items', async () => {
  const snapshot = makeSnapshot();
  const tools = createReadTools({ snapshot, catalog: snapshot.entries.map(e => e.item) }, true);
  const output = await tools.find(tool => tool.name === 'find_items')!.runAsync({ args: { destinationId: 'xiaoliuqiu' }, toolContext: {} as Context });
  expect(output).toEqual({ error: 'CATALOG_TIMEOUT', items: [], retryable: false });
});

test('恰四個唯讀FunctionTool，所有ADK declaration（含union）可實際轉換', () => {
  const { tools } = setup();
  expect(tools.map(t => t.name)).toEqual(['find_destinations', 'find_items', 'calculate_budget', 'validate_changes']);
  for (const tool of tools) {
    expect(tool).toBeInstanceOf(FunctionTool);
    const declaration = tool._getDeclaration();
    expect(declaration.name).toBe(tool.name);
    expect(declaration.parameters?.type).toBe('OBJECT');
  }
  const validation = new FunctionTool({ name: 'validate_changes', description: 'schema probe',
    parameters: proposalParametersSchema, execute: input => input });
  const declaration = JSON.stringify(validation._getDeclaration().parameters);
  for (const kind of ['requirements', 'add', 'remove', 'move', 'replace', 'rooms']) expect(declaration).toContain(`"${kind}"`);
  expect(declaration).not.toContain('"lock"');
  expect(declaration).not.toContain('"actor"');
  const proposal = new FunctionTool({ name: 'propose_changes', description: 'schema probe',
    parameters: validatedProposalParametersSchema, execute: input => input });
  expect(proposal._getDeclaration().parameters).toMatchObject({
    properties: { validationId: { type: 'STRING', format: 'uuid' } }, required: ['validationId'],
  });
  expect(Object.keys(proposal._getDeclaration().parameters!.properties!)).toEqual(['validationId']);
  expect(agentToolParameters.propose_changes).toBe(validatedProposalParametersSchema);
  expect(agentToolParameters.validate_changes).toBe(proposalParametersSchema);
  for (const schema of Object.values(agentToolParameters)) expect(schema.safeParse({ actor: 'user' }).success).toBe(false);
});

test('proposal accepts only a strict validation UUID, never repeated changes', () => {
  const validationId = '12345678-1234-4234-8234-123456789abc';
  expect(validatedProposalParametersSchema.parse({ validationId })).toEqual({ validationId });
  const changes = [{ kind: 'requirements', value: { pace: 'relaxed' } }];
  for (const input of [{}, { changes }, { validationId, changes }, { validationId, actor: 'user' },
    ...[null, undefined, '', 'not-a-uuid', 123, ` ${validationId}`, `${validationId} `].map(validationId => ({ validationId }))]) {
    expect(validatedProposalParametersSchema.safeParse(input).success).toBe(false);
  }
  expect(proposalParametersSchema.safeParse({ validationId }).success).toBe(false);
  expect(proposalParametersSchema.safeParse({ changes, validationId }).success).toBe(false);
});

test('successful validation returns a fresh UUID each time without mutating the snapshot', async () => {
  const { call, snapshot } = setup();
  const before = structuredClone(snapshot);
  const args = { changes: [{ kind: 'requirements', value: { pace: 'relaxed' } }] };
  const first = await call('validate_changes', args);
  const second = await call('validate_changes', args);
  expect(first).toMatchObject({ canApply: true, validationId: expect.any(String) });
  expect(second).toMatchObject({ canApply: true, validationId: expect.any(String) });
  const firstId = validatedProposalParametersSchema.strip().parse(first);
  const secondId = validatedProposalParametersSchema.strip().parse(second);
  expect(firstId.validationId).not.toBe(secondId.validationId);
  expect(snapshot).toEqual(before);
});

test('原生Node可import tools與其domain依賴閉包、生成declaration', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { createReadTools } from './src/agent/tools.ts';
    import { makeSnapshot } from './src/catalog/demo-fixtures.ts';
    const snapshot = makeSnapshot();
    const tools = createReadTools({ snapshot, catalog: snapshot.entries.map(e => e.item) });
    for (const tool of tools) tool._getDeclaration();
    console.log(tools.map(t => t.name).join(','));
  `], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 15_000,
    env: { NODE_ENV: 'test', OTEL_SDK_DISABLED: 'true' } });
  expect(output.trim()).toBe('find_destinations,find_items,calculate_budget,validate_changes');
});

test.each(['url', 'sql', 'command', 'actor', 'snapshot', 'catalog'])('所有工具拒絕額外%s參數', async key => {
  const { call } = setup();
  const extra = { [key]: 'untrusted' };
  await expect(call('find_destinations', extra)).rejects.toThrow();
  await expect(call('find_items', { destinationId: 'xiaoliuqiu', ...extra })).rejects.toThrow();
  await expect(call('calculate_budget', extra)).rejects.toThrow();
  await expect(call('validate_changes', { changes: [{ kind: 'remove', entryId: 'tour' }], ...extra })).rejects.toThrow();
});

test('find_destinations只列支援ID；find_items只從服務端查並保留price source／DEMO', async () => {
  const snapshot = makeSnapshot();
  const green: CatalogItem = { ...structuredClone(snapshot.entries[1].item), id: 'green', destinationId: 'green-island' };
  const { call } = setup(snapshot, [...snapshot.entries.map(e => e.item), green]);
  expect(await call('find_destinations')).toEqual({ destinations: [
    { id: 'xiaoliuqiu', name: '小琉球', itemCount: 3, demoItemCount: 3 },
    { id: 'green-island', name: '綠島', itemCount: 1, demoItemCount: 1 },
    { id: 'kenting', name: '墾丁', itemCount: 0, demoItemCount: 0 },
  ] });
  expect(await call('find_items', { destinationId: 'green-island' })).toMatchObject({ total: 1, omittedCount: 0,
    items: [{ id: 'green', price: green.price, sources: green.sources }] });
  expect(await call('find_items', { destinationId: 'kenting' })).toEqual({ items: [], total: 0, omittedCount: 0 });
  await expect(call('find_items', { destinationId: 'unknown' })).rejects.toThrow();
});

test('來源摘要保留價格HTTPS引用與獨立DEMO，URL只作metadata', async () => {
  const snapshot = makeSnapshot(); const item = snapshot.entries[1].item;
  item.price.basis = 'estimate'; item.price.sourceId = 'price';
  item.sources.push({ id: 'price', url: 'https://example.com/price', kind: 'fact', checkedAt: '2026-09-21', label: '價格來源' });
  const { call } = setup(snapshot);
  const output = await call('find_items', { destinationId: 'xiaoliuqiu' });
  expect(output).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'tour',
    sources: [item.sources[1], item.sources[0]], price: expect.objectContaining({ basis: 'estimate', sourceId: 'price' }) })]) });
});

test('budget 使用建立工具時的detached snapshot，外部變動與輸出變動不污染下次呼叫', async () => {
  const { call, snapshot, catalog } = setup();
  snapshot.requirements.people = 6;
  catalog[0].price.unitMinor = 1;
  const first = await call('calculate_budget');
  expect(first).toMatchObject({ knownMinor: 430000, withinBudget: true, unknownEntryIds: [], currency: 'TWD', unit: 'minor' });
  (first as { knownMinor: number }).knownMinor = 0;
  expect(await call('calculate_budget')).toMatchObject({ knownMinor: 430000 });
  const items = await call('find_items', { destinationId: 'xiaoliuqiu' }) as { items: CatalogItem[] };
  items.items[0].price.unitMinor = 999;
  expect(await call('find_items', { destinationId: 'xiaoliuqiu' })).toMatchObject({ items: [expect.objectContaining({ price: expect.objectContaining({ unitMinor: 100000 }) }), expect.anything(), expect.anything()] });
});

test('未知價格與exclusions不當零；保留原因、來源，withinBudget為null', async () => {
  const snapshot = makeSnapshot(); snapshot.exclusions = ['餐費未計'];
  snapshot.entries[1].item.price.unitMinor = null; snapshot.entries[1].item.price.unknownReason = '待報價';
  const { call } = setup(snapshot);
  expect(await call('calculate_budget')).toMatchObject({ knownMinor: 330000, unknownEntryIds: ['tour'], withinBudget: null,
    exclusions: ['餐費未計'], unknownCosts: [{ entryId: 'tour', reason: '待報價', source: snapshot.entries[1].item.sources[0] }] });
  expect(await call('validate_changes', { changes: [{ kind: 'remove', entryId: 'transfer' }] })).toMatchObject({
    canApply: true, budget: { knownMinor: 300000, unknownEntryIds: ['tour'], withinBudget: null },
    issues: expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_COST' }), expect.objectContaining({ code: 'EXCLUDED_COST' })]),
  });
});

test('未知單價但零參與者遵守domain，不列為待估費用', async () => {
  const snapshot = makeSnapshot(); snapshot.requirements.divers = 0;
  snapshot.entries[1].item.audience = 'divers';
  Object.assign(snapshot.entries[1].item.price, { unitMinor: null, unknownReason: '待報價' });
  expect(await setup(snapshot).call('calculate_budget')).toMatchObject({ unknownEntryIds: [], unknownCosts: [], knownMinor: 330000, withinBudget: true });
});

test.each([
  [{ kind: 'lock', entryId: 'stay', locked: false }],
  [{ kind: 'add', entry: { id: 'new', catalogId: 'tour', day: 3, slot: 'morning', rooms: null, endDay: null, locked: false } }],
  [{ kind: 'replace', entryId: 'tour', catalogId: 'tour', item: { price: 0 } }],
  [{ kind: 'remove', entryId: 'tour', actor: 'user' }],
  [{ kind: 'remove', entryId: 'tour', url: 'https://example.com' }],
])('shared strict schema拒絕lock或偽造nested欄位：%j', async change => {
  expect(agentChangesSchema.safeParse([change]).success).toBe(false);
  await expect(setup().call('validate_changes', { changes: [change] })).rejects.toThrow();
});

test('schema邊界：空批次、超100、長ID、不合法數量及requirements額外欄位', async () => {
  const snapshot = makeSnapshot();
  for (const changes of [[], Array.from({ length: 101 }, () => ({ kind: 'remove', entryId: 'tour' })),
    [{ kind: 'remove', entryId: 'a'.repeat(129) }], [{ kind: 'rooms', entryId: 'stay', rooms: -1 }],
    [{ kind: 'requirements', value: { ...snapshot.requirements, actor: 'user' } }]]) {
    expect(proposalParametersSchema.safeParse({ changes }).success).toBe(false);
  }
});

test.each([
  { changes: [{ kind: 'remove', entryId: 'missing' }], code: 'ENTRY_NOT_FOUND' },
  { changes: [{ kind: 'replace', entryId: 'tour', catalogId: 'missing' }], code: 'CATALOG_NOT_FOUND' },
  { changes: [{ kind: 'move', entryId: 'transfer', day: 2, slot: 'morning' }], code: 'OVERLAP' },
  { changes: [{ kind: 'move', entryId: 'tour', day: 8, slot: 'morning' }], code: 'DATE_OUT_OF_RANGE' },
  { changes: [{ kind: 'requirements', value: { ...makeSnapshot().requirements, people: 4 } }], code: 'CAPACITY' },
  { changes: [{ kind: 'requirements', value: { ...makeSnapshot().requirements, divers: 3 } }], code: 'INVALID_CHANGE' },
  { changes: [{ kind: 'requirements', value: { ...makeSnapshot().requirements, budgetMinor: 100 } }], code: 'BUDGET_EXCEEDED' },
])('validate_changes傳回真正domain規則：$code', async ({ changes, code }) => {
  const { call, snapshot, catalog } = setup();
  const expected = buildProposal(snapshot, changes as Change[], catalog, 'agent');
  expect(await call('validate_changes', { changes })).toMatchObject({ canApply: expected.canApply, validationId: null, budget: expected.budget, issues: expected.issues });
  expect(expected.canApply).toBe(false);
  expect(expected.issues).toContainEqual(expect.objectContaining({ code }));
});

test('合法變更僅驗證、不寫入；locked remove與requirements繞路都阻擋', async () => {
  const snapshot = makeSnapshot(); snapshot.entries[0].locked = true;
  const before = structuredClone(snapshot); const { call } = setup(snapshot);
  expect(await call('validate_changes', { changes: [{ kind: 'remove', entryId: 'transfer' }] })).toMatchObject({ canApply: true, budget: { knownMinor: 400000 },
    currency: 'TWD', unit: 'minor', priceDisclosure: { containsDemo: true } });
  for (const changes of [[{ kind: 'remove', entryId: 'stay' }],
    [{ kind: 'requirements', value: { ...snapshot.requirements, startDate: '2026-10-01' } }]]) {
    expect(await call('validate_changes', { changes })).toMatchObject({ canApply: false, validationId: null,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'LOCKED_ENTRY' })]) });
  }
  expect(snapshot).toEqual(before);
  expect(await call('calculate_budget')).toMatchObject({ knownMinor: 430000 });
});

test('add/replace只解析server catalog且跨目的地不允許；不擅自補歷史項目', async () => {
  const snapshot = makeSnapshot();
  const replacement = { ...structuredClone(snapshot.entries[1].item), id: 'new', price: { ...snapshot.entries[1].item.price, unitMinor: 70000 } };
  const { call } = setup(snapshot, [...snapshot.entries.map(e => e.item), replacement]);
  expect(await call('validate_changes', { changes: [{ kind: 'replace', entryId: 'tour', catalogId: 'new' }] })).toMatchObject({ canApply: true, budget: { knownMinor: 470000 } });
  const foreign = { ...replacement, destinationId: 'kenting' as const };
  expect(await setup(snapshot, [...snapshot.entries.map(e => e.item), foreign]).call('validate_changes', { changes: [{ kind: 'replace', entryId: 'tour', catalogId: 'new' }] })).toMatchObject({ canApply: false,
    issues: expect.arrayContaining([expect.objectContaining({ code: 'DESTINATION_MISMATCH' })]) });
  const changes: Change[] = [{ kind: 'replace', entryId: 'tour', catalogId: 'new' }];
  const expected = buildProposal(snapshot, changes, [replacement], 'agent');
  expect(await setup(snapshot, [replacement]).call('validate_changes', { changes })).toMatchObject({ canApply: expected.canApply, budget: expected.budget, issues: expected.issues });
  expect(expected.issues).toContainEqual(expect.objectContaining({ code: 'CATALOG_NOT_FOUND' }));
});

test('目錄輸出有項數與bytes界線，來源超長明示省略而不截斷引用', async () => {
  const snapshot = makeSnapshot();
  const catalog = Array.from({ length: 50 }, (_, i) => ({ ...structuredClone(snapshot.entries[1].item), id: `item-${i}` }));
  catalog[0].sources[0].label = `DEMO ${'字'.repeat(10_000)}`;
  const { call } = setup(snapshot, catalog);
  const output = await call('find_items', { destinationId: 'xiaoliuqiu' }) as { items: CatalogItem[]; total: number; omittedCount: number };
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES);
  expect(output.items.length).toBeLessThanOrEqual(TOOL_ITEMS_LIMIT);
  expect(output.total).toBe(50); expect(output.omittedCount).toBe(50 - output.items.length);
  expect(output.items.find(item => item.id === 'item-0')).toBeUndefined();
  expect(output.items[0].sources[0].label).toBe(catalog[1].sources[0].label);
});

test('過長完整結果fail closed，不把省略issues的結果當canApply；context有界', async () => {
  const snapshot = makeSnapshot(); snapshot.exclusions = ['字'.repeat(6000)];
  expect(await setup(snapshot).call('calculate_budget')).toEqual({ error: 'TOOL_OUTPUT_TOO_LARGE' });
  const entries = Array.from({ length: 101 }, (_, i) => ({ ...structuredClone(makeSnapshot().entries[1]), id: `locked-${i}`, locked: true }));
  const crowded: Snapshot = { ...makeSnapshot(), entries };
  expect(await setup(crowded, [entries[0].item]).call('validate_changes', { changes: [{ kind: 'remove', entryId: 'locked-0' }] })).toEqual({ error: 'TOOL_OUTPUT_TOO_LARGE' });
  expect(() => setup({ ...snapshot, entries: Array.from({ length: 129 }, () => snapshot.entries[0]) })).toThrow('AGENT_TOOL_CONTEXT_TOO_LARGE');
});
