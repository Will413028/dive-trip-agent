import { z } from 'zod';
import { FIXTURE_AGENT_CONTEXT, type AgentServerContext } from './agent-policy';
import { DomainError } from '../domain/errors';
import { buildProposal } from '../domain/proposal';
import { parseRequirements } from '../domain/schemas';
import type { Change } from '../domain/types';
import { catalog, createDemo, demoScenarios } from './demo';
import { createSession, resolveSession } from './session';
import { createTrip, getTrip } from './trip-store';
import { applyProposal, rejectProposal, restoreVersion, saveProposal } from './version-store';
import { createShare, getSharePreview, listShares, readShare, revokeShare } from './share-store';
import { deleteTrip } from './retention';

const cookieName = 'dive_trip_session';
const maxBodyBytes = 32 * 1024;
const positiveVersion = z.number().int().positive().max(2147483647);
const requestId = z.string().min(1).max(128).refine(value => value.trim().length > 0);

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function json(value: unknown, status = 200, cookie?: string): Response {
  return Response.json(value, {
    status, headers: {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', ...(cookie ? { 'Set-Cookie': cookie } : {}),
    },
  });
}

function cookieFor(token: string, applicationOrigin: string): string {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${new URL(applicationOrigin).protocol === 'https:' ? '; Secure' : ''}`;
}

async function ownerOf(request: Request): Promise<string | null> {
  const values = (request.headers.get('cookie') ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith(`${cookieName}=`));
  // Reject duplicate credentials rather than choosing different cookies at different layers.
  if (values.length !== 1) return null;
  return resolveSession(values[0].slice(cookieName.length + 1));
}

async function bodyOf(request: Request, applicationOrigin: string): Promise<unknown> {
  if (request.headers.get('origin') !== applicationOrigin) throw new HttpError(400, 'INVALID_ORIGIN');
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(400, 'INVALID_CONTENT_TYPE');
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBodyBytes)) throw new HttpError(400, 'BODY_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_BODY');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBodyBytes) { await reader.cancel(); throw new HttpError(400, 'BODY_TOO_LARGE'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'INVALID_BODY'); }
}

export async function handleRequest(request: Request, applicationOrigin = new URL(request.url).origin,
  agentContext: AgentServerContext = FIXTURE_AGENT_CONTEXT): Promise<Response> {
  try {
    const parts = new URL(request.url).pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api') throw new HttpError(404, 'NOT_FOUND');
    const path = parts.slice(1);
    if (request.method === 'DELETE') {
      if (path.length !== 2 || path[0] !== 'trips') throw new HttpError(404, 'NOT_FOUND');
      z.strictObject({}).parse(await bodyOf(request, applicationOrigin));
      const owner = await ownerOf(request);
      if (!owner) throw new HttpError(404, 'NOT_FOUND');
      await deleteTrip(owner, path[1]);
      return json({ ok: true });
    }
    const mutation = request.method === 'POST';
    if (!mutation && request.method !== 'GET') throw new HttpError(404, 'NOT_FOUND');
    const body = mutation ? await bodyOf(request, applicationOrigin) : undefined;
    if (path.length === 1 && path[0] === 'agent-mode' && !mutation) {
      return json({ mode: agentContext.provider === 'fixture' ? 'fixture' : agentContext.provider });
    }
    if (path.length === 1 && path[0] === 'catalog' && !mutation) return json(catalog());
    if (path.length === 2 && path[0] === 'shares' && !mutation) {
      const share = await readShare(path[1]);
      const response = json(share ?? { error: 'NOT_FOUND' }, share ? 200 : 404);
      response.headers.set('X-Robots-Tag', 'noindex, nofollow');
      return response;
    }

    let owner = await ownerOf(request);
    if (path.length === 1 && (path[0] === 'session' || path[0] === 'demo') && mutation) {
      const demo = path[0] === 'demo' ? z.strictObject({ scenario: z.enum(demoScenarios) }).parse(body) : null;
      if (!demo) z.strictObject({}).parse(body);
      let cookie: string | undefined;
      if (!owner) {
        const session = await createSession(); owner = session.id; cookie = cookieFor(session.token, applicationOrigin);
      }
      return json(demo ? await createDemo(owner, demo.scenario) : { ok: true }, 200, cookie);
    }
    if (!owner) throw new HttpError(404, 'NOT_FOUND');
    if (path.length === 1 && path[0] === 'trips' && mutation) {
      const parsed = z.strictObject({ requirements: z.unknown().transform(value => parseRequirements(value)) }).parse(body);
      return json(await createTrip(owner, { requirements: parsed.requirements, entries: [], exclusions: ['往返交通、餐費與裝備費未納入'] }));
    }
    if (path[0] !== 'trips' || !path[1]) throw new HttpError(404, 'NOT_FOUND');
    const tripId = path[1];
    if (path.length === 4 && path[2] === 'shares' && path[3] === 'preview' && mutation) {
      const input = z.strictObject({ version: positiveVersion }).parse(body);
      return json(await getSharePreview(owner, tripId, input.version));
    }
    if (path.length === 3 && path[2] === 'shares') {
      if (!mutation) return json({ shares: await listShares(owner, tripId) });
      const input = z.strictObject({ version: positiveVersion, previewHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(body);
      return json(await createShare(owner, tripId, input.version, input.previewHash));
    }
    if (path.length === 5 && path[2] === 'shares' && path[4] === 'revoke' && mutation) {
      z.strictObject({}).parse(body);
      await revokeShare(owner, tripId, path[3]); return json({ ok: true });
    }
    if (path.length === 3 && path[2] === 'runs' && !mutation) {
      return await (await import('./chat-http')).chatRuns(owner, tripId);
    }
    if (path.length === 3 && path[2] === 'agent' && mutation) {
      return await (await import('./chat-http')).chatAgent(request, owner, tripId, body, agentContext);
    }
    if (path.length === 5 && path[2] === 'runs' && path[4] === 'events' && !mutation) {
      return await (await import('./chat-http')).chatReplay(owner, tripId, path[3]);
    }
    if (path.length === 2 && !mutation) {
      const trip = await getTrip(owner, tripId);
      if (!trip) throw new HttpError(404, 'NOT_FOUND');
      return json(trip);
    }
    if (path.length === 3 && path[2] === 'proposals' && mutation) {
      const parsed = z.strictObject({ baseVersion: positiveVersion, changes: z.array(z.unknown()).max(100) }).parse(body);
      const trip = await getTrip(owner, tripId);
      if (!trip) throw new HttpError(404, 'NOT_FOUND');
      if (trip.version !== parsed.baseVersion) throw new DomainError('STALE_VERSION');
      const items = catalog();
      const draft = buildProposal(trip.snapshot, parsed.changes as Change[], items, 'user');
      // Malformed changes are request errors, not persistent explanatory proposals.
      if (draft.issues.some(issue => issue.code === 'INVALID_CHANGE')) throw new HttpError(400, 'INVALID_PROPOSAL');
      return json({ proposalId: await saveProposal(owner, tripId, parsed.baseVersion, draft, items), draft });
    }
    if (path.length === 3 && path[2] === 'apply' && mutation) {
      const parsed = z.strictObject({ baseVersion: positiveVersion, proposalId: z.uuid(), requestId }).parse(body);
      return json(await applyProposal(owner, { tripId, ...parsed }));
    }
    if (path.length === 3 && path[2] === 'restore' && mutation) {
      const parsed = z.strictObject({ baseVersion: positiveVersion, targetVersion: positiveVersion, requestId }).parse(body);
      return json(await restoreVersion(owner, { tripId, ...parsed }));
    }
    if (path.length === 5 && path[2] === 'proposals' && path[4] === 'reject' && mutation) {
      z.strictObject({}).parse(body);
      await rejectProposal(owner, tripId, path[3]);
      return json({ ok: true });
    }
    throw new HttpError(404, 'NOT_FOUND');
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code }, error.status);
    if (error instanceof z.ZodError) return json({ error: 'INVALID_REQUEST' }, 400);
    if (error instanceof DomainError) {
      const status = error.code === 'NOT_FOUND' ? 404
        : ['STALE_VERSION', 'IDEMPOTENCY_CONFLICT', 'RUN_ACTIVE', 'RUN_STATE_CONFLICT', 'PROVIDER_CONFLICT',
          'ADMISSION_STATE_CONFLICT', 'ADMISSION_ACTIVE', 'MODEL_CALL_LIMIT', 'SHARE_PREVIEW_CHANGED'].includes(error.code) ? 409
        : ['QUOTA_BUDGET', 'QUOTA_CONCURRENCY', 'QUOTA_IP_MINUTE', 'QUOTA_IP_DAY', 'QUOTA_SESSION_DAY'].includes(error.code) ? 429
        : ['INVALID_PROPOSAL', 'INVALID_SNAPSHOT', 'INVALID_RUN', 'INVALID_SHARE', 'SHARE_LIMIT', 'SHARE_TOO_LARGE'].includes(error.code) ? 400 : 503;
      return json({ error: status === 503 ? 'SERVICE_UNAVAILABLE' : error.code }, status);
    }
    // Never return SQL, stack traces, cookies or provider credentials.
    return json({ error: 'SERVICE_UNAVAILABLE' }, 503);
  }
}
