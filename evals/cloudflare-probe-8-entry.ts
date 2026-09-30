import { runReviewedCloudflareEntry } from './cloudflare-reviewed-entry.ts';
import { runCloudflareProbe8Campaign } from './cloudflare-probe-8-campaign.ts';
import { readCloudflarePythonProbe7Carry } from './cloudflare-python-probe-7-carry.ts';
import { claimCloudflareCampaign } from './cloudflare-campaign-claim.ts';
import { CARRY_SCHEMA } from './cloudflare-carry-forward.ts';
import { SECOND_CARRY_SCHEMA } from './cloudflare-carry-forward-2.ts';
import { QUALITY_CARRY_SCHEMA } from './cloudflare-quality-carry.ts';
import { REVISION_CARRY_SCHEMA } from './cloudflare-revision-carry.ts';
import { RECOVERY_CARRY_SCHEMA } from './cloudflare-recovery-carry.ts';
import { GROUNDED_CARRY_SCHEMA } from './cloudflare-grounded-carry.ts';
import { NONTHINKING_CARRY_SCHEMA } from './cloudflare-nonthinking-carry.ts';

export const PROBE_8_AUTHORIZATION = 'probe-8-unknown-cost-once-7-calls-1-invocation-cloudflare-free-only-confirmed';

/** A separate technical scope whose prior carry includes the complete retained Python
 * execution history. The shared lifecycle keeps the claim ahead of history and secrets. */
export async function runCloudflareProbe8Entry() {
  return runReviewedCloudflareEntry({ mode: 'technical', stem: 'cloudflare-probe-8',
    liveCampaign: 'cloudflare-probe-8-one-case',
    authorizationEnv: 'DIVE_TRIP_CLOUDFLARE_PROBE_8_AUTHORIZATION', authorization: PROBE_8_AUTHORIZATION,
    schemas: () => ['workbench_live', CARRY_SCHEMA(), SECOND_CARRY_SCHEMA(), QUALITY_CARRY_SCHEMA(),
      REVISION_CARRY_SCHEMA(), RECOVERY_CARRY_SCHEMA(), GROUNDED_CARRY_SCHEMA(), NONTHINKING_CARRY_SCHEMA()],
    initialReplays: 1, claim: lease => claimCloudflareCampaign(lease, 'probe8'),
    readCarry: readCloudflarePythonProbe7Carry, runCampaign: runCloudflareProbe8Campaign,
  });
}
