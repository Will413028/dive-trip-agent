import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { DomainError } from '../domain/errors';

function canonicalIp(address: string): string {
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6 || address.includes('%')) throw new DomainError('UNTRUSTED_CLIENT_IP');
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  // A dual-stack socket may report IPv4 in mapped IPv6 form.
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}
const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
function day(now: Date): string {
  const parts = calendar.formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}

/** Request headers are intentionally ignored. verifiedPeerAddress must come from
 * the hosting transport / a separately reviewed trusted ingress, NOT Request URL,
 * X-Forwarded-For, Forwarded, X-Real-IP, or a caller-controlled JSON field.
 * The current Next localhost launcher does not provide this proof, so live stays off.
 * No file/environment reads, no persistent raw IP or hashing key.
 */
export function quotaIpKeys(_request: Request, verifiedPeerAddress: string | undefined,
  hashingKey: Uint8Array, now: Date): { ipKey: string; previousIpKey?: string } {
  if (!verifiedPeerAddress || hashingKey.byteLength < 32 || !Number.isFinite(now.getTime())) {
    throw new DomainError('UNTRUSTED_CLIENT_IP');
  }
  const address = canonicalIp(verifiedPeerAddress);
  const currentDay = day(now), priorMinuteDay = day(new Date(now.getTime() - 60_000));
  const hash = (date: string) => {
    const dailySalt = createHmac('sha256', hashingKey).update(`dive-trip-ip:${date}`).digest();
    return createHmac('sha256', dailySalt).update(address).digest('hex');
  };
  return { ipKey: hash(currentDay), ...(currentDay === priorMinuteDay ? {} : { previousIpKey: hash(priorMinuteDay) }) };
}
