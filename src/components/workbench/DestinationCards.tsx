import type { DestinationId } from '../../domain/types';
import { destinations } from './client';

export default function DestinationCards({ value, onChange }: { value: DestinationId | null; onChange: (id: DestinationId) => void }) {
  return <fieldset className="destinations"><legend>目的地</legend>{destinations.map(place => <label key={place.id} className={value === place.id ? 'destination selected' : 'destination'}>
    <input type="radio" name="destination" value={place.id} checked={value === place.id} onChange={() => onChange(place.id)} />
    <span><strong>{place.name}</strong><small>{place.note}</small></span>
  </label>)}</fieldset>;
}
