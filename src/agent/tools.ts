import { randomUUID } from 'node:crypto';
import { FunctionTool } from '@google/adk';
import { findItems, loadCatalog } from '../catalog/catalog.ts';
import { calculateBudget, assessLockedBudget } from '../domain/budget.ts';
import { buildProposal } from '../domain/proposal.ts';
import { parseSnapshotStructure } from '../domain/snapshot.ts';
import type { CatalogItem, Snapshot } from '../domain/types.ts';
import { agentToolParameters, expandAgentChanges } from './tool-schemas.ts';
import { priceDisclosure } from './budget-evidence.ts';

export const TOOL_OUTPUT_MAX_BYTES = 16_384;
export const TOOL_ITEMS_LIMIT = 20;
export type AgentToolsInput = { snapshot: Snapshot; catalog: CatalogItem[] };

const destinations = [
  { id: 'xiaoliuqiu', name: '小琉球' },
  { id: 'green-island', name: '綠島' },
  { id: 'kenting', name: '墾丁' },
] as const;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function bounded<T>(value: T): T | { error: 'TOOL_OUTPUT_TOO_LARGE' } {
  // Never truncate a validation verdict or silently lose unknown-cost markers.
  return bytes(value) <= TOOL_OUTPUT_MAX_BYTES ? structuredClone(value) : { error: 'TOOL_OUTPUT_TOO_LARGE' };
}
function itemSummary(item: CatalogItem) {
  const priceSource = item.sources.find(source => source.id === item.price.sourceId)!;
  const demoSource = item.sources.find(source => source.kind === 'demo');
  return { id: item.id, destinationId: item.destinationId, kind: item.kind, title: item.title,
    audience: item.audience, capacityPerRoom: item.capacityPerRoom, price: item.price,
    containsDemo: item.price.basis === 'demo' || item.sources.some(source => source.kind === 'demo'),
    // Retain the complete price citation and any separate DEMO provenance.
    sources: demoSource && demoSource.id !== priceSource.id ? [priceSource, demoSource] : [priceSource] };
}

/** Read-only tools over one server-selected, detached snapshot and catalog.
 * The model cannot supply data sources, actors, URLs to fetch, or mutations.
 * Source URLs in outputs are citations only; this module performs no I/O.
 */
export function createReadTools(input: AgentToolsInput, lookupTimeout = false) {
  if (input.snapshot.entries.length > 128 || input.catalog.length > 1000 || bytes(input) > 1_048_576) {
    throw new Error('AGENT_TOOL_CONTEXT_TOO_LARGE');
  }
  const snapshot = freeze(parseSnapshotStructure(structuredClone(input.snapshot)));
  const catalog = freeze(loadCatalog(structuredClone(input.catalog)));

  return [
    new FunctionTool({
      name: 'find_destinations', parameters: agentToolParameters.find_destinations,
      description: '列出支援目的地及服務端目錄數量；目錄項目不代表可訂狀態，DEMO 非真實報價。',
      execute: () => bounded({ destinations: destinations.map(destination => {
        const items = findItems(catalog, destination.id);
        return { ...destination, itemCount: items.length,
          demoItemCount: items.filter(item => item.price.basis === 'demo' || item.sources.some(s => s.kind === 'demo')).length };
      }) }),
    }),
    new FunctionTool({
      name: 'find_items', parameters: agentToolParameters.find_items,
      description: '依目的地查目錄，最多20項並標示省略數；價格為TWD分的結構化單價，保留單位與DEMO。unknown不可當零；無即時庫存或可訂保證。回答只引用answerEvidenceRef及itemIds，由程式顯示價格。',
      execute: ({ destinationId }) => {
        if (lookupTimeout) return { error: 'CATALOG_TIMEOUT', items: [], retryable: false };
        const matches = findItems(catalog, destinationId);
        const items: ReturnType<typeof itemSummary>[] = [];
        for (const item of matches) {
          if (items.length === TOOL_ITEMS_LIMIT) break;
          const candidate = itemSummary(item);
          const next = [...items, candidate];
          if (bytes({ items: next, total: matches.length, omittedCount: matches.length - next.length }) <= TOOL_OUTPUT_MAX_BYTES) items.push(candidate);
        }
        return bounded({ items, total: matches.length, omittedCount: matches.length - items.length });
      },
    }),
    new FunctionTool({
      name: 'calculate_budget', parameters: agentToolParameters.calculate_budget,
      description: '僅計算服務端固定行程，金額為TWD分；knownMinor是已知小計，未知或排除費用不可當成零。',
      execute: () => {
        const budget = calculateBudget(snapshot);
        return bounded({ ...budget, currency: 'TWD', unit: 'minor',
          priceDisclosure: priceDisclosure(snapshot), budgetConstraint: assessLockedBudget(snapshot, snapshot),
          exclusions: snapshot.exclusions,
          unknownCosts: snapshot.entries.filter(entry => budget.unknownEntryIds.includes(entry.id)).map(entry => ({
            entryId: entry.id, reason: entry.item.price.unknownReason,
            source: entry.item.sources.find(source => source.id === entry.item.price.sourceId),
          })),
        });
      },
    }),
    new FunctionTool({
      name: 'validate_changes', parameters: agentToolParameters.validate_changes,
      description: '驗證changes；成功回傳validationId，接著只以該ID呼叫propose_changes。不能lock/unlock，不保存或套用。canApply不代表已確認。',
      execute: ({ changes }) => {
        const draft = buildProposal(snapshot, expandAgentChanges(snapshot, changes), catalog, 'agent');
        return bounded({ canApply: draft.canApply, validationId: draft.canApply ? randomUUID() : null,
          budget: draft.budget, issues: draft.issues,
          currency: 'TWD', unit: 'minor',
          priceDisclosure: priceDisclosure(draft.next),
          budgetConstraint: assessLockedBudget(snapshot, draft.next, draft.issues) });
      },
    }),
  ];
}
