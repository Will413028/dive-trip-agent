import { z } from 'zod';

/** The consumed first probe has exactly one immutable replay sidecar. */
export function probeReplayFromReport(input: unknown) {
  try {
    const row = z.object({ replays: z.tuple([z.strictObject({
      file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
      runId: z.uuid(), recordedResume: z.literal(false),
    })]) }).parse(input).replays[0];
    if (row.file !== `cloudflare-probe-${row.runId}.replay.json`) throw new Error();
    return row;
  } catch { throw new Error('CLOUDFLARE_PROBE_REPLAY_INVALID'); }
}
