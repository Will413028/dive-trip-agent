import { expect, test, vi } from 'vitest';
import { App, BaseLlm, FunctionTool, InMemorySessionService, LlmAgent, Runner,
  type BaseLlmConnection, type LlmResponse } from '@google/adk';
import { z } from 'zod';
import { toolArgumentDiagnostic, toolArgumentErrorCode } from '../../src/agent/tool-diagnostic';
import { agentToolParameters } from '../../src/agent/tool-schemas';
import { GuardedModel } from '../../src/agent/model-guard';
import { publicAgentErrorCode } from '../../src/server/agent-error';

test('diagnostic retains only bounded allowlisted metadata, never keys, values or messages', () => {
  const parsed = z.record(z.string(), z.number()).safeParse({ private_key_marker: 'private_value_marker' });
  expect(parsed.success).toBe(false);
  const encoded = toolArgumentDiagnostic('find_items', parsed.error!.issues);
  expect(JSON.parse(encoded).issues).toEqual([{ code: 'invalid_type', path: ['?'] }]);
  expect(encoded).not.toContain('private_');
  expect(toolArgumentErrorCode(encoded)).toBe('AGENT_TOOL_ARGUMENTS');
  expect(publicAgentErrorCode(new Error(encoded))).toBe('AGENT_INTERRUPTED');
  expect(publicAgentErrorCode(new Error(toolArgumentErrorCode(encoded)))).toBe('AGENT_TOOL_ARGUMENTS');
  for (const input of [encoded + 'private', '{', undefined, 'AGENT_TOOL_ARGUMENTS private',
    JSON.stringify({ ...JSON.parse(encoded), secret: 'private' }),
    encoded.replace('find_items', 'unknown'), encoded.replace('invalid_type', 'unknown'),
    encoded.replace('"?"', '"private"'), 'x'.repeat(2049)]) expect(toolArgumentErrorCode(input)).toBeUndefined();
});

test('strict and nested union errors stay bounded and omit rejected extra keys', () => {
  const result = agentToolParameters.validate_changes.safeParse({ changes: Array.from({ length: 100 }, () => ({
    kind: 'move', entryId: 'private_value_marker', day: 'private_value_marker', slot: 'private_value_marker',
    private_key_marker: 'private_value_marker',
  })) });
  const encoded = toolArgumentDiagnostic('validate_changes', result.error!.issues);
  expect(encoded).not.toContain('private_');
  expect(encoded.length).toBeLessThanOrEqual(2048);
  expect(JSON.parse(encoded).issues.length).toBeLessThanOrEqual(8);
  expect(toolArgumentErrorCode(encoded)).toBe('AGENT_TOOL_ARGUMENTS');
});

test('union diagnostics retain parent paths and prioritize the closest alternatives', () => {
  const result = agentToolParameters.validate_changes.safeParse({ changes: [
    { kind: 'move', entryId: 'synthetic', day: 'bad', slot: 'morning' },
  ] });
  const encoded = toolArgumentDiagnostic('validate_changes', result.error!.issues);
  expect(JSON.parse(encoded).issues.slice(0, 2)).toEqual([
    { code: 'invalid_union', path: ['changes', '*'] },
    { code: 'invalid_type', path: ['changes', '*', 'day'] },
  ]);
});

test('nested unions compose relative paths and deep paths are truncated', () => {
  const nested = z.object({ changes: z.array(z.union([
    z.object({ entry: z.union([z.object({ day: z.number() }), z.object({ rooms: z.number() })]) }),
    z.number(),
  ])) }).safeParse({ changes: [{ entry: { day: 'bad', rooms: 'bad' } }] });
  const issues = JSON.parse(toolArgumentDiagnostic('propose_changes', nested.error!.issues)).issues;
  expect(issues).toContainEqual({ code: 'invalid_type', path: ['changes', '*', 'entry', 'day'] });
  const encoded = toolArgumentDiagnostic('find_items', [{ code: 'custom', message: 'private',
    path: [...Array(20).fill('entry'), 'private'] }]);
  expect(JSON.parse(encoded).issues[0].path).toEqual(Array(8).fill('entry'));
  expect(encoded).not.toContain('private');
});

test('proposal reference diagnostics identify only the allowlisted field, never the rejected ID', () => {
  const parsed = agentToolParameters.propose_changes.safeParse({ validationId: 'private_value_marker' });
  const encoded = toolArgumentDiagnostic('propose_changes', parsed.error!.issues);
  expect(JSON.parse(encoded).issues).toEqual([{ code: 'invalid_format', path: ['validationId'] }]);
  expect(encoded).not.toContain('private_value_marker');
  expect(toolArgumentErrorCode(encoded)).toBe('AGENT_TOOL_ARGUMENTS');
});

test('union recursion stops at depth three independently of the issue count cap', () => {
  let issue: z.core.$ZodIssue = { code: 'custom', path: ['day'], message: 'private_leaf' };
  for (let depth = 0; depth < 5; depth++) issue = {
    code: 'invalid_union', path: ['entry'], message: 'private_union', errors: [[issue]],
  };
  const encoded = toolArgumentDiagnostic('propose_changes', [issue]);
  const issues = JSON.parse(encoded).issues;
  expect(issues).toHaveLength(4);
  expect(issues.every((item: { code: string }) => item.code === 'invalid_union')).toBe(true);
  expect(issues.at(-1).path).toEqual(Array(4).fill('entry'));
  expect(encoded).not.toMatch(/private|custom|day/);
});

test('native ADK persists safe diagnostic without executing or persisting rejected candidate', async () => {
  class InvalidModel extends BaseLlm {
    constructor() { super({ model: 'offline-diagnostic' }); }
    async *generateContentAsync(): AsyncGenerator<LlmResponse> {
      yield { content: { role: 'model', parts: [{ functionCall: { name: 'find_items',
        args: { destinationId: 'private_value_marker', private_key_marker: 'private_value_marker' } } }] } };
    }
    async connect(): Promise<BaseLlmConnection> { throw new Error('offline'); }
  }
  const sessions = new InMemorySessionService();
  const identity = { appName: 'diagnostic_test', userId: 'synthetic', sessionId: 'synthetic' };
  await sessions.createSession(identity);
  const execute = vi.fn(() => ({}));
  const runner = new Runner({ app: new App({ name: identity.appName, rootAgent: new LlmAgent({ name: 'agent',
    model: new GuardedModel(new InvalidModel()), tools: [new FunctionTool({ name: 'find_items',
      description: 'offline', parameters: agentToolParameters.find_items, execute })] }) }), sessionService: sessions });
  const errors: string[] = [];
  for await (const event of runner.runAsync({ userId: identity.userId, sessionId: identity.sessionId,
    newMessage: { role: 'user', parts: [{ text: 'synthetic' }] } })) {
    if (event.errorCode) errors.push(event.errorMessage!);
  }
  expect(execute).not.toHaveBeenCalled();
  expect(errors).toHaveLength(1);
  expect(toolArgumentErrorCode(errors[0])).toBe('AGENT_TOOL_ARGUMENTS');
  expect(JSON.parse(errors[0]).issues).toContainEqual({ code: 'invalid_value', path: ['destinationId'] });
  const saved = await sessions.getSession(identity);
  expect(saved?.events.some(event => event.errorMessage === errors[0])).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('private_');
  expect(saved?.events.flatMap(event => event.content?.parts ?? []).some(part => part.functionCall)).toBe(false);
});
