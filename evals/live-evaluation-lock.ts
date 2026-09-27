import { constants } from 'node:fs';
import { open, lstat, realpath, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

declare const leaseBrand: unique symbol;
export type EvaluationLockLease = { readonly [leaseBrand]: true };
const active = new WeakMap<EvaluationLockLease, () => Promise<void>>();
function fail(): never { throw new Error('EVAL_LOCK_NOT_OWNED'); }

/** Only a currently held, same-process lease is accepted. Not a live grant. */
export async function assertEvaluationLock(lease: EvaluationLockLease) {
  const check = active.get(lease);
  if (!check) fail();
  await check();
}

/** Shared cooperative lock; never remove another invocation's/stale lock.
 * Assumes a trusted local directory, not hostile ABA filesystem replacement. */
export async function withEvaluationLock<T>(work: (lease: EvaluationLockLease) => Promise<T>): Promise<T> {
  const dir = resolve('.artifacts'), path = join(dir, 'live-evaluation.lock');
  if (await realpath(dir) !== dir) fail();
  const directory = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const directoryIdentity = await directory.stat();
    const checkDirectory = async () => {
      const current = await lstat(dir);
      if (!current.isDirectory() || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino
        || await realpath(dir) !== dir) fail();
    };
    await checkDirectory();
    const file = await open(path, 'wx', 0o600);
    const lease = Object.freeze({}) as EvaluationLockLease;
    try {
      const identity = await file.stat();
      active.set(lease, async () => {
        await checkDirectory();
        const current = await lstat(path), held = await file.stat();
        if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino
          || held.dev !== identity.dev || held.ino !== identity.ino) fail();
      });
      await file.sync();
      await assertEvaluationLock(lease);
      return await work(lease);
    } finally {
      // Refuse cleanup when identity was lost; leave evidence/foreign files alone.
      try { await assertEvaluationLock(lease); await unlink(path); }
      finally { active.delete(lease); await file.close(); }
    }
  } finally { await directory.close(); }
}
