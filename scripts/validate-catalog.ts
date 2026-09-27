import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadCatalog } from '../src/catalog/catalog.ts';

export function validateCatalog(input: unknown) {
  const catalog = loadCatalog(input);
  if (!catalog.length) throw new Error('EMPTY_CATALOG');
  return { mechanicallyValid: true, factVerification: 'not-performed', itemCount: catalog.length,
    demoItems: catalog.filter(item => item.price.basis === 'demo' || item.sources.some(s => s.kind === 'demo')).length,
    withoutCoordinates: catalog.filter(item => item.lat === null).length,
    unknownPrices: catalog.filter(item => item.price.unitMinor === null).length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error('NO_ARGUMENTS_ALLOWED');
    console.log(JSON.stringify(validateCatalog(JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8')))));
  } catch { console.error('CATALOG_VALIDATION_FAILED'); process.exitCode = 1; }
}
