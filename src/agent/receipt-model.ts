import { BaseLlm, type BaseLlmConnection, type LlmResponse } from '@google/adk';

/** ADK's LlmAgent still owns native confirmation processing. A receipt phase
 * has no generation capability: even a future SDK fallthrough fails locally,
 * before any provider is constructed or request can be dispatched. */
export class ReceiptOnlyModel extends BaseLlm {
  constructor() { super({ model: 'deterministic-receipt-no-generation' }); }
  generateContentAsync(): AsyncGenerator<LlmResponse> {
    throw new Error('AGENT_GENERATION_DISABLED');
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('AGENT_GENERATION_DISABLED'); }
}
