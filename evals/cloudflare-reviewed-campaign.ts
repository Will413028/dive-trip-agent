import { runFiniteCloudflareCampaign, type CampaignSlot, type FiniteCampaignPorts } from './cloudflare-campaign.ts';

type Report = Parameters<typeof runFiniteCloudflareCampaign>[1];
/** Shared scheduling only. Review/provenance policy belongs to the caller;
 * no credential loading, authorization or filesystem effects are supplied here. */
export async function runReviewedCloudflareCampaign<R extends Report>(
  ports: FiniteCampaignPorts<R> & { reviewPreflight(report: R): Promise<boolean>; checkPreflight?(report: R): boolean }, report: R,
  preflight: string | readonly CampaignSlot[],
  slots: readonly CampaignSlot[], maxInvocations: number,
): Promise<R> {
  const firstSlots = typeof preflight === 'string' ? [{ round: 0, caseId: preflight }] : preflight;
  if (!firstSlots.length) throw new Error('EVAL_INVALID_SCHEDULE');
  for (const [index, slot] of firstSlots.entries()) {
    await runFiniteCloudflareCampaign(ports, report, {
      slots: [slot], maxInvocations: Math.min(maxInvocations, (index + 1) * 2),
    });
    if (!report.stopped && ports.checkPreflight) {
      try {
        if (!ports.checkPreflight(structuredClone(report))) report.stopped = 'PREFLIGHT_GOAL_STOP';
      } catch { report.stopped = 'PREFLIGHT_GOAL_STOP'; }
      await ports.checkpoint(structuredClone(report));
    }
  }
  if (!report.stopped) {
    try {
      if (await ports.reviewPreflight(structuredClone(report)) !== true) report.stopped = 'PREFLIGHT_TEXT_REVIEW_STOP';
    } catch { report.stopped = 'PREFLIGHT_TEXT_REVIEW_STOP'; }
    await ports.checkpoint(structuredClone(report));
  }
  return runFiniteCloudflareCampaign(ports, report, { slots, maxInvocations });
}
