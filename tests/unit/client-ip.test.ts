import { expect, test } from 'vitest';
import { quotaIpKeys } from '../../src/server/client-ip';

const key = new Uint8Array(32).fill(42); // synthetic fixture, not a credential
const now = new Date('2026-09-22T01:00:00Z');
const request = (headers?: Record<string, string>) => new Request('http://localhost/', { headers });
test('偽造forwarded headers不能決定quota IP；缺transport證據不fallback', () => {
  const forged = request({ 'X-Forwarded-For': '203.0.113.20', Forwarded: 'for=203.0.113.21', 'X-Real-IP': '203.0.113.22' });
  expect(() => quotaIpKeys(forged, undefined, key, now)).toThrow('UNTRUSTED_CLIENT_IP');
  expect(quotaIpKeys(forged, '192.0.2.1', key, now)).toEqual(quotaIpKeys(request(), '192.0.2.1', key, now));
});
test('同IP等價IPv6表示與IPv4-mapped形式不可換額度桶', () => {
  expect(quotaIpKeys(request(), '2001:0DB8:0000:0:0:0:0:0001', key, now))
    .toEqual(quotaIpKeys(request(), '2001:db8::1', key, now));
  expect(quotaIpKeys(request(), '::ffff:192.0.2.1', key, now)).toEqual(quotaIpKeys(request(), '192.0.2.1', key, now));
});
test('Taipei午夜輪salt並攜帶前一日digest保護rolling minute，不保存raw IP', () => {
  const before = quotaIpKeys(request(), '192.0.2.1', key, new Date('2026-09-22T15:59:59Z'));
  const after = quotaIpKeys(request(), '192.0.2.1', key, new Date('2026-09-22T16:00:01Z'));
  expect(after.previousIpKey).toBe(before.ipKey);
  expect(after.ipKey).not.toBe(before.ipKey);
  expect(after.ipKey).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(after)).not.toContain('192.0.2.1');
  expect(quotaIpKeys(request(), '192.0.2.1', key, new Date('2026-09-22T16:01:00Z')).previousIpKey).toBeUndefined();
});
test.each(['unknown', '192.0.2.1, 192.0.2.2', '[::1]', 'fe80::1%en0', '192.0.2.1:80'])('非法transport address %s拒絕', address => {
  expect(() => quotaIpKeys(request(), address, key, now)).toThrow('UNTRUSTED_CLIENT_IP');
});
