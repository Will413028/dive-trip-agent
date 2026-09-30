import { runReviewedCloudflareEntry } from './cloudflare-reviewed-entry.ts';
import { runCloudflareProbe5Campaign } from './cloudflare-probe-5-campaign.ts';
import { readCloudflarePythonProbe4Carry } from './cloudflare-python-probe-4-carry.ts';
import { claimCloudflareCampaign } from './cloudflare-campaign-claim.ts';
import { CARRY_SCHEMA } from './cloudflare-carry-forward.ts';
import { SECOND_CARRY_SCHEMA } from './cloudflare-carry-forward-2.ts';
import { QUALITY_CARRY_SCHEMA } from './cloudflare-quality-carry.ts';
import { REVISION_CARRY_SCHEMA } from './cloudflare-revision-carry.ts';
import { RECOVERY_CARRY_SCHEMA } from './cloudflare-recovery-carry.ts';
import { GROUNDED_CARRY_SCHEMA } from './cloudflare-grounded-carry.ts';
import { NONTHINKING_CARRY_SCHEMA } from './cloudflare-nonthinking-carry.ts';

export const PROBE_5_AUTHORIZATION = 'probe-5-unknown-cost-once-7-calls-1-invocation-cloudflare-free-only-confirmed';

/** A separate technical scope whose prior carry includes all six stopped Python
 * executions. The shared lifecycle keeps the claim ahead of history and secrets. */
export async function runCloudflareProbe5Entry() {
  return runReviewedCloudflareEntry({ mode: 'technical', stem: 'cloudflare-probe-5',
    liveCampaign: 'cloudflare-probe-5-one-case',
    authorizationEnv: 'DIVE_TRIP_CLOUDFLARE_PROBE_5_AUTHORIZATION', authorization: PROBE_5_AUTHORIZATION,
    schemas: () => ['workbench_live', CARRY_SCHEMA(), SECOND_CARRY_SCHEMA(), QUALITY_CARRY_SCHEMA(),
      REVISION_CARRY_SCHEMA(), RECOVERY_CARRY_SCHEMA(), GROUNDED_CARRY_SCHEMA(), NONTHINKING_CARRY_SCHEMA()],
    initialReplays: 1, claim: lease => claimCloudflareCampaign(lease, 'probe5'),
    readCarry: readCloudflarePythonProbe4Carry, runCampaign: runCloudflareProbe5Campaign,
  });
}
