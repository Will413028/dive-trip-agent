import { HttpAgent } from '@ag-ui/client';
import { EventType, type ResumeEntry } from '@ag-ui/core';
import { z } from 'zod';

const viewSchema = z.object({ status: z.enum(['idle', 'pending', 'approved', 'rejected']),
  applications: z.number().int().nonnegative(), interruptId: z.string().nullable() });
type View = z.infer<typeof viewSchema>;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let threadId: string;
try { threadId = z.uuid().parse(localStorage.getItem('adk-probe-thread')); }
catch { threadId = crypto.randomUUID(); }
try { localStorage.setItem('adk-probe-thread', threadId); } catch { /* Session still works in this tab. */ }
el('thread').textContent = threadId;
let view: View | null = null;
let busy = false;
function buttons() {
  for (const button of document.querySelectorAll('button')) button.disabled = busy;
  el<HTMLButtonElement>('start').disabled = busy || view?.status !== 'idle';
  el<HTMLButtonElement>('approve').disabled = busy || view?.status !== 'pending';
  el<HTMLButtonElement>('reject').disabled = busy || view?.status !== 'pending';
}
function render(value: View) {
  view = value;
  const labels = { idle: '尚未提案', pending: '等待你確認', approved: '已批准並套用', rejected: '已拒絕，未套用' };
  el('badge').textContent = labels[value.status];
  el('status').textContent = { idle: '按下按鈕，讓 ADK 產生一筆待確認的工具呼叫。',
    pending: '提案已保存。你可以批准、拒絕，或重新整理後再決定。',
    approved: '確認已完成；重新整理不會再套用一次。', rejected: '這筆提案已結束；不會因重新整理而被批准。' }[value.status];
  el('count').textContent = String(value.applications);
  el('choices').hidden = value.status !== 'pending';
  el('start').hidden = value.status !== 'idle';
  buttons();
}
function fail(error: unknown) {
  el('badge').textContent = '狀態待確認';
  el('status').textContent = '目前無法取得伺服器狀態，請重新讀取後再操作。';
  el('error').hidden = false;
  el('error').textContent = `無法確認最新狀態：${error instanceof Error ? error.message : '連線失敗'}。請重新讀取狀態，不要假定操作成功。`;
}
async function restore() {
  view = null; buttons();
  const response = await fetch(`/session?threadId=${encodeURIComponent(threadId)}`, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (response.status === 404) render({ status: 'idle', applications: 0, interruptId: null });
  else {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(viewSchema.parse(await response.json()));
  }
}
async function action(resume?: ResumeEntry[]) {
  if (busy) return;
  busy = true; buttons(); el('error').hidden = true; el('events').replaceChildren();
  el('status').textContent = '正在執行 ADK 流程…';
  const agent = new HttpAgent({ url: '/agent', threadId,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([
      ...(init.signal ? [init.signal] : []), AbortSignal.timeout(20_000),
    ]) }),
  });
  let finished = false;
  let runError: string | undefined;
  try {
    await agent.runAgent({ runId: crypto.randomUUID(), resume }, { onEvent: ({ event }) => {
      const item = document.createElement('li'); item.textContent = event.type; el('events').append(item);
      if (event.type === EventType.RUN_FINISHED) finished = true;
      if (event.type === EventType.RUN_ERROR) runError = typeof event.message === 'string' ? event.message : 'Agent 執行失敗';
    } });
    if (runError || !finished) throw new Error(runError ?? '串流未完整結束');
    await restore();
  } catch (error) { view = null; el('badge').textContent = '狀態待確認'; fail(error); }
  finally { busy = false; buttons(); }
}
el('start').onclick = () => { void action(); };
for (const [id, confirmed] of [['approve', true], ['reject', false]] as const) {
  el(id).onclick = () => {
    if (view?.status === 'pending' && view.interruptId) void action([
      { interruptId: view.interruptId, status: 'resolved', payload: { confirmed } },
    ]);
  };
}
el('new').onclick = () => {
  if (busy) return;
  threadId = crypto.randomUUID();
  try { localStorage.setItem('adk-probe-thread', threadId); } catch { /* tab-local fallback */ }
  el('thread').textContent = threadId; el('events').replaceChildren(); el('error').hidden = true;
  render({ status: 'idle', applications: 0, interruptId: null });
};
el('refresh').onclick = () => {
  if (busy) return;
  busy = true; buttons(); el('error').hidden = true;
  void restore().catch(fail).finally(() => { busy = false; buttons(); });
};
busy = true; buttons();
void restore().catch(fail).finally(() => { busy = false; buttons(); });
