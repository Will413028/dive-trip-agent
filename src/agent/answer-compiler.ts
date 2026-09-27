import { createHash } from 'node:crypto';
import { z } from 'zod';
import { acceptedAnswerSchema, answerPlanSchema, budgetPresentationSchema, evidenceBindingSchema,
  type AcceptedAnswer, type BudgetPresentation, type EvidenceBinding } from '../domain/answer.ts';
import { assessLockedBudget, calculateBudget } from '../domain/budget.ts';
import { formatTwd } from '../domain/money.ts';
import type { Budget, CatalogItem, Issue, Snapshot } from '../domain/types.ts';
import { priceDisclosure } from './budget-evidence.ts';
import { evidenceIdentity, type AnswerEvidence } from './answer-evidence.ts';

export type AnswerCompilation = { binding: EvidenceBinding; eventId: string; evidence: readonly AnswerEvidence[] };
const money = (minor: number) => ({ minor, display: formatTwd(minor) });
const invalid = (): never => { throw new Error('AGENT_ANSWER_EVIDENCE'); };
function priceSource(item: CatalogItem) { return item.sources.find(source => source.id === item.price.sourceId) ?? invalid(); }
function provenanceSources(item: CatalogItem) { return item.sources.filter(source => source.kind === 'demo' && source.id !== item.price.sourceId); }
function budgetView(base: Snapshot, snapshot: Snapshot, budget: Budget, scope: 'current' | 'candidate',
  version: number, issues: Issue[] = []): BudgetPresentation {
  const locked = assessLockedBudget(base, snapshot, issues);
  return budgetPresentationSchema.parse({ scope, baseVersion: version,
    known: money(budget.knownMinor), target: snapshot.requirements.budgetMinor === null ? null : money(snapshot.requirements.budgetMinor),
    withinBudget: budget.withinBudget, containsDemo: priceDisclosure(snapshot).containsDemo,
    unknownCosts: budget.unknownEntryIds.map(entryId => {
      const entry = snapshot.entries.find(entry => entry.id === entryId) ?? invalid();
      return { entryId, title: entry.item.title, reason: entry.item.price.unknownReason,
        source: priceSource(entry.item), provenanceSources: provenanceSources(entry.item) };
    }),
    exclusions: snapshot.exclusions, issues: issues.map(({ code, entryId }) => ({ code, ...(entryId ? { entryId } : {}) })),
    sources: snapshot.entries.map(entry => ({ entryId: entry.id, source: priceSource(entry.item), provenanceSources: provenanceSources(entry.item) })),
    locked: { status: locked.status, known: locked.lockedKnownMinor === null ? null : money(locked.lockedKnownMinor),
      entryIds: locked.lockedEntryIds, unknownEntryIds: locked.unknownLockedEntryIds },
  });
}
function asBudget(evidence: AnswerEvidence): BudgetPresentation {
  if (evidence.kind === 'budget') return budgetView(evidence.snapshot, evidence.snapshot,
    calculateBudget(evidence.snapshot), 'current', evidence.binding.baseVersion);
  if (evidence.kind === 'validation' || evidence.kind === 'proposal') return budgetView(evidence.base, evidence.draft.next,
    evidence.draft.budget, 'candidate', evidence.binding.baseVersion, evidence.draft.issues);
  return invalid();
}
function envelope(context: AnswerCompilation, body: AcceptedAnswer['body'], refs: string[]): AcceptedAnswer {
  const binding = evidenceBindingSchema.parse(context.binding);
  const eventId = z.string().min(1).max(128).parse(context.eventId);
  return acceptedAnswerSchema.parse({ schemaVersion: 1, templateVersion: 1,
    answerId: `ans_${createHash('sha256').update(JSON.stringify([binding.runId, eventId, 1])).digest('hex')}`,
    runId: binding.runId, evidenceRefs: refs, body });
}
function resolver(context: AnswerCompilation) {
  const binding = evidenceBindingSchema.parse(context.binding);
  const all = new Map<string, AnswerEvidence>();
  for (const evidence of context.evidence) {
    if (evidence.binding.ownerId !== binding.ownerId || evidence.binding.tripId !== binding.tripId
      || evidence.binding.runId !== binding.runId || evidence.binding.baseVersion !== binding.baseVersion
      || evidence.id !== evidenceIdentity(binding, evidence.kind, evidence.originId) || all.has(evidence.id)) return invalid();
    all.set(evidence.id, evidence);
  }
  const latest = context.evidence.findLast(evidence => evidence.kind === 'validation');
  const receipts = context.evidence.filter(evidence => evidence.kind === 'receipt');
  if (receipts.length > 1) return invalid();
  const resolve = (id: string) => {
    const evidence = all.get(id) ?? invalid();
    if (evidence.kind === 'validation' && evidence !== latest) return invalid();
    if (evidence.kind === 'proposal' && evidence.validationRef !== latest?.id) return invalid();
    return evidence;
  };
  return { resolve, committed: receipts[0] };
}

