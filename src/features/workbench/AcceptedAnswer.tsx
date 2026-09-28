import { acceptedAnswerSchema, type AcceptedAnswer as Answer, type BudgetPresentation } from '../../domain/answer';
import { formatTwd } from '../../domain/money';
import { destinations } from '../../lib/presentation';

type Body = Answer['body'];
type Source = BudgetPresentation['sources'][number]['source'];
export type AnswerNoticeReason = 'legacy-text' | 'invalid-answer' | 'unsupported-version';
const noticeText: Record<AnswerNoticeReason, string> = {
  'legacy-text': '舊版文字回答不受支援，無法顯示未驗證內容。請以已保存的行程與確認結果為準。',
  'invalid-answer': '回答未通過驗證，無法顯示。請重新讀取行程狀態，確認已保存的內容。',
  'unsupported-version': '此回答格式或版本不受支援，無法顯示。請以已保存的行程與確認結果為準。',
};

export function answerRejectionReason(value: unknown): AnswerNoticeReason {
  if (value && typeof value === 'object'
    && (('schemaVersion' in value && value.schemaVersion !== 1)
      || ('templateVersion' in value && value.templateVersion !== 1))) return 'unsupported-version';
  return 'invalid-answer';
}

export function AnswerUnavailable({ reason }: { reason: AnswerNoticeReason }) {
  return <div className="chat-assistant assistant-message" role="status"><p>{noticeText[reason]}</p></div>;
}

const questions: Record<Extract<Body, { kind: 'clarify' }>['fields'][number], string> = {
  destination: '想去小琉球、綠島，還是墾丁？',
  dates: '請提供出發日期與旅行天數；日期未定也可以先說明。',
  people: '這趟共有幾位旅客？支援 1–6 人。',
  divers: '同行者中有幾位會潛水？',
  budget: '這趟的目標預算是多少？目標預算不代表報價或已確認可負擔。',
  lodging: '有什麼住宿偏好？偏好不代表已選定房型。',
  rooms: '需要幾間房、住幾晚？人數與房間數會分開確認。',
  pace: '偏好放鬆留白，還是適度安排活動？',
  'target-item': '想調整哪一天、哪個時段的哪個行程項目？',
};
const unsupportedText: Record<Extract<Body, { kind: 'unsupported' }>['reason'], string> = {
  'outside-scope': '目前僅支援小琉球、綠島、墾丁的單一目的地行程，1–6 人、2–7 天。',
  booking: '目前無法代訂或確認可訂狀態；請向服務提供者查詢。',
  payment: '目前無法付款或代為處理交易。',
  'safety-guarantee': '無法提供潛水安全背書；請向合格教練及相關專業人員確認。',
};
const issues: Record<BudgetPresentation['issues'][number]['code'], string> = {
  INVALID_CHANGE: '修改內容不符合行程規則', INVALID_ACTOR: '此操作未獲授權', LOCKED_ENTRY: '鎖定項目不能被覆寫',
  INVALID_CATALOG: '目錄資料無效', DUPLICATE_ENTRY: '行程項目重複', CATALOG_NOT_FOUND: '找不到目錄項目',
  ENTRY_NOT_FOUND: '找不到行程項目', DESTINATION_MISMATCH: '項目與目的地不一致', DATE_OUT_OF_RANGE: '日期超出行程範圍',
  INVALID_LODGING: '住宿安排不符合規則', CAPACITY: '住宿容量不足', OVERLAP: '行程時段重疊',
  BUDGET_INVALID: '無法計算此安排的費用', BUDGET_EXCEEDED: '已知費用超過目標預算',
  UNKNOWN_COST: '仍有費用待確認', EXCLUDED_COST: '仍有未納入的費用',
};
const lockedText: Record<BudgetPresentation['locked']['status'], string> = {
  unavailable: '目前無法判定鎖定下限；不能據此判斷候選修改是否可行。',
  'budget-unspecified': '尚未設定目標預算，無法判定鎖定下限是否超出目標。',
  'locked-known-cost-exceeds-budget': '保留鎖定項目時，已知下限已超過目標預算；只調整未鎖定項目無法達標。',
  'not-proven-infeasible': '鎖定下限未證明不可行；不代表其餘修改足以達標。',
};
const destinationName = (id: string | null) => destinations.find(destination => destination.id === id)?.name ?? '未定';

