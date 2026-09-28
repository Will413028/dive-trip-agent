import { readFileSync } from 'node:fs';
import { referenceProviderCost, maximumProviderModelCost } from '../../src/server/model-cost.ts';
const cases = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(cases.map(value => ({
  cost: referenceProviderCost(value.provider, value.usage, value.providerEvidence),
  maximum: maximumProviderModelCost(value.provider, value.remaining),
}))));
