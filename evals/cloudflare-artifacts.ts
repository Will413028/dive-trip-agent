import { historyIdentity } from './cloudflare-history-profile.ts';
/** Immutable historical provenance identities; data only, no IO dependency. */
export const FIRST_REPORT_SHA256 = () => (historyIdentity('artifacts_FIRST_REPORT_SHA256_1'));
export const SECOND_REPORT_SHA256 = () => (historyIdentity('artifacts_SECOND_REPORT_SHA256_1'));
export const PATCH_REPORT_SHA256 = () => (historyIdentity('artifacts_PATCH_REPORT_SHA256_1'));
export const QUALITY_REPORT_SHA256 = () => (historyIdentity('artifacts_QUALITY_REPORT_SHA256_1'));
export const REVISION_REPORT_SHA256 = () => (historyIdentity('artifacts_REVISION_REPORT_SHA256_1'));
export const RECOVERY_REPORT_SHA256 = () => (historyIdentity('artifacts_RECOVERY_REPORT_SHA256_1'));
export const GROUNDED_REPORT_SHA256 = () => (historyIdentity('artifacts_GROUNDED_REPORT_SHA256_1'));
export const NONTHINKING_REPORT_SHA256 = () => (historyIdentity('artifacts_NONTHINKING_REPORT_SHA256_1'));

/** Closed names: scope selection is not a caller-supplied filesystem path. */
export const CLOUDFLARE_PREFLIGHT_FILES = {
  quality: { claim: 'cloudflare-quality.claim', review: 'cloudflare-quality-preflight-review.json' },
  revision: { claim: 'cloudflare-revision.claim', review: 'cloudflare-revision-preflight-review.json' },
  recovery: { claim: 'cloudflare-recovery.claim', review: 'cloudflare-recovery-preflight-review.json' },
  grounded: { claim: 'cloudflare-grounded.claim', review: 'cloudflare-grounded-preflight-review.json' },
  nonthinking: { claim: 'cloudflare-nonthinking.claim', review: 'cloudflare-nonthinking-preflight-review.json' },
  diagnostic: { claim: 'cloudflare-diagnostic.claim', review: 'cloudflare-diagnostic-preflight-review.json' },
} as const;