// Source labels, IDs, reasons and URLs are data. They never become Markdown,
// HTML, link targets or the text of a business conclusion.
function SourceDetails({ source }: { source: Source }) {
  return <span>{source.kind === 'demo' ? 'DEMO 示範資料' : '參考資料'} · 來源 ID：{source.id}<br />
    來源說明：{source.label}<br />查核日期：{source.checkedAt}<br />來源網址：{source.url ?? '未提供'}</span>;
}

function Sources({ source, provenanceSources }: { source: Source; provenanceSources: Source[] }) {
  return <div className="sources"><p>價格來源：<SourceDetails source={source} /></p>
    <p>資料來源（provenance）：{provenanceSources.length === 0 ? '未列額外來源' : null}</p>
    {provenanceSources.length > 0 && <ul>{provenanceSources.map((item, index) =>
      <li key={index}><SourceDetails source={item} /></li>)}</ul>}
  </div>;
}

function Disclosure({ demo }: { demo: boolean }) {
  return <p className="field-hint">{demo ? 'DEMO 示範估算，非真實報價。' : '估算，非確定報價。'}不代表可訂狀態或安全保證。</p>;
}

function BudgetAnswer({ budget }: { budget: BudgetPresentation }) {
  const locked = budget.locked;
  return <section aria-label={budget.scope === 'current' ? '目前行程預算' : '候選修改預算'}>
    <h3>{budget.scope === 'current' ? `目前行程（current）· 版本 ${budget.baseVersion}`
      : `候選修改（candidate）· 以版本 ${budget.baseVersion} 為基礎 · 尚未保存`}</h3>
    <p>已知小計：{formatTwd(budget.known.minor)}（未含未知或排除費用）</p>
    <p>使用者目標預算：{budget.target === null ? '未設定' : formatTwd(budget.target.minor)}（非服務價格或可負擔證據）</p>
    <p>{budget.withinBudget === null ? '尚不能確認全程在預算內。'
      : budget.withinBudget ? '已計入項目在目標預算內。' : '已知費用超過目標預算。'}</p>
    <Disclosure demo={budget.containsDemo} />
    <h4>待確認費用</h4>
    {budget.unknownCosts.length ? <ul>{budget.unknownCosts.map((cost, index) => <li key={index}>
      <p>{cost.title} · 項目 {cost.entryId}：費用未知；來源註記：{cost.reason}</p>
      <Sources source={cost.source} provenanceSources={cost.provenanceSources} />
    </li>)}</ul> : <p>目前計入項目未列未知費用。</p>}
    <h4>未納入費用</h4>
    {budget.exclusions.length ? <ul>{budget.exclusions.map((text, index) => <li key={index}>{text}</li>)}</ul>
      : <p>目前未列額外排除項；未安排的餐飲、交通與裝備不代表免費。</p>}
    <h4>鎖定項目限制</h4>
    <p>鎖定已知下限：{locked.known === null ? '無法計算' : formatTwd(locked.known.minor)}（僅原始鎖定項目，未含未知或排除費用）</p>
    <p>{lockedText[locked.status]}</p>
    <p>原始鎖定項目：{locked.entryIds.length ? locked.entryIds.join('、') : '無'}</p>
    <p>費用未知的鎖定項目：{locked.unknownEntryIds === null ? '無法判定'
      : locked.unknownEntryIds.length ? locked.unknownEntryIds.join('、') : '目前未列'}</p>
    {budget.issues.length > 0 && <div className="issue-box"><h4>需要留意</h4><ul>{budget.issues.map((issue, index) =>
      <li key={index}>{issues[issue.code]}{issue.entryId && <> · 項目 {issue.entryId}</>}（{issue.code}）</li>)}</ul></div>}
    <h4>計價來源與資料出處</h4>
    {budget.sources.length ? <ul>{budget.sources.map((item, index) => <li key={index}>
      <p>行程項目：{item.entryId}</p><Sources source={item.source} provenanceSources={item.provenanceSources} />
    </li>)}</ul> : <p>目前沒有計價來源。</p>}
  </section>;
}

function Receipt({ status, version }: { status: 'applied' | 'rejected'; version: number }) {
  return <p>{status === 'applied' ? `資料已保存：修改已套用，版本 ${version}。`
    : `拒絕決定已保存：修改未套用，行程版本 ${version}。`}</p>;
}

