import { handleRequest } from '../../../server/http';
import { FIXTURE_AGENT_CONTEXT } from '../../../server/agent-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request): Promise<Response> {
  // Next may normalize Request.url to an internal host. Do not trust Host or
  // X-Forwarded-* for CSRF or Secure cookies: use an explicit public origin.
  const origin = process.env.APP_ORIGIN;
  if (!origin || process.env.DIVE_LOCAL_LIVE !== undefined) {
    return Response.json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  try { return await handleRequest(request, origin, FIXTURE_AGENT_CONTEXT); }
  catch { return Response.json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
export const POST = GET;
export const DELETE = GET;
