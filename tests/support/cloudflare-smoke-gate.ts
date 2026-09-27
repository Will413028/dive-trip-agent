import { z } from 'zod';

export const cloudflareSmokePrompt = '第二天下午留白。請只移除第二天下午的 transfer 行程項目，其他需求與行程保持不變，提出修改供我確認，尚未確認前不要套用。';
export type SmokeConfirmation = { runId: string; interruptId: string };
/** Validate before dispatch, so two unrelated starts cannot consume two run budgets. */
export function allowedSmokeRequest(body: unknown, tripId: string, posts: number, phase: string,
  confirmation?: SmokeConfirmation): boolean {
  const common = { threadId: z.literal(tripId), runId: z.uuid(), tools: z.array(z.unknown()).length(0),
    context: z.array(z.unknown()).length(0), state: z.strictObject({}) };
  if (posts === 0 && phase === 'proposal') return z.object({ ...common,
    messages: z.tuple([z.object({ id: z.uuid(), role: z.literal('user'), content: z.literal(cloudflareSmokePrompt) })]),
    forwardedProps: z.strictObject({ baseVersion: z.literal(1) }), resume: z.array(z.unknown()).length(0).optional(),
  }).safeParse(body).success;
  if (posts !== 1 || phase !== 'confirmation' || !confirmation) return false;
  return z.object({ ...common, messages: z.array(z.unknown()).length(0),
    forwardedProps: z.strictObject({ runId: z.literal(confirmation.runId) }),
    resume: z.tuple([z.strictObject({ interruptId: z.literal(confirmation.interruptId),
      status: z.literal('resolved'), payload: z.strictObject({ confirmed: z.literal(true) }) })]),
  }).safeParse(body).success;
}
