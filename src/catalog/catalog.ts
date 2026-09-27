import { z } from 'zod';
import type { CatalogItem, DestinationId } from '../domain/types.ts';

const text = z.string().refine(value => value.trim().length > 0, '不可為空白');
const demoLabel = /DEMO|示範/i;
const sourceSchema = z.strictObject({
  id: text,
  url: z.url({ protocol: /^https$/ }).nullable(),
  checkedAt: z.iso.date(),
  kind: z.enum(['fact', 'demo']),
  label: text,
}).refine(source => source.kind === 'demo' || source.url !== null, '事實來源必須有 HTTPS URL')
  .refine(source => source.kind !== 'demo' || demoLabel.test(source.label), '示範來源必須明示 DEMO／示範');

const priceSchema = z.strictObject({
  unit: z.enum(['person', 'room-night', 'group']),
  unitMinor: z.number().int().nonnegative().nullable(),
  basis: z.enum(['estimate', 'demo']),
  sourceId: text,
  unknownReason: text.nullable(),
}).refine(price => (price.unitMinor === null) === (price.unknownReason !== null), '未知價格必須與原因成對');

const itemSchema = z.strictObject({
  id: text,
  destinationId: z.enum(['xiaoliuqiu', 'green-island', 'kenting']),
  kind: z.enum(['lodging', 'activity']),
  title: text,
  audience: z.enum(['all', 'divers', 'non-divers']),
  capacityPerRoom: z.number().int().positive().nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  price: priceSchema,
  sources: z.array(sourceSchema).min(1),
}).superRefine((item, context) => {
  const issue = (path: string[], message: string) => context.addIssue({ code: 'custom', path, message });
  if ((item.lat === null) !== (item.lng === null)) issue(['lat'], '座標必須成對');
  if (new Set(item.sources.map(source => source.id)).size !== item.sources.length) {
    issue(['sources'], '來源 ID 不可重複');
  }
  if (!item.sources.some(source => source.id === item.price.sourceId)) {
    issue(['price', 'sourceId'], '價格必須引用本項目的來源');
  }
  if ((item.price.basis === 'demo' || item.sources.some(source => source.kind === 'demo')) && !demoLabel.test(item.title)) {
    issue(['title'], '示範項目必須明示 DEMO／示範');
  }
  if (item.kind === 'lodging') {
    if (item.price.unit !== 'room-night') issue(['price', 'unit'], '住宿必須按房晚計價');
    if (item.capacityPerRoom === null) issue(['capacityPerRoom'], '住宿必須有房間容量');
  } else {
    if (item.price.unit === 'room-night') issue(['price', 'unit'], '活動不可按房晚計價');
    if (item.capacityPerRoom !== null) issue(['capacityPerRoom'], '活動不可有房間容量');
  }
});

const catalogSchema = z.array(itemSchema).superRefine((items, context) => {
  const ids = new Set<string>();
  items.forEach((item, index) => {
    if (ids.has(item.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: '目錄 ID 不可重複' });
    ids.add(item.id);
  });
});

export function loadCatalog(input: unknown): CatalogItem[] {
  return catalogSchema.parse(input);
}

export function findItems(catalog: CatalogItem[], destinationId: DestinationId): CatalogItem[] {
  return catalog.filter(item => item.destinationId === destinationId);
}
