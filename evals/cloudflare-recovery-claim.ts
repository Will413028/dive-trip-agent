import type { EvaluationLockLease } from './live-evaluation-lock.ts';
import { claimCloudflareCampaign } from './cloudflare-campaign-claim.ts';

export function claimCloudflareRecoveryCampaign(lease: EvaluationLockLease) {
  return claimCloudflareCampaign(lease, 'recovery');
}
