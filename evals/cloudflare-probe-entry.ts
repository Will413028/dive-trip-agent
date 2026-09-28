import { runReviewedCloudflareEntry } from './cloudflare-reviewed-entry.ts';
import { runCloudflareProbeCampaign } from './cloudflare-probe-campaign.ts';
import { readCloudflarePythonDiagnosticCarry } from './cloudflare-python-diagnostic-carry.ts';
import { claimCloudflareCampaign } from './cloudflare-campaign-claim.ts';
import { CARRY_SCHEMA } from './cloudflare-carry-forward.ts';
import { SECOND_CARRY_SCHEMA } from './cloudflare-carry-forward-2.ts';
import { QUALITY_CARRY_SCHEMA } from './cloudflare-quality-carry.ts';
import { REVISION_CARRY_SCHEMA } from './cloudflare-revision-carry.ts';
import { RECOVERY_CARRY_SCHEMA } from './cloudflare-recovery-carry.ts';
import { GROUNDED_CARRY_SCHEMA } from './cloudflare-grounded-carry.ts';
import { NONTHINKING_CARRY_SCHEMA } from './cloudflare-nonthinking-carry.ts';

export const PROBE_AUTHORIZATION = 'probe-unknown-cost-once-7-calls-1-invocation-cloudflare-free-only-confirmed';

/** Fixed technical probe. The shared lifecycle owns authorization, claim,
 * evidence and credential timing; this policy never invokes content review. */
export async function runCloudflareProbeEntry() {
  return runReviewedCloudflareEntry({ mode: 'technical', stem: 'cloudflare-probe', liveCampaign: 'cloudflare-probe-one-case',
    authorizationEnv: 'DIVE_TRIP_CLOUDFLARE_PROBE_AUTHORIZATION', authorization: PROBE_AUTHORIZATION,
    schemas: () => ['workbench_live', CARRY_SCHEMA(), SECOND_CARRY_SCHEMA(), QUALITY_CARRY_SCHEMA(),
      REVISION_CARRY_SCHEMA(), RECOVERY_CARRY_SCHEMA(), GROUNDED_CARRY_SCHEMA(), NONTHINKING_CARRY_SCHEMA()],
    initialReplays: 1, claim: lease => claimCloudflareCampaign(lease, 'probe'),
    readCarry: readCloudflarePythonDiagnosticCarry,
    runCampaign: runCloudflareProbeCampaign,
  });
}
