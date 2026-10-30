import { AlertOctagon, AlertTriangle, Info } from 'lucide-react'
import { useState } from 'react'
import { useCcQuery } from '../api'
import { useCc } from '../state'
import { BUTTON, FAINT, FOCUS, MUTED, PANEL, PANEL_HEAD, TITLE } from '../theme'
import type { AttentionAction, AttentionItem } from '../types'
import { sinceShort, stateListUrl } from '../work-links'
import { ApproveForm, NudgeForm, ReassignForm, TransitionForm } from './attention-actions'

/**
 * Needs attention (CC-1, CC-6, CC-30, CC-31): a compact risk summary (SLA past / near deadline,
 * at-risk of tracked, open issues — the snapshot's risk block, the viewer's own records) over the
 * ranked list from /command-center/attention. Each row says its severity in an icon AND a word,
 * what it is, how many, how long; a record opens in the peek panel, a group opens its list. Row
 * actions (nudge, move, approve, reassign, alert me) open inline under the row and never show on
 * a wallboard link.
 */
const SEVERITY = {
  critical: { Icon: AlertOctagon, word: 'Critical', tone: 'text-[var(--cc-bad-text)]' },
  warning: { Icon: AlertTriangle, word: 'Warning', tone: 'text-[var(--cc-warn-text)]' },
  info: { Icon: Info, word: 'Info', tone: 'text-[var(--cc-muted)]' }
} as const

/** Rows shown before the rest fold behind "Show all". */
const ATTENTION_FOLD = 8

export function AttentionPanel() {
  const cc = useCc()
  const q = useCcQuery<AttentionItem[]>('/attention', undefined, { refetchInterval: 60_000 })
  const items = q.data ?? []
  // The list is ranked, so the top few are what matters; the rest folds away so the
  // panels under it stay in view (a wall screen nobody scrolls never sees them otherwise).
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? items : items.slice(0, ATTENTION_FOLD)
  const hidden = items.length - shown.length
  return (
    <section className={PANEL} data-cc-panel='attention' aria-busy={q.isLoading}>
      <div className={PANEL_HEAD}>
        <h2 className={TITLE}>Needs attention</h2>
        <span className={`text-[11px] tabular-nums ${FAINT}`}>
          {cc.at ? 'Live — not rewound' : items.length > 0 ? items.length : ''}
        </span>
      </div>
      <RiskSummary />
      <ul className='divide-y divide-[var(--cc-border)]'>
        {shown.map((it) => (
          <AttentionRow key={it.id} item={it} />
        ))}
      </ul>
      {(hidden > 0 || expanded) && items.length > ATTENTION_FOLD && (
        <div className='border-t border-[var(--cc-border)] px-3 py-2'>
          {cc.kiosk || cc.tv ? (
            <span className={`text-[11.5px] ${FAINT}`}>+{hidden} more</span>
          ) : (
            <button
              type='button'
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className={`text-[11.5px] font-medium text-[var(--cc-text)] underline-offset-2 hover:underline ${FOCUS}`}
            >
              {expanded ? 'Show fewer' : `Show all ${items.length}`}
            </button>
          )}
        </div>
      )}
      {!q.isLoading && items.length === 0 && (
        <p className={`px-3 py-3 text-[12px] ${FAINT}`}>
          {q.isError ? 'Could not load this list.' : 'Nothing needs attention right now.'}
        </p>
      )}
    </section>
  )
}

/** The snapshot's risk numbers in one line — words + numbers, never colour alone. */
function RiskSummary() {
  const cc = useCc()
  const r = cc.snapshot?.risk
  if (!r) return null
  const parts: Array<{ key: string; text: string; tone: string; Icon?: typeof AlertOctagon }> = []
  if (r.sla_breached != null)
    parts.push({
      key: 'b',
      text: `${r.sla_breached} past deadline`,
      tone: r.sla_breached > 0 ? 'text-[var(--cc-bad-text)]' : MUTED,
      Icon: r.sla_breached > 0 ? AlertOctagon : undefined
    })
  if (r.sla_warning != null)
    parts.push({
      key: 'w',
      text: `${r.sla_warning} near deadline`,
      tone: r.sla_warning > 0 ? 'text-[var(--cc-warn-text)]' : MUTED,
      Icon: r.sla_warning > 0 ? AlertTriangle : undefined
    })
  if (r.tracked > 0)
    parts.push({ key: 'r', text: `${r.at_risk} at risk of ${r.tracked} tracked`, tone: MUTED })
  if ((r.open_issues ?? 0) > 0)
    parts.push({ key: 'i', text: `${r.open_issues} open issues`, tone: MUTED })
  if (parts.length === 0) return null
  return (
    <p className='flex flex-wrap gap-x-3 gap-y-1 border-b border-[var(--cc-border)] px-3 py-2 text-[11.5px]'>
      <span className='sr-only'>Risk summary:</span>
      {parts.map((p) => (
        <span key={p.key} className={`flex items-center gap-1 tabular-nums ${p.tone}`}>
          {p.Icon && <p.Icon className='h-3 w-3' aria-hidden />}
          {p.text}
        </span>
      ))}
    </p>
  )
}

