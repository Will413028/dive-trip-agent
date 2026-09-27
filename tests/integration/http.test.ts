import { expect, test } from 'vitest';
import { withDatabase } from '../support/database';
import { handleRequest } from '../../src/server/http';
import { database } from '../../src/server/db';
import { withAdkSchemaLock } from '../../src/server/adk-schema-lock';
import { createSession } from '../../src/server/session';

const origin = 'http://127.0.0.1:4318';
function request(path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function demo() {
  const response = await handleRequest(request('/demo', { scenario: 'normal' }));
  expect(response.status).toBe(200);
  return { trip: await response.json(), cookie: response.headers.get('set-cookie')!.split(';')[0] };
}

test('HTTP 提案確認前不變更，接受後刷新一致，private responses no-store', () => withDatabase(async () => {
  const { trip, cookie } = await demo();
  const proposal = await handleRequest(request(`/trips/${trip.id}/proposals`, { baseVersion: 1, changes: [{ kind: 'remove', entryId: 'transfer' }] }, cookie));
  expect(proposal.status).toBe(200);
  const { proposalId } = await proposal.json();
  const before = await handleRequest(request(`/trips/${trip.id}`, undefined, cookie));
  expect((await before.json()).version).toBe(1);
  const input = { baseVersion: 1, proposalId, requestId: 'http-apply' };
  const applied = await handleRequest(request(`/trips/${trip.id}/apply`, input, cookie));
  expect(applied.status).toBe(200);
  const result = await applied.json();
  expect(result.version).toBe(2);
  expect(result.snapshot.entries.some((e: { id: string }) => e.id === 'transfer')).toBe(false);
  const read = await handleRequest(request(`/trips/${trip.id}`, undefined, cookie));
  expect(await read.json()).toEqual(result);
  expect(read.headers.get('cache-control')).toBe('no-store');
  expect(await (await handleRequest(request(`/trips/${trip.id}/apply`, input, cookie))).json()).toEqual(result);
}));

test('cookie HttpOnly、SameSite、HTTPS Secure，不回 token 到JSON', () => withDatabase(async () => {
  const response = await handleRequest(new Request('https://demo.example/api/session', {
    method: 'POST', headers: { origin: 'https://demo.example', 'content-type': 'application/json' }, body: '{}',
  }));
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
  expect(response.headers.get('set-cookie')).toContain('Secure');
  expect(await response.json()).toEqual({ ok: true });
}));

test('框架內部URL不同時仍以設定的公開origin驗證，Secure不採forwarded header', () => withDatabase(async () => {
  const response = await handleRequest(new Request('http://internal:3000/api/session', {
    method: 'POST', headers: { origin: 'https://demo.example', 'content-type': 'application/json', 'x-forwarded-proto': 'http' }, body: '{}',
  }), 'https://demo.example');
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('Secure');
  const forged = await handleRequest(new Request('http://internal:3000/api/session', {
    method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json', 'x-forwarded-host': 'evil.example' }, body: '{}',
  }), 'https://demo.example');
  expect(forged.status).toBe(400);
}));

test('其他session、沒有cookie、不存在行程統一404', () => withDatabase(async () => {
  const a = await demo(); const b = await demo();
  const read = await handleRequest(request(`/trips/${a.trip.id}`, undefined, b.cookie));
  expect(read.status).toBe(404); expect(await read.json()).toEqual({ error: 'NOT_FOUND' });
  expect((await handleRequest(request(`/trips/${a.trip.id}`))).status).toBe(404);
  expect((await handleRequest(request('/trips/not-a-uuid', undefined, a.cookie))).status).toBe(404);
  expect((await handleRequest(request(`/trips/${a.trip.id}/proposals`, { baseVersion: 1, changes: [] }, b.cookie))).status).toBe(404);
}));

test.each([
  [{ origin: 'https://evil.example' }, 'INVALID_ORIGIN'],
  [{ origin: 'null' }, 'INVALID_ORIGIN'],
  [{ origin: '' }, 'INVALID_ORIGIN'],
  [{ 'content-type': 'text/plain' }, 'INVALID_CONTENT_TYPE'],
])('mutation 邊界拒絕 %j', (headers, code) => withDatabase(async () => {
  const response = await handleRequest(request('/demo', { scenario: 'normal' }, undefined, headers));
  expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: code });
  expect((await database().query('SELECT * FROM sessions')).rowCount).toBe(0);
}));

