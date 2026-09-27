import { z } from 'zod';

const tool = z.enum(['find_destinations', 'find_items', 'calculate_budget', 'validate_changes', 'propose_changes']);
const field = z.enum(['changes', 'kind', 'value', 'entry', 'id', 'catalogId', 'day', 'slot', 'endDay',
  'rooms', 'entryId', 'destinationId', 'days', 'people', 'divers', 'startDate', 'budgetMinor',
  'lodgingPreference', 'pace', 'validationId', '*', '?']);
const code = z.enum(['invalid_type', 'invalid_value', 'too_small', 'too_big', 'invalid_format',
  'unrecognized_keys', 'invalid_union', 'custom', 'other']);
const diagnostic = z.strictObject({ code: z.literal('AGENT_TOOL_ARGUMENTS'), tool,
  issues: z.array(z.strictObject({ code, path: z.array(field).max(8) })).min(1).max(8) });

/** Private ADK error metadata: never include messages, values, or unknown field names. */
export function toolArgumentDiagnostic(name: string, issues: readonly z.core.$ZodIssue[]): string {
  const safeIssues: z.infer<typeof diagnostic>['issues'] = [];
  function visit(items: readonly z.core.$ZodIssue[], depth: number, prefix: PropertyKey[] = []): void {
    for (const issue of items) {
      if (safeIssues.length === 8) return;
      const path = [...prefix, ...issue.path];
      safeIssues.push({ code: code.safeParse(issue.code).success ? issue.code as z.infer<typeof code> : 'other',
        path: path.slice(0, 8).map(part => typeof part === 'number' ? '*'
          : field.safeParse(part).success ? part as z.infer<typeof field> : '?') });
      if (issue.code === 'invalid_union' && depth < 3) {
        // Union children are relative paths. Show the closest alternatives first;
        // these remain union diagnostics, not proof of the intended branch.
        for (const branch of [...issue.errors].sort((a, b) => a.length - b.length)) visit(branch, depth + 1, path);
      }
    }
  }
  visit(issues, 0);
  return JSON.stringify(diagnostic.parse({ code: 'AGENT_TOOL_ARGUMENTS', tool: name, issues: safeIssues }));
}

/** Strict decoding at the worker boundary; private details must not enter IPC/AG-UI. */
export function toolArgumentErrorCode(message: string | undefined): 'AGENT_TOOL_ARGUMENTS' | undefined {
  if (!message || message.length > 2048) return undefined;
  try { return diagnostic.safeParse(JSON.parse(message)).success ? 'AGENT_TOOL_ARGUMENTS' : undefined; }
  catch { return undefined; }
}
