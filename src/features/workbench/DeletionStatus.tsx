'use client';

import { useEffect, useState } from 'react';
import { errorMessage, request } from '../../lib/api';

export type DeletionState = { status: 'deleting' | 'deleted' };

export default function DeletionStatus({ tripId }: { tripId: string }) {
  const [status, setStatus] = useState<DeletionState['status'] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const result = await request<DeletionState>(`/api/trips/${encodeURIComponent(tripId)}/deletion`);
        if (!active) return;
        if (result.status !== 'deleting' && result.status !== 'deleted') throw new Error('INVALID_DELETION_STATUS');
        setStatus(result.status); setError('');
        if (result.status === 'deleting') timer = setTimeout(() => void read(), 2000);
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      }
    }
    void read();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [tripId, attempt]);
  return <main id="main" className="workbench"><section className="panel" aria-live="polite">
    <h1>{status === 'deleted' ? '行程已刪除' : status === 'deleting' ? '行程刪除中' : '正在確認刪除狀態'}</h1>
    {status === 'deleting' && <p>行程與分享已停止存取，正在清除對話及行程內容。關閉頁面不會取消刪除。</p>}
    {status === 'deleted' && <p>行程、分享及對話內容已清除。防濫用的配額紀錄仍依留存規則保留。</p>}
    {error && <><p role="alert" className="error">{error} 尚未確認清理完成。</p>
      <button onClick={() => setAttempt(value => value + 1)}>重新確認狀態</button></>}
    <a href="/">回首頁</a>
  </section></main>;
}
