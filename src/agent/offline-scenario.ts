import { z } from 'zod';

/** Closed synthetic transport contract; each process validates its own input. */
export const offlineScenarioSchema = z.enum([
  'clarify', 'proposal', 'rate-limit', 'missing-usage', 'hang', 'invalid-tool-arguments', 'invalid-json',
]);
export type OfflineScenario = z.infer<typeof offlineScenarioSchema>;