/** Pure compiler. There is deliberately no prose/HTML/template escape hatch. */
export function compileAnswer(rawPlan: unknown, context: AnswerCompilation): AcceptedAnswer {
  const { answer } = answerPlanSchema.parse(rawPlan);
  const { resolve, committed } = resolver(context);
  // A decision is terminal for this bound run. The pre-decision snapshot must
  // not become "current" again, nor may a decided proposal become pending.
  if (committed && (answer.kind !== 'receipt' || answer.evidenceRef !== committed.id)) return invalid();
  const refs: string[] = [];
  const get = (id: string) => { refs.push(id); return resolve(id); };
  let body: AcceptedAnswer['body'];
  switch (answer.kind) {
    case 'clarify': body = answer; break;
    case 'unsupported': body = answer; break;
    case 'requirements': {
      const evidence = get(answer.evidenceRef);
      if (evidence.kind !== 'requirements') return invalid();
      const { budgetMinor, ...requirements } = evidence.snapshot.requirements;
      body = { kind: answer.kind, version: evidence.binding.baseVersion,
        requirements: { ...requirements, target: budgetMinor === null ? null : money(budgetMinor) } };
      break;
    }
    case 'destinations': {
      const evidence = get(answer.evidenceRef);
      if (evidence.kind !== 'destinations') return invalid();
      body = { kind: answer.kind, destinations: (['xiaoliuqiu', 'green-island', 'kenting'] as const).map(id => {
        const items = evidence.catalog.filter(item => item.destinationId === id);
        return { id, itemCount: items.length,
          demoItemCount: items.filter(item => item.price.basis === 'demo' || item.sources.some(source => source.kind === 'demo')).length };
      }) };
      break;
    }
    case 'items': {
      const evidence = get(answer.evidenceRef);
      if (evidence.kind !== 'items') return invalid();
      if (answer.itemIds.length === 0 && evidence.items.length !== 0) return invalid();
      // Selection never makes a "cheapest" or availability claim; omissions stay visible.
      body = { kind: answer.kind, destinationId: evidence.destinationId, total: evidence.total, omittedCount: evidence.total - answer.itemIds.length,
        items: answer.itemIds.map(id => {
          const item = evidence.items.find(item => item.id === id) ?? invalid();
          return { id: item.id, title: item.title, audience: item.audience, capacityPerRoom: item.capacityPerRoom,
            price: item.price.unitMinor === null ? null : money(item.price.unitMinor), unit: item.price.unit,
            unknownReason: item.price.unknownReason, source: priceSource(item), provenanceSources: provenanceSources(item),
            containsDemo: item.price.basis === 'demo' || item.sources.some(source => source.kind === 'demo') };
        }) };
      break;
    }
    case 'budget': body = { kind: answer.kind, budget: asBudget(get(answer.evidenceRef)) }; break;
    case 'compare-budget': {
      const current = get(answer.currentRef), candidate = get(answer.candidateRef);
      if (current.kind !== 'budget' || candidate.kind !== 'validation') return invalid();
      body = { kind: answer.kind, current: asBudget(current), candidate: asBudget(candidate) };
      break;
    }
    case 'conflict': {
      const evidence = get(answer.evidenceRef);
      if (evidence.kind !== 'validation' || evidence.draft.canApply) return invalid();
      body = { kind: answer.kind, budget: asBudget(evidence) };
      break;
    }
    case 'proposal': {
      const evidence = get(answer.evidenceRef);
      if (evidence.kind !== 'proposal' || !evidence.draft.canApply) return invalid();
      body = { kind: answer.kind, proposalRef: evidence.id, changeCount: evidence.draft.changes.length, budget: asBudget(evidence) };
      break;
    }
    case 'receipt': {
      const evidence = get(answer.evidenceRef);
      if (evidence.kind !== 'receipt') return invalid();
      body = { kind: answer.kind, status: evidence.status, version: evidence.version };
      break;
    }
  }
  return envelope(context, body, refs);
}

/** Server-owned terminal fallback; a committed transaction can coexist with a
 * failed agent turn. No failed model output is incorporated into this answer. */
export function compileFailure(context: AnswerCompilation): AcceptedAnswer {
  const { committed } = resolver(context);
  if (committed) {
    return envelope(context, { kind: 'failure', reason: 'incomplete-run',
      committed: { status: committed.status, version: committed.version } }, [committed.id]);
  }
  return envelope(context, { kind: 'failure', reason: 'invalid-answer', committed: null }, []);
}
