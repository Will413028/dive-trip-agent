import { quotaIpKeys } from '../../src/server/client-ip.ts';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const dates = JSON.parse(input);
const key = new Uint8Array(32).fill(97);
process.stdout.write(JSON.stringify(dates.map(date => quotaIpKeys(
  new Request('http://localhost', { headers: { 'X-Forwarded-For': '203.0.113.99' } }),
  '127.0.0.1', key, new Date(date),
))));
