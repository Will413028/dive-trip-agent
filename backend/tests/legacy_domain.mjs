// Read-only parity oracle: removed with the old backend after migration gates.
import { buildProposal } from '../../src/domain/proposal.ts';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const cases = JSON.parse(input);
process.stdout.write(JSON.stringify(cases.map(({ base, changes, catalog, actor }) =>
  buildProposal(base, changes, catalog, actor))));
