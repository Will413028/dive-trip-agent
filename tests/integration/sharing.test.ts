import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createSession } from '../../src/server/session';
import { createTrip } from '../../src/server/trip-store';
import { database } from '../../src/server/db';
import { createShare, getSharePreview, hashPreview, listShares, previewShare, readShare, revokeShare } from '../../src/server/share-store';
import { handleRequest } from '../../src/server/http';
import { withDatabase } from '../support/database';
import { makeSnapshot } from '../support/domain-fixtures';
import { applyProposal, saveProposal } from '../../src/server/version-store';
import { buildProposal } from '../../src/domain/proposal';

test('fixed public snapshot, hashed token, owner-only revoke and no raw token in listing', () => withDatabase(async () => {
  const owner = await createSession(), other = await createSession();
  const trip = await createTrip(owner.id, makeSnapshot());
  const preview = await getSharePreview(owner.id, trip.id, 1);
  const share = await createShare(owner.id, trip.id, 1, preview.previewHash);
  expect(share.token).toMatch(/^[a-f0-9]{64}$/);
  expect(await readShare(share.token)).toEqual(preview.preview);
  expect(JSON.stringify((await database().query('SELECT * FROM trip_shares')).rows)).not.toContain(share.token);
  expect(JSON.stringify(await listShares(owner.id, trip.id))).not.toContain(share.token);
  await expect(revokeShare(other.id, trip.id, share.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(getSharePreview(other.id, trip.id, 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  // A new immutable trip version cannot silently publish its new snapshot.
  const draft = buildProposal(trip.snapshot, [{ kind: 'remove', entryId: 'transfer' }], trip.snapshot.entries.map(e => e.item), 'user');
  const proposalId = await saveProposal(owner.id, trip.id, 1, draft);
  const updated = await applyProposal(owner.id, { tripId: trip.id, baseVersion: 1, proposalId, requestId: randomUUID() });
  expect(updated.snapshot.entries).toHaveLength(2);
  expect(await readShare(share.token)).toEqual(preview.preview);
  await expect(createShare(owner.id, trip.id, 1, preview.previewHash)).rejects.toMatchObject({ code: 'STALE_VERSION' });
  await revokeShare(owner.id, trip.id, share.id);
  await revokeShare(owner.id, trip.id, share.id);
  expect(await readShare(share.token)).toBeNull();
  expect(await readShare('bad-token')).toBeNull();
}));
test('preview mismatch does not publish; TTL is bounded by both owner and trip and never extended by GET', () => withDatabase(async () => {
  const owner = await createSession(), trip = await createTrip(owner.id, makeSnapshot());
  await expect(createShare(owner.id, trip.id, 1, 'a'.repeat(64))).rejects.toMatchObject({ code: 'SHARE_PREVIEW_CHANGED' });
  expect((await database().query('SELECT * FROM trip_shares')).rowCount).toBe(0);
  const share = await createShare(owner.id, trip.id, 1, hashPreview(previewShare(trip)));
  const before = (await database().query('SELECT expires_at FROM trip_shares WHERE id=$1', [share.id])).rows[0];
  await readShare(share.token); await readShare(share.token);
  expect((await database().query('SELECT expires_at FROM trip_shares WHERE id=$1', [share.id])).rows[0]).toEqual(before);
  await database().query('UPDATE sessions SET expires_at=clock_timestamp() WHERE id=$1', [owner.id]);
  expect(await readShare(share.token)).toBeNull();
  await expect(createShare(owner.id, trip.id, 1, hashPreview(previewShare(trip)))).rejects.toMatchObject({ code: 'NOT_FOUND' });
}));
test('share expiry and trip expiry are enforced on every anonymous read', () => withDatabase(async () => {
  const owner = await createSession(), trip = await createTrip(owner.id, makeSnapshot());
  const a = await createShare(owner.id, trip.id, 1, hashPreview(previewShare(trip)));
  const b = await createShare(owner.id, trip.id, 1, hashPreview(previewShare(trip)));
  await database().query('UPDATE trip_shares SET expires_at=clock_timestamp() WHERE id=$1', [a.id]);
  expect(await readShare(a.token)).toBeNull(); expect(await readShare(b.token)).not.toBeNull();
  await database().query('UPDATE trips SET expires_at=clock_timestamp() WHERE id=$1', [trip.id]);
  expect(await readShare(b.token)).toBeNull();
}));
test('share HTTP rejects arbitrary JSON, preserves CSRF, supports anonymous no-store/noindex reads', () => withDatabase(async () => {
  const origin = 'http://127.0.0.1:4318';
  const owner = await createSession(), trip = await createTrip(owner.id, makeSnapshot());
  const req = (path: string, body?: unknown, authenticated = true) => new Request(`${origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json',
      ...(authenticated ? { cookie: `dive_trip_session=${owner.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const preview = await (await handleRequest(req(`/trips/${trip.id}/shares/preview`, { version: 1 }))).json();
  expect((await handleRequest(req(`/trips/${trip.id}/shares`, { version: 1, previewHash: preview.previewHash, snapshot: {} }))).status).toBe(400);
  const forged = req(`/trips/${trip.id}/shares`, { version: 1, previewHash: preview.previewHash }); forged.headers.set('origin', 'https://evil.example');
  expect((await handleRequest(forged)).status).toBe(400);
  const created = await (await handleRequest(req(`/trips/${trip.id}/shares`, { version: 1, previewHash: preview.previewHash }))).json();
  const response = await handleRequest(req(`/shares/${created.token}`, undefined, false));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-robots-tag')).toContain('noindex'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await response.json()).toEqual(preview.preview);
  expect((await database().query('SELECT * FROM trip_shares')).rowCount).toBe(1);
  expect((await handleRequest(req(`/trips/${trip.id}/shares/${created.id}/revoke`, {}))).status).toBe(200);
  expect((await handleRequest(req(`/shares/${created.token}`, undefined, false))).status).toBe(404);
}));
