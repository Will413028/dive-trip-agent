import { randomUUID } from 'node:crypto';
import { open, rename, unlink, type FileHandle } from 'node:fs/promises';

/** Immutable evidence boundary. Existing bytes are never overwritten; a failed
 * write leaves its claimed path in place and must stop the owning campaign. */
export async function writeImmutableCheckpoint(path: string, value: string) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(value, 'utf8'); await file.sync(); }
  finally { await file.close(); }
}

/** Same-directory atomic replacement. A failed write never truncates the last checkpoint.
 * Hooks exist only for offline filesystem fault injection; never exposed over HTTP.
 */
export async function writeAtomicCheckpoint(path: string, value: string, hooks: {
  write?: (handle: FileHandle, value: string) => Promise<void>;
  replace?: typeof rename;
} = {}) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  let closed = false;
  try {
    await (hooks.write ?? ((handle, text) => handle.writeFile(text, 'utf8')))(file, value);
    await file.sync();
    await file.close(); closed = true;
    await (hooks.replace ?? rename)(temporary, path);
  } finally {
    if (!closed) await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined); // Only this invocation's owned temp.
  }
}