function AnswerBody({ body }: { body: Body }) {
  switch (body.kind) {
    case 'clarify': return <><h3>請補充規劃條件</h3><ul>{body.fields.map(field => <li key={field}>{questions[field]}</li>)}</ul></>;
    case 'requirements': {
      const requirements = body.requirements;
      return <><h3>已保存需求 · 版本 {body.version}</h3><ul>
        <li>目的地：{destinationName(requirements.destinationId)}</li>
        <li>出發日期：{requirements.startDate ?? '未定'} · {requirements.days} 天</li>
        <li>旅客：{requirements.people} 人 · 潛水：{requirements.divers} 人</li>
        <li>使用者目標預算：{requirements.target === null ? '未設定' : formatTwd(requirements.target.minor)}（非服務價格或行程估算，不代表已確認可負擔）</li>
        <li>住宿偏好：{requirements.lodgingPreference || '未提供'}（偏好不代表已選定房型）</li>
        <li>步調：{requirements.pace === 'relaxed' ? '放鬆留白' : '適度安排'}</li>
      </ul></>;
    }
    case 'destinations': return <><h3>可規劃的目的地</h3>
      {body.destinations.length ? <ul>{body.destinations.map((destination, index) => <li key={index}>
        {destinationName(destination.id)}：目錄 {destination.itemCount} 項，其中 DEMO 示範資料 {destination.demoItemCount} 項
      </li>)}</ul> : <p>目前沒有目的地資料。</p>}
      <p>目錄數量不代表可訂狀態或安全保證。</p></>;
    case 'items': return <><h3>{destinationName(body.destinationId)}目錄選項</h3>
      <p>目錄共 {body.total} 項；本次列出 {body.items.length} 項；未列出 {body.omittedCount} 項。不據此判定全目錄最便宜選項。</p>
      {body.items.length ? <ul>{body.items.map((item, index) => <li key={index}>
        <h4>{item.title}</h4><p>目錄項目：{item.id}</p>
        <p>適用對象：{({ all: '所有旅客', divers: '潛水者', 'non-divers': '不潛水者' } as const)[item.audience]}</p>
        {item.capacityPerRoom !== null && <p>每房容量：{item.capacityPerRoom} 人（不代表已安排房數）</p>}
        <p>單價：{item.price === null ? '未知／待確認' : formatTwd(item.price.minor)}／{({ person: '每人', 'room-night': '每房每晚', group: '每組' } as const)[item.unit]}（非行程總價）</p>
        {item.unknownReason !== null && <p>未知費用來源註記：{item.unknownReason}</p>}
        <Disclosure demo={item.containsDemo} /><Sources source={item.source} provenanceSources={item.provenanceSources} />
      </li>)}</ul> : <p>目前沒有符合查詢的目錄項目。</p>}</>;
    case 'budget': return <BudgetAnswer budget={body.budget} />;
    case 'compare-budget': return <><h3>目前與候選預算比較</h3><BudgetAnswer budget={body.current} /><BudgetAnswer budget={body.candidate} /></>;
    case 'conflict': return <><h3>修改存在衝突，暫時無法套用</h3><BudgetAnswer budget={body.budget} /></>;
    case 'proposal': return <><h3>待確認提案</h3><p>共 {body.changeCount} 項修改；接受前尚未套用。請在確認面板檢查差異，再接受或拒絕。</p><BudgetAnswer budget={body.budget} /></>;
    case 'receipt': return <Receipt status={body.status} version={body.version} />;
    case 'unsupported': return <><h3>目前不支援這項要求</h3><p>{unsupportedText[body.reason]}</p></>;
    case 'failure': return <>
      {body.committed && <Receipt status={body.committed.status} version={body.committed.version} />}
      <p role="status">Agent 回合未完成。{body.reason === 'invalid-answer' ? '回答未通過驗證，無法顯示。'
        : body.reason === 'unsupported-version' ? '此回答版本不受支援，無法顯示。' : '未收到完整的受控回答。'}</p>
      <p>{body.committed ? '上述已保存結果仍然有效。' : '請重新讀取行程狀態，確認已保存的內容。'}</p>
    </>;
    default: {
      const exhaustive: never = body;
      return exhaustive;
    }
  }
}

/** Only immutable, versioned public projections reach the controlled renderer. */
export default function AcceptedAnswer({ answer }: { answer: unknown }) {
  const parsed = acceptedAnswerSchema.safeParse(answer);
  if (!parsed.success) return <AnswerUnavailable reason={answerRejectionReason(answer)} />;
  const value = parsed.data;
  return <div className="chat-assistant assistant-message" data-answer-id={value.answerId}>
    <AnswerBody body={value.body} />
    <p className="field-hint">此回答保留當時資料；後續變更請以已保存行程版本為準。回答版本 {value.schemaVersion} · 呈現版本 {value.templateVersion}</p>
  </div>;
}
