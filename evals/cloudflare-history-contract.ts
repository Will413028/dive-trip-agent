import { z } from 'zod';

const digest = z.string().length(64).regex(/^[0-9a-f]{64}$/);
const account = z.string().length(32).regex(/^[0-9a-f]{32}$/);
const schema = z.string().length(37).regex(/^test_[0-9a-f]{32}$/);
const uuid = z.uuid().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

/** Versioned identity contract, independent of public example values.
 * Adding/reinterpreting an anchor requires an explicit, re-pinned migration. */
export const cloudflareHistoryIdentitiesSchema = z.strictObject({
  artifacts_FIRST_REPORT_SHA256_1: digest,
  artifacts_SECOND_REPORT_SHA256_1: digest,
  artifacts_PATCH_REPORT_SHA256_1: digest,
  artifacts_QUALITY_REPORT_SHA256_1: digest,
  artifacts_REVISION_REPORT_SHA256_1: digest,
  artifacts_RECOVERY_REPORT_SHA256_1: digest,
  artifacts_GROUNDED_REPORT_SHA256_1: digest,
  artifacts_NONTHINKING_REPORT_SHA256_1: digest,
  audit_database_CLOUDFLARE_RETAINED_SCHEMA_1: schema,
  audit_database_CLOUDFLARE_SECOND_RETAINED_SCHEMA_1: schema,
  audit_database_CLOUDFLARE_QUALITY_RETAINED_SCHEMA_1: schema,
  audit_database_CLOUDFLARE_REVISION_RETAINED_SCHEMA_1: schema,
  audit_database_CLOUDFLARE_RECOVERY_RETAINED_SCHEMA_1: schema,
  audit_database_CLOUDFLARE_GROUNDED_RETAINED_SCHEMA_1: schema,
  audit_database_CLOUDFLARE_NONTHINKING_RETAINED_SCHEMA_1: schema,
  accountId_1: account,
  carry_forward_2_runId_1: uuid,
  carry_forward_2_tripId_1: uuid,
  carry_forward_2_ownerId_1: uuid,
  carry_forward_runIds_1: uuid,
  carry_forward_runIds_2: uuid,
  carry_forward_tripIds_1: uuid,
  carry_forward_tripIds_2: uuid,
  carry_forward_ownerIds_1: uuid,
  carry_forward_ownerIds_2: uuid,
  carry_forward_unknownReceipt_1: uuid,
  grounded_carry_runId_1: uuid,
  grounded_carry_tripId_1: uuid,
  nonthinking_carry_runId_1: uuid,
  nonthinking_carry_tripId_1: uuid,
  patch_carry_runId_1: uuid,
  patch_carry_receipt_1: uuid,
  quality_carry_bindingsSha256_1: digest,
  quality_carry_inventoryScopes_1: digest,
  quality_carry_inventoryScopes_2: digest,
  quality_carry_inventoryScopes_3: digest,
  quality_carry_inventoryScopes_4: digest,
  revision_carry_unknown_1: uuid,
  revision_carry_unknown_2: uuid,
  revision_carry_unknown_3: uuid,
  replay_quality_1: uuid,
  replay_quality_2: uuid,
  replay_revision_3: uuid,
  replay_recovery_4: uuid,
  replay_recovery_5: uuid,
});
export const cloudflareHistoryProfileSchema = z.strictObject({
  schemaVersion: z.literal(1), identities: cloudflareHistoryIdentitiesSchema,
});
export type CloudflareHistoryIdentities = Readonly<z.infer<typeof cloudflareHistoryIdentitiesSchema>>;
export type CloudflareHistoryKey = keyof CloudflareHistoryIdentities;
