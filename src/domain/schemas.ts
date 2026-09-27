import { z } from 'zod';
import type { Requirements } from './types.ts';

const requirementsSchema = z.strictObject({
  destinationId: z.enum(['xiaoliuqiu', 'green-island', 'kenting']).nullable(),
  days: z.number().int().min(2).max(7),
  people: z.number().int().min(1).max(6),
  divers: z.number().int().min(0),
  startDate: z.iso.date().nullable(),
  budgetMinor: z.number().int().nonnegative().nullable(),
  lodgingPreference: z.string(),
  pace: z.enum(['relaxed', 'balanced']),
}).refine((requirements) => requirements.divers <= requirements.people, {
  path: ['divers'],
  message: '潛水人數不可超過旅客人數',
});

export function parseRequirements(input: unknown): Requirements {
  return requirementsSchema.parse(input);
}