test('真實body bytes超32KB、無效JSON都拒絕且不回stack', () => withDatabase(async () => {
  const huge = await handleRequest(request('/demo', { text: '漢'.repeat(12000) }));
  expect(huge.status).toBe(400); expect(await huge.json()).toEqual({ error: 'BODY_TOO_LARGE' });
  const malformed = await handleRequest(new Request(`${origin}/api/demo`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{' }));
  expect(malformed.status).toBe(400); expect(await malformed.json()).toEqual({ error: 'INVALID_BODY' });
}));

test.each([
  { actor: 'user', changes: [] }, { ownerId: 'other', changes: [] },
  { changes: [{ kind: 'remove', entryId: 'tour', actor: 'user' }] },
  { snapshot: {}, changes: [] }, { budget: 0, changes: [] },
])('禁止client傳actor、owner、snapshot、總價與extra欄位 %j', extra => withDatabase(async () => {
  const { trip, cookie } = await demo();
  const response = await handleRequest(request(`/trips/${trip.id}/proposals`, { baseVersion: 1, ...extra }, cookie));
  expect(response.status).toBe(400);
}));

test('HTTP過期版本409，blocked提案可顯示但不得套用', () => withDatabase(async () => {
  const { trip, cookie } = await demo();
  const stale = await handleRequest(request(`/trips/${trip.id}/proposals`, { baseVersion: 2, changes: [] }, cookie));
  expect(stale.status).toBe(409);
  const blocked = await handleRequest(request(`/trips/${trip.id}/proposals`, { baseVersion: 1, changes: [{ kind: 'requirements', value: { ...trip.snapshot.requirements, budgetMinor: 100 } }] }, cookie));
  expect(blocked.status).toBe(200);
  const proposal = await blocked.json(); expect(proposal.draft.canApply).toBe(false);
  const apply = await handleRequest(request(`/trips/${trip.id}/apply`, { baseVersion: 1, proposalId: proposal.proposalId, requestId: 'blocked' }, cookie));
  expect(apply.status).toBe(400);
}));

test('批次途中引用的目錄也保存，新增再移除仍可重新驗證', () => withDatabase(async () => {
  const { trip, cookie } = await demo();
  const response = await handleRequest(request(`/trips/${trip.id}/proposals`, {
    baseVersion: 1, changes: [
      { kind: 'add', entry: { id: 'temporary-dive', catalogId: 'dive', day: 3, slot: 'morning', rooms: null, endDay: null } },
      { kind: 'remove', entryId: 'temporary-dive' },
      { kind: 'remove', entryId: 'transfer' },
    ],
  }, cookie));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.draft.canApply).toBe(true);
  const applied = await handleRequest(request(`/trips/${trip.id}/apply`, { baseVersion: 1, proposalId: result.proposalId, requestId: 'batch-catalog' }, cookie));
  expect(applied.status).toBe(200);
  expect((await applied.json()).snapshot.entries.map((e: { id: string }) => e.id)).toEqual(['stay', 'tour']);
}));

test('刪除／無法讀取DB時只回503，不洩漏SQL', () => withDatabase(async () => {
  const session = await createSession();
  const client = await database().connect();
  try { await withAdkSchemaLock(client, () => client.query('ALTER TABLE sessions RENAME TO temporarily_unavailable')); }
  finally { client.release(); }
  const response = await handleRequest(request('/trips/absent', undefined, `dive_trip_session=${session.token}`));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'SERVICE_UNAVAILABLE' });
}));
