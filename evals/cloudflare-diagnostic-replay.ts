import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();

/** The stopped diagnostic report names exactly one immutable replay sidecar. */
export function diagnosticReplayFromReport(input: unknown) {
  try {
    const row = z.object({ replays: z.tuple([z.strictObject({
      file: z.string(), sha256: digest, runId: uuid, recordedResume: z.literal(false),
    })]) }).parse(input).replays[0];
    if (row.file !== `cloudflare-diagnostic-${row.runId}.replay.json`) throw new Error();
    return row;
  } catch { throw new Error('CLOUDFLARE_DIAGNOSTIC_REPLAY_INVALID'); }
}
