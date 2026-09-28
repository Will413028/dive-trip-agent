'use client';
import { useEffect, useRef, useState } from 'react';
import { mapTiles, type MapMarker } from '../../catalog/map';
export type MapViewProps = { markers: MapMarker[]; unlocated: number };

function Tiles({ marker, zoom }: { marker: MapMarker; zoom: number }) {
  const tiles = mapTiles(marker.lat, marker.lng, zoom);
  const loaded = useRef(new Set<string>());
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    if (state !== 'loading') return;
    const timer = setTimeout(() => setState('failed'), 8000);
    return () => clearTimeout(timer);
  }, [state]);
  if (state === 'failed') return <p role="status">底圖無法載入，請使用下方座標與來源；行程仍可操作。</p>;
  return <>
    <p role="status">{state === 'loading' ? '正在載入底圖…' : '底圖已載入'}</p>
    <div className="trip-map" role="img" aria-label={`${marker.label}位置地圖`}>
      {tiles.map(tile => <img key={tile.url} src={tile.url} alt="" referrerPolicy="origin" draggable={false}
        style={{ left: `${tile.left}%`, top: `${tile.top}%` }} onError={() => setState('failed')}
        onLoad={() => { loaded.current.add(tile.url); if (loaded.current.size === tiles.length) setState('ready'); }} />)}
      <span className="map-pin" aria-hidden="true">●</span>
      <a className="map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
    </div>
  </>;
}

export default function MapPanel({ markers, unlocated }: MapViewProps) {
  const [enabled, setEnabled] = useState(false);
  const [selected, setSelected] = useState('');
  const [zoom, setZoom] = useState(14);
  const [attempt, setAttempt] = useState(0);
  const marker = markers.find(marker => marker.id === selected) ?? markers[0];
  return <section className="panel location-panel"><p className="eyebrow">TRIP LOCATIONS</p><h2>{marker ? '行程地圖' : '位置待確認'}</h2>
    <p>僅呈現已核對的景點位置，不代表入口、集合點或可下水位置；不提供交通時間或路線推估。</p>
    {unlocated > 0 && <p>{unlocated} 個行程項目沒有可核對位置，不在地圖標示。</p>}
    {marker && <>
      <p className="field-hint">載入底圖會連線至 OpenStreetMap，傳送 IP、網站來源與地圖區域；不傳送對話、行程 ID 或日期。</p>
      <div className="actions">
        <button onClick={() => setEnabled(value => !value)}>{enabled ? '關閉底圖' : '載入 OpenStreetMap 底圖'}</button>
        {enabled && <><button disabled={zoom >= 16} onClick={() => setZoom(value => value + 1)}>放大地圖</button>
          <button disabled={zoom <= 12} onClick={() => setZoom(value => value - 1)}>縮小地圖</button>
          <button onClick={() => setAttempt(value => value + 1)}>重新載入底圖</button></>}
      </div>
      {enabled && <Tiles key={`${marker.id}:${marker.lat}:${marker.lng}:${zoom}:${attempt}`} marker={marker} zoom={zoom} />}
      <ul className="map-places">{markers.map(place => <li key={place.id}>
        <button aria-pressed={place.id === marker.id} onClick={() => setSelected(place.id)}>{place.label}</button>
        <p>{place.lat}, {place.lng} · 查核 {place.checkedAt} · <a href={place.sourceUrl} target="_blank" rel="noreferrer">位置來源</a></p>
      </li>)}</ul>
      <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">回報底圖問題</a>
    </>}
  </section>;
}
