/** Version-one TWD display, using integers only (also safe near MAX_SAFE_INTEGER). */
export function formatTwd(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error('AGENT_INVALID_MONEY');
  const value = BigInt(minor);
  return `TWD ${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
