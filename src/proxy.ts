import { NextResponse, type NextRequest } from 'next/server';
import { hostedConfig, hostedFailure, ingressBody, ingressEnvelope, requestTarget, verifyIngress } from './server/hosted';

export async function proxy(request: NextRequest): Promise<Response> {
  try {
    const config = hostedConfig();
    if (!config) return NextResponse.next();
    ingressEnvelope(request.headers);
    const target = requestTarget(request);
    verifyIngress(config, request.method, target, request.headers, await ingressBody(request.clone()));
    const headers = new Headers(request.headers);
    // Derived from the verified URL for Server Components, never caller authority.
    headers.set('x-dive-target', target);
    for (const name of ['authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
      'x-forwarded-proto', 'cf-connecting-ip']) headers.delete(name);
    return NextResponse.next({ request: { headers } });
  } catch (error) { return hostedFailure(error); }
}
