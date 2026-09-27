import { expect, test } from 'vitest';
import { maximumProviderModelCost, referenceProviderCost } from '../../src/server/model-cost';
import { CLOUDFLARE_MODEL, CLOUDFLARE_PRICE_BASIS } from '../../src/agent/cloudflare-wire';

const evidence = { provider: 'cloudflare', returnedModel: `${CLOUDFLARE_MODEL}-external`, priceBasis: CLOUDFLARE_PRICE_BASIS } as const;
const usage = { promptTokens: 160, outputTokens: 229, totalTokens: 389 };
test('Cloudflare uses its reference price, not zero billing or Gemini additive reasoning', () => {
  expect(referenceProviderCost('cloudflare', usage, evidence)).toBe(85);
  expect(referenceProviderCost('cloudflare', { ...usage, thoughtTokens: 200 }, evidence)).toBe(85);
  expect(referenceProviderCost('cloudflare', { ...usage, cachedTokens: 160 }, evidence)).toBe(85);
  expect(referenceProviderCost('cloudflare', { promptTokens: 1, outputTokens: 0, totalTokens: 1 }, evidence)).toBe(1);
  expect(maximumProviderModelCost('cloudflare', 1)).toBe(26_215);
  expect(maximumProviderModelCost('cloudflare')).toBe(183_505);
  expect(maximumProviderModelCost('cloudflare', 0)).toBe(0);
  for (const count of [-1, 8, 0.5, NaN]) expect(() => maximumProviderModelCost('cloudflare', count)).toThrow();
});
test('missing, cross-provider or inconsistent Cloudflare evidence never settles as free', () => {
  expect(referenceProviderCost('cloudflare', null, evidence)).toBeNull();
  expect(referenceProviderCost('cloudflare', usage)).toBeNull();
  expect(referenceProviderCost('cloudflare', usage, { ...evidence, returnedModel: '@cf/other/model' })).toBeNull();
  expect(referenceProviderCost('cloudflare', usage, { provider: 'openrouter', generationId: 'gen',
    returnedModel: 'x/y', reportedCostMicros: 0 })).toBeNull();
  for (const patch of [{ totalTokens: 390 }, { thoughtTokens: 230 }, { cachedTokens: 161 },
    { promptTokens: -1 }, { outputTokens: 0.5 }]) {
    expect(referenceProviderCost('cloudflare', { ...usage, ...patch }, evidence)).toBeNull();
  }
});