type OpenForm =
  | { kind: 'nudge'; target: { collection: string; id: string } }
  | { kind: 'transition'; target: { collection: string; id: string } }
  | { kind: 'approve'; approvalId: number }
  | { kind: 'reassign'; targets: Array<{ collection: string; id: string }> }

function AttentionRow({ item }: { item: AttentionItem }) {
  const cc = useCc()
  const [form, setForm] = useState<OpenForm | null>(null)
  const sev = SEVERITY[item.severity]
  const since = sinceShort(item.since)
  const listHref = item.list
    ? stateListUrl(item.list.collection, {
        state: item.list.state,
        minAgeHours: item.list.min_age_hours
      })
    : null
  const openMain = () => {
    if (item.record && !item.list) cc.setPeek(item.record)
    else if (listHref) cc.navigate(listHref)
    else if (item.href) cc.navigate(item.href)
    else if (item.record) cc.setPeek(item.record)
  }
  const canAct = !cc.kiosk
  const act = (a: AttentionAction) => {
    if (a.kind === 'open') {
      if (a.href) cc.navigate(a.href)
      else if (a.target) cc.setPeek({ collection: a.target.collection, id: a.target.id })
      else openMain()
      return
    }
    if (a.kind === 'alert' && a.href) return cc.navigate(a.href)
    if (a.kind === 'nudge' && a.target) return setForm({ kind: 'nudge', target: a.target })
    if (a.kind === 'transition' && a.target)
      return setForm({ kind: 'transition', target: a.target })
    if (a.kind === 'approve' && a.target?.approval_id != null)
      return setForm({ kind: 'approve', approvalId: a.target.approval_id })
    if (a.kind === 'reassign' && a.targets?.length)
      return setForm({ kind: 'reassign', targets: a.targets })
  }
  const actions = item.actions.filter(
    (a) => a.kind === 'open' || (canAct && (a.kind !== 'alert' || cc.isAdmin))
  )
  return (
    <li className='px-3 py-2'>
      <div className='flex items-start gap-2'>
        <span
          className={`mt-0.5 flex shrink-0 items-center gap-1 text-[10.5px] font-semibold ${sev.tone}`}
        >
          <sev.Icon className='h-3.5 w-3.5' aria-hidden />
          <span className='w-[50px]'>{sev.word}</span>
        </span>
        <div className='min-w-0 flex-1'>
          <button
            type='button'
            onClick={openMain}
            className={`block max-w-full truncate rounded text-left text-[12.5px] font-medium text-[var(--cc-strong)] hover:underline ${FOCUS}`}
          >
            {item.title}
          </button>
          {item.detail && <p className={`truncate text-[11.5px] ${MUTED}`}>{item.detail}</p>}
        </div>
        <div className='shrink-0 text-right text-[11px] tabular-nums'>
          {item.count != null && item.count > 1 && (
            <div className='font-semibold text-[var(--cc-text)]'>{item.count}</div>
          )}
          {since && (
            <div className={FAINT} data-tip='How long it has been like this'>
              {since}
            </div>
          )}
        </div>
      </div>
      {actions.length > 0 && !form && (
        <div className='mt-1.5 flex flex-wrap gap-1.5 pl-[70px]'>
          {actions.map((a) => (
            <button
              key={`${a.kind}:${a.label}`}
              type='button'
              onClick={() => act(a)}
              className={`${BUTTON} py-0.5 ${FOCUS}`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      {form && canAct && (
        <div className='mt-2 ml-[70px] rounded-md bg-[var(--cc-raised)] p-2'>
          {form.kind === 'nudge' && <NudgeForm target={form.target} onDone={() => setForm(null)} />}
          {form.kind === 'transition' && (
            <TransitionForm target={form.target} onDone={() => setForm(null)} />
          )}
          {form.kind === 'approve' && (
            <ApproveForm approvalId={form.approvalId} onDone={() => setForm(null)} />
          )}
          {form.kind === 'reassign' && (
            <ReassignForm targets={form.targets} onDone={() => setForm(null)} />
          )}
        </div>
      )}
    </li>
  )
}
