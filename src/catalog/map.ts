import data from '../../data/catalog.json';
import { loadCatalog } from './catalog';
import type { Snapshot } from '../domain/types';

export type MapMarker = { id: string; lat: number; lng: number; label: string; sourceUrl: string; checkedAt: string };
const catalog = loadCatalog(data);

// Never turn model-written or stale snapshot coordinates into verified positions.
export function tripMarkers(snapshot: Snapshot): MapMarker[] {
  return snapshot.entries.flatMap(entry => {
    const item = catalog.find(item => item.id === entry.catalogId);
    const source = item?.sources.find(source => source.kind === 'fact' && source.url);
    if (!item || !source?.url || item.lat === null || item.lng === null ||
        item.destinationId !== snapshot.requirements.destinationId ||
        entry.item.id !== item.id || entry.item.destinationId !== item.destinationId ||
        entry.item.lat !== item.lat || entry.item.lng !== item.lng) return [];
    return [{ id: entry.id, lat: item.lat, lng: item.lng, label: item.title, sourceUrl: source.url, checkedAt: source.checkedAt }];
  });
}

export function mapTiles(lat: number, lng: number, zoom: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180 ||
      !Number.isInteger(zoom) || zoom < 12 || zoom > 16) throw new Error('INVALID_MAP_VIEW');
  const size = 2 ** zoom;
  const x = (lng + 180) / 360 * size;
  const radians = lat * Math.PI / 180;
  const y = (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * size;
  const left = x * 256 - 256, top = y * 256 - 160;
  const tiles = [];
  for (let row = Math.floor(top / 256); row < Math.ceil((top + 320) / 256); row++) {
    for (let col = Math.floor(left / 256); col < Math.ceil((left + 512) / 256); col++) {
      const wrapped = ((col % size) + size) % size;
      tiles.push({ url: `https://tile.openstreetmap.org/${zoom}/${wrapped}/${row}.png`,
        left: (col * 256 - left) / 512 * 100, top: (row * 256 - top) / 320 * 100 });
    }
  }
  return tiles;
}
