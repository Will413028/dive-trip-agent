import { describe, expect, it } from 'vitest';
import { maximumModelCost, referenceModelCost } from '../../src/server/model-cost';
import { MODEL_LIMITS } from '../../src/agent/model-guard';

describe('reference-price risk accounting, not paid activation', () => {
  it('reserves the full model input capacity, not the request byte limit', () => {
    expect(maximumModelCost(1)).toBe(265_216);
    expect(maximumModelCost()).toBe(1_856_512);
    expect(maximumModelCost(0)).toBe(0);
    // A guard-limit increase needs a deliberate price-bound review as well.
    expect(MODEL_LIMITS.modelCalls).toBe(7);
    expect(MODEL_LIMITS.outputTokens).toBe(2048);
    for (const value of [-1, 8, 0.5, NaN, Infinity]) expect(() => maximumModelCost(value)).toThrow('INVALID_MODEL_CALL_BUDGET');
  });
  it('rounds upward per call in integer microdollars', () => {
    expect(referenceModelCost({ promptTokens: 1, outputTokens: 0, totalTokens: 1 })).toBe(1);
    expect(referenceModelCost({ promptTokens: 0, outputTokens: 1, totalTokens: 1 })).toBe(2);
    expect(referenceModelCost({ promptTokens: 100, outputTokens: 20, totalTokens: 120 })).toBe(55);
    expect(referenceModelCost({ promptTokens: 0, outputTokens: 0, totalTokens: 0 })).toBe(0);
  });
  it('includes thoughts and unknown token overhead, without a cache discount', () => {
    expect(referenceModelCost({ promptTokens: 100, outputTokens: 20, totalTokens: 140,
      thoughtTokens: 10, cachedTokens: 100 })).toBe(85);
  });
  it('keeps missing or inconsistent usage unknown', () => {
    expect(referenceModelCost(null)).toBeNull();
    const normal = { promptTokens: 100, outputTokens: 20, totalTokens: 120 };
    for (const patch of [{ promptTokens: -1 }, { outputTokens: 1.5 }, { totalTokens: NaN },
      { totalTokens: 119 }, { thoughtTokens: 1 }, { cachedTokens: 101 }, { thoughtTokens: Infinity },
      { totalTokens: Number.MAX_SAFE_INTEGER + 1 }]) expect(referenceModelCost({ ...normal, ...patch })).toBeNull();
  });
  it('records an observed overrun without silently clamping it', () => {
    expect(referenceModelCost({ promptTokens: 1_048_576, outputTokens: 4096, totalTokens: 1_052_672 }))
      .toBeGreaterThan(maximumModelCost(1));
  });
  it('rejects a cost that cannot be represented safely', () => {
    expect(referenceModelCost({ promptTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER,
      totalTokens: Number.MAX_SAFE_INTEGER })).toBeNull();
  });
});
