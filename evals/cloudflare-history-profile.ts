import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVATE_HISTORY_SHA256, PUBLIC_HISTORY } from './cloudflare-history-public.ts';
import { cloudflareHistoryProfileSchema, type CloudflareHistoryIdentities,
  type CloudflareHistoryKey } from './cloudflare-history-contract.ts';
import { withBoundedArtifactDirectory, type BoundedArtifactDirectorySnapshot,
  type BoundedArtifactFileSnapshot } from './bounded-artifact-file.ts';

type Identities = CloudflareHistoryIdentities;
type Snapshot = Readonly<{
  directories: BoundedArtifactDirectorySnapshot;
  file: BoundedArtifactFileSnapshot;
  digest: string;
  profile: Readonly<{ schemaVersion: 1; identities: Identities }>;
}>;
type PrivateContext = { snapshot: Snapshot; active: boolean };

// Computing these paths and importing this module performs no filesystem IO.
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const directoryPath = join(root, '.artifacts');
const profileName = 'cloudflare-history-identities.json';
const maxBytes = 64 * 1024;
const publicHistory = Object.freeze({ ...PUBLIC_HISTORY });
const contexts = new AsyncLocalStorage<PrivateContext>();

function fail(): never { throw new Error('EVAL_PRIVATE_HISTORY_INVALID'); }

function assertLocal(): void {
  if (Object.hasOwn(process.env, 'CI') || Object.hasOwn(process.env, 'GITHUB_ACTIONS')) fail();
}

function parseProfile(bytes: Buffer): Snapshot['profile'] {
  const parsed = cloudflareHistoryProfileSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  // Both objects are frozen: the schema is flat and every leaf is a string.
  return Object.freeze({ schemaVersion: 1, identities: Object.freeze(parsed.identities) });
}

async function readPrivateSnapshot(expected?: Snapshot): Promise<Snapshot> {
  try {
    assertLocal();
    if (PRIVATE_HISTORY_SHA256.length !== 64 || !/^[0-9a-f]{64}$/.test(PRIVATE_HISTORY_SHA256)) fail();
    return await withBoundedArtifactDirectory([root, directoryPath], async directory => {
      const { bytes, snapshot: file } = await directory.read(profileName, { minBytes: 1, maxBytes }, expected?.file);
      assertLocal();
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== PRIVATE_HISTORY_SHA256 || (expected && digest !== expected.digest)) fail();
      return Object.freeze({ directories: directory.snapshot, file, digest, profile: parseProfile(bytes) });
    }, expected?.directories);
  } catch { return fail(); }
}

/** Fixture/default lookup is pure; private identities never become process globals. */
export function historyIdentity(key: CloudflareHistoryKey): string {
  if (typeof key !== 'string' || !Object.hasOwn(publicHistory, key)) fail();
  const context = contexts.getStore();
  if (!context) return publicHistory[key];
  if (!context.active) fail();
  return context.snapshot.profile.identities[key];
}

/** Loading identities is not authorization. Live entrypoints must authorize first,
 * then enter this scope before any claim, DB access or credential loading. */
export async function withPrivateCloudflareHistory<T>(work: () => Promise<T>): Promise<T> {
  const snapshot = await readPrivateSnapshot();
  assertLocal();
  const context: PrivateContext = { snapshot, active: true };
  return contexts.run(context, async () => {
    try { return await work(); }
    finally { context.active = false; }
  });
}

/** Reopen the same fixed pin and require the original file and directory snapshot. */
export async function assertPrivateCloudflareHistory(): Promise<void> {
  const context = contexts.getStore();
  if (!context?.active) fail();
  await readPrivateSnapshot(context.snapshot);
  if (!context.active) fail();
}
