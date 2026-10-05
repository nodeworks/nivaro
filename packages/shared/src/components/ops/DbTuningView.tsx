import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context.js'
import { get, patch, post } from '../../lib/commands.js'
import { formatRelative } from '../../lib/utils.js'
import { HighlightedCode } from '../item-edit/HighlightedCode.js'
import { SimpleSelect } from '../ui/SimpleSelect.js'
import { Switch } from '../ui/switch.js'

/**
 * Database tuning (#996): what the nightly observer proposed, the proof behind each proposal,
 * and the one-click Apply / Roll back / Dismiss / Re-prove. Propose-only — nothing changes until
 * an administrator clicks; the request carries the proposal id, never a statement.
 */

export type TuningKind =
  | 'index_create'
  | 'index_drop'
  | 'proc_rewrite'
  | 'rollup_store'
  | 'query_cache'
export type TuningStatus =
  | 'proposed'
  | 'rejected_by_proof'
  | 'stale'
  | 'applying'
  | 'watching'
  | 'applied'
  | 'rolled_back'
  | 'dismissed'
  | 'failed'

export interface TuningProof {
  passed: boolean
  method: string
  before: Record<string, number | string | null>
  after: Record<string, number | string | null>
  detail: string
  rows_diff?: Array<{ set: number; added: string[]; removed: string[] }>
  watch?: Array<{ at: string; value: number | null }>
}

/** Mirror of the API's ProposalRow. */
export interface TuningProposal {
  id: string
  kind: TuningKind
  target: string
  fingerprint: string
  status: TuningStatus
  title: string
  evidence: Record<string, unknown>
  proof: TuningProof | null
  estimate_ms_per_day: number
  risk: 'reversible' | 'review'
  replicated: boolean
  dialect_note: string | null
  apply: Record<string, unknown>
  undo: Record<string, unknown>
  applied_at: string | null
  applied_by: string | null
  watch_until: string | null
  watch_baseline: {
    before: Record<string, number | null>
    after: Record<string, number | null>
  } | null
  rolled_back_at: string | null
  rollback_reason: string | null
  dismissed_at: string | null
  dismissed_by: string | null
  dismiss_note: string | null
  first_seen: string
  last_seen: string
  run_id: number | null
}

export interface TuningSettings {
  enabled: boolean
  ai_rewrites: boolean
  min_estimate_ms_per_day: number
  watch_days: number
  regression_pct: number
  proc_timeout_minutes: number
  ai_daily_budget_usd: number
}

/** GET /db-tuning. */
export interface TuningSummary {
  settings: TuningSettings
  by_status: Record<string, number>
  by_kind: Record<string, number>
  open_estimate_ms_per_day: number
  applied_30d: number
  last_run: {
    id: number
    started_at: string
    status: string
    outcome: string | null
    error: string | null
  } | null
  is_running: boolean
  observers: Array<{ id: string; owner: string; kind: string }>
}

/** What a dry observe run answers. */
export interface TuningObserveReport {
  skipped?: string
  candidates: number
  duplicates: number
  below_floor: number
  proved: number
  proposed: number
  rejected: number
  kept: number
  quiet: number
  carried_over: number
  closed_unseen: number
  by_kind: Record<string, number>
  ms: number
}

type Notice = (message: string, tone?: 'error' | 'success') => void
type TuningAction = 'apply' | 'rollback' | 'dismiss' | 'reprove'
type ApiError = Error & {
  status?: number
  response?: { error?: string; code?: string; problems?: string[] }
}

const errCode = (e: unknown) => (e as ApiError)?.response?.code
const errText = (e: unknown) =>
  (e as ApiError)?.response?.error ?? (e as Error)?.message ?? 'The request failed'

const SUMMARY_KEY = ['db-tuning-summary']
const LIST_KEY = ['db-tuning-proposals']
const DETAIL_KEY = ['db-tuning-proposal']

const KIND_LABEL: Record<TuningKind, string> = {
  index_create: 'Index',
  index_drop: 'Drop index',
  proc_rewrite: 'Rewrite',
  rollup_store: 'Store rollup',
  query_cache: 'Cache query'
}
const KIND_OPTIONS = [
  { value: '', label: 'All kinds' },
  ...(Object.keys(KIND_LABEL) as TuningKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))
]
const TABS: Array<{ key: string; label: string; statuses: TuningStatus[] }> = [
  { key: 'proposed', label: 'Proposed', statuses: ['proposed'] },
  { key: 'watching', label: 'Watching', statuses: ['watching', 'applying'] },
  { key: 'applied', label: 'Applied', statuses: ['applied'] },
  { key: 'rolled_back', label: 'Rolled back', statuses: ['rolled_back', 'failed'] },
  { key: 'rejected', label: 'Rejected by proof', statuses: ['rejected_by_proof'] },
  { key: 'dismissed', label: 'Dismissed', statuses: ['dismissed'] },
  { key: 'stale', label: 'Stale', statuses: ['stale'] }
]
const DISMISSABLE: readonly TuningStatus[] = ['proposed', 'stale', 'rejected_by_proof', 'failed']
const DONE: Record<TuningAction, string> = {
  apply: 'Applied — the change is being watched',
  rollback: 'Rolled back',
  dismiss: 'Dismissed',
  reprove: 'Proof re-run'
}

// Solid pairs, each ≥4.5:1 in light and in dark — never alpha tints.
const PILL = {
  sky: 'bg-[#e0f0fa] text-[#0b5c8a] dark:bg-[#0f2a3d] dark:text-[#7cc4ef]',
  violet: 'bg-[#ece7fa] text-[#5b3aa6] dark:bg-[#261a45] dark:text-[#b9a3f2]',
  green: 'bg-[#e4f4ec] text-[#1c7449] dark:bg-[#133326] dark:text-[#6fd6a0]',
  rose: 'bg-[#fae6eb] text-[#9c2f47] dark:bg-[#3d1621] dark:text-[#f08aa1]',
  amber: 'bg-[#fbefd9] text-[#8f5400] dark:bg-[#3a2a0d] dark:text-[#f1b95c]',
  slate: 'bg-[#eef1f5] text-[#475569] dark:bg-[#1e293b] dark:text-[#cbd5e1]'
}
const STATUS_PILL: Record<TuningStatus, { label: string; cls: string }> = {
  proposed: { label: 'proposed', cls: PILL.sky },
  rejected_by_proof: { label: 'rejected', cls: PILL.amber },
  stale: { label: 'stale', cls: PILL.slate },
  applying: { label: 'applying', cls: PILL.violet },
  watching: { label: 'watching', cls: PILL.violet },
  applied: { label: 'applied', cls: PILL.green },
  rolled_back: { label: 'rolled back', cls: PILL.rose },
  dismissed: { label: 'dismissed', cls: PILL.slate },
  failed: { label: 'failed', cls: PILL.rose }
}
const PILL_BASE = 'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide'
const CODE_CLS =
  'max-h-72 overflow-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-[11px] leading-snug text-slate-800 dark:border-border dark:bg-[#0f172a] dark:text-slate-100'
const BTN_PRIMARY =
  'h-7 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50'
const BTN_OUTLINE =
  'h-7 rounded-md border border-slate-300 bg-white px-2.5 text-[12px] text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
const TEXTAREA_CLS =
  'min-h-[56px] w-full max-w-[60ch] rounded-md border border-slate-300 bg-background px-2 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground dark:border-border'

const hoursPerDay = (ms: number) => (ms / 3_600_000).toFixed(ms >= 3_600_000 ? 1 : 2)

function RiskPill({ risk }: { risk: 'reversible' | 'review' }) {
  return (
    <span
      data-tuning-risk={risk}
      className={`${PILL_BASE} ${risk === 'review' ? PILL.amber : PILL.green}`}
    >
      {risk}
    </span>
  )
}

function StatusPill({ status }: { status: TuningStatus }) {
  const s = STATUS_PILL[status] ?? { label: status, cls: PILL.slate }
  return (
    <span data-tuning-status={status} className={`${PILL_BASE} ${s.cls}`}>
      {s.label}
    </span>
  )
}

function Statement({ spec }: { spec: Record<string, unknown> }) {
  const sql = spec.type === 'sql'
  const body = spec.type === 'proc_body'
  const text = sql
    ? ((spec.statements as string[] | undefined) ?? []).join(';\n')
    : body
      ? String(spec.body ?? '')
      : JSON.stringify(spec.patch ?? spec, null, 2)
  return (
    <pre className={CODE_CLS}>
      <HighlightedCode kind={sql || body ? 'text' : 'json'} text={text} />
    </pre>
  )
}

function WatchCurve({ samples }: { samples: Array<{ at: string; value: number | null }> }) {
  const vals = samples.map((s) => s.value).filter((v): v is number => v != null)
  if (vals.length < 2)
    return <p className='text-[11px] text-muted-foreground'>Waiting for samples…</p>
  const max = Math.max(...vals)
  const pts = vals
    .map((v, i) => `${(i / (vals.length - 1)) * 100},${100 - (v / (max || 1)) * 100}`)
    .join(' ')
  const last = samples[samples.length - 1]
  return (
    <div className='mt-2'>
      <svg
        data-tuning-watch-curve
        viewBox='0 0 100 100'
        preserveAspectRatio='none'
        className='h-12 w-full max-w-[60ch] text-nvr-cyan'
        role='img'
        aria-label={`${vals.length} watch samples`}
      >
        <polyline
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          vectorEffect='non-scaling-stroke'
          points={pts}
        />
      </svg>
      <p className='text-[11px] text-muted-foreground'>
        {vals.length} samples · peak {max.toLocaleString()} ms
        {last?.value != null && ` · latest ${last.value.toLocaleString()} ms`}
        {last && ` · ${formatRelative(last.at)}`}
      </p>
    </div>
  )
}

function ProofSection({ proof }: { proof: TuningProof }) {
  const keys = [...new Set([...Object.keys(proof.before ?? {}), ...Object.keys(proof.after ?? {})])]
  return (
    <section>
      <h4 className='mb-1 flex items-center gap-2 font-semibold text-foreground'>
        Proof ·{' '}
        <span data-tuning-proof-method className='font-normal text-muted-foreground'>
          {proof.method}
        </span>
        <span
          data-tuning-proof-passed={proof.passed ? '1' : '0'}
          className={`${PILL_BASE} ${proof.passed ? PILL.green : PILL.rose}`}
        >
          {proof.passed ? 'passed' : 'failed'}
        </span>
      </h4>
      <p className='text-foreground'>{proof.detail}</p>
      {keys.length > 0 && (
        <table className='mt-1 text-[11px]' data-tuning-proof-figures>
          <thead>
            <tr className='text-left text-muted-foreground'>
              <th className='pr-4 font-normal'>Measure</th>
              <th className='pr-4 font-normal'>Before</th>
              <th className='font-normal'>After</th>
            </tr>
          </thead>
          <tbody className='font-mono tabular-nums text-foreground'>
            {keys.map((k) => (
              <tr key={k}>
                <td className='pr-4 font-sans text-muted-foreground'>{k.replace(/_/g, ' ')}</td>
                <td className='pr-4'>{String(proof.before?.[k] ?? '—')}</td>
                <td>{String(proof.after?.[k] ?? '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {proof.rows_diff?.length ? (
        <ul className='mt-1 space-y-1'>
          {proof.rows_diff.map((d) => (
            <li key={d.set} data-tuning-diff-row className='font-mono text-[11px] text-foreground'>
              set {d.set}: +{d.added.length} −{d.removed.length}
              {d.added.slice(0, 3).map((r) => (
                <span key={`+${r}`} className='block text-emerald-700 dark:text-emerald-300'>
                  + {r}
                </span>
              ))}
              {d.removed.slice(0, 3).map((r) => (
                <span key={`-${r}`} className='block text-rose-700 dark:text-rose-300'>
                  − {r}
                </span>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      {proof.watch?.length ? <WatchCurve samples={proof.watch} /> : null}
    </section>
  )
}

type Mode = 'idle' | 'confirm-apply' | 'confirm-dba' | 'rollback' | 'dismiss'

function ProposalRowView({
  row,
  onDone,
  onNotice
}: {
  row: TuningProposal
  onDone: () => void
  onNotice?: Notice
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('idle')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [stale, setStale] = useState<string | null>(null)
  const detail = useQuery({
    queryKey: [...DETAIL_KEY, row.id],
    queryFn: () =>
      client
        .request(
          get<{ data: TuningProposal }>(`/db-tuning/proposals/${encodeURIComponent(row.id)}`)
        )
        .then((r) => r.data),
    enabled: open
  })
  const p = detail.data ?? row
  const act = useMutation({
    mutationFn: ({ action, body }: { action: TuningAction; body: Record<string, unknown> }) =>
      client.request(post(`/db-tuning/proposals/${encodeURIComponent(p.id)}/${action}`, body)),
    onSuccess: (_r, { action }) => {
      setMode('idle')
      setReason('')
      setNote('')
      setStale(null)
      onNotice?.(DONE[action], 'success')
      onDone()
    },
    onError: (e, { action }) => {
      const code = errCode(e)
      // the live catalog says replicated (whatever the row said): ask for the DBA's go, re-post
      if (action === 'apply' && code === 'TUNING_REPLICATED') {
        setMode('confirm-dba')
        return
      }
      if ((action === 'apply' || action === 'reprove') && code === 'TUNING_STALE') {
        // the API moved the row to stale (or kept it there): refetch it in place
        setMode('idle')
        setStale(errText(e))
        void qc.invalidateQueries({ queryKey: SUMMARY_KEY })
        void qc.invalidateQueries({ queryKey: [...DETAIL_KEY, p.id] })
      }
      onNotice?.(errText(e), 'error')
    }
  })
  const run = (action: TuningAction, body: Record<string, unknown> = {}) =>
    act.mutate({ action, body })
  const dismiss = () => {
    if (note.trim()) run('dismiss', { note: note.trim() })
  }
  const canReprove = p.status === 'stale' || p.status === 'rejected_by_proof'
  return (
    <div
      data-tuning-row={p.id}
      data-tuning-proposal={p.id}
      data-tuning-kind={p.kind}
      className='border-t border-slate-200 first:border-t-0 dark:border-border'
    >
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-tuning-toggle
        className='grid w-full grid-cols-[88px_1fr_auto] items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-muted'
      >
        <span className={`${PILL_BASE} justify-self-start ${PILL.slate}`}>
          {KIND_LABEL[p.kind]}
        </span>
        <span className='min-w-0'>
          <span className='block text-[13px] font-medium text-foreground'>{p.title}</span>
          <span className='block truncate font-mono text-[11px] text-muted-foreground'>
            {p.target}
          </span>
        </span>
        <span className='flex flex-wrap items-center justify-end gap-2'>
          {p.replicated && (
            <span data-tuning-replicated className={`${PILL_BASE} ${PILL.rose}`}>
              replicated
            </span>
          )}
          <StatusPill status={p.status} />
          <RiskPill risk={p.risk} />
          <span className='font-mono text-[12px] tabular-nums text-foreground'>
            {hoursPerDay(p.estimate_ms_per_day)} h/day
          </span>
        </span>
      </button>
      {open && (
        <div className='space-y-3 px-4 pb-4 text-[12px] md:pl-[116px]' data-tuning-detail={p.id}>
          <p className='text-[11px] text-muted-foreground'>
            First seen {formatRelative(p.first_seen)} · last seen {formatRelative(p.last_seen)}
            {p.applied_at && ` · applied ${formatRelative(p.applied_at)}`}
            {p.rolled_back_at && ` · rolled back ${formatRelative(p.rolled_back_at)}`}
            {p.dismissed_at && ` · dismissed ${formatRelative(p.dismissed_at)}`}
          </p>
          {p.dialect_note && <p className='text-muted-foreground'>{p.dialect_note}</p>}
          <section>
            <h4 className='mb-1 font-semibold text-foreground'>Evidence</h4>
            <pre className={`${CODE_CLS} max-h-48`}>
              <HighlightedCode kind='json' text={JSON.stringify(p.evidence, null, 2)} />
            </pre>
          </section>
          {p.proof && <ProofSection proof={p.proof} />}
          <section>
            <h4 className='mb-1 font-semibold text-foreground'>Apply</h4>
            <Statement spec={p.apply} />
          </section>
          <section>
            <h4 className='mb-1 font-semibold text-foreground'>Undo</h4>
            <Statement spec={p.undo} />
          </section>
          {p.rollback_reason && (
            <p className='text-rose-700 dark:text-rose-300' data-tuning-rollback-reason>
              Rolled back: {p.rollback_reason}
            </p>
          )}
          {p.dismiss_note && (
            <p className='text-muted-foreground' data-tuning-dismiss-note-text>
              Dismissed: {p.dismiss_note}
            </p>
          )}
          {stale && (
            <p data-tuning-stale className={`rounded px-2 py-1 ${PILL.amber}`}>
              The database moved since this was proved — {stale}. Re-prove checks the live object
              again; a changed object is proposed afresh by the nightly run.
            </p>
          )}

          {mode === 'confirm-apply' || mode === 'confirm-dba' ? (
            <div className='flex flex-wrap items-center gap-2'>
              <span
                className='text-foreground'
                data-tuning-dba={mode === 'confirm-dba' ? '' : undefined}
              >
                {mode === 'confirm-dba'
                  ? "This table is a replication article — the statement forwards to every subscriber. Apply only with the DBA's go."
                  : 'Apply this change now?'}
              </span>
              <button
                type='button'
                data-tuning-apply-confirm
                data-tuning-action='apply'
                onClick={() => run('apply', { dba_ok: mode === 'confirm-dba' })}
                disabled={act.isPending}
                className={BTN_PRIMARY}
              >
                {mode === 'confirm-dba' ? 'The DBA agreed — apply' : 'Yes, apply'}
              </button>
              <button
                type='button'
                onClick={() => setMode('idle')}
                className='text-[12px] text-muted-foreground underline-offset-2 hover:underline'
              >
                Cancel
              </button>
            </div>
          ) : mode === 'rollback' ? (
            <div className='space-y-2'>
              <textarea
                data-tuning-rollback-reason-input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder='Why roll back? (optional)'
                aria-label='Rollback reason'
                className={TEXTAREA_CLS}
              />
              <div className='flex items-center gap-2'>
                <button
                  type='button'
                  data-tuning-rollback-confirm
                  data-tuning-action='rollback'
                  onClick={() => run('rollback', { reason: reason.trim() })}
                  disabled={act.isPending}
                  className='h-7 rounded-md bg-rose-700 px-2.5 text-[12px] font-semibold text-white hover:bg-rose-800 disabled:opacity-50'
                >
                  Roll back now
                </button>
                <button
                  type='button'
                  onClick={() => setMode('idle')}
                  className='text-[12px] text-muted-foreground underline-offset-2 hover:underline'
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : mode === 'dismiss' ? (
            <div className='space-y-2'>
              <textarea
                data-tuning-dismiss-note
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder='Why dismiss? A note is required.'
                aria-label='Dismiss note'
                className={TEXTAREA_CLS}
              />
              <div className='flex items-center gap-2'>
                <button
                  type='button'
                  data-tuning-dismiss-confirm
                  data-tuning-action='dismiss'
                  onClick={dismiss}
                  disabled={act.isPending || !note.trim()}
                  className={BTN_OUTLINE}
                >
                  Dismiss proposal
                </button>
                <button
                  type='button'
                  onClick={() => setMode('idle')}
                  className='text-[12px] text-muted-foreground underline-offset-2 hover:underline'
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className='flex flex-wrap items-center gap-2'>
              {p.status === 'proposed' && (
                <button
                  type='button'
                  data-tuning-apply
                  onClick={() => setMode(p.replicated ? 'confirm-dba' : 'confirm-apply')}
                  className={BTN_PRIMARY}
                >
                  Apply
                </button>
              )}
              {(p.status === 'watching' || p.status === 'applied') && (
                <button
                  type='button'
                  data-tuning-rollback
                  onClick={() => setMode('rollback')}
                  className='h-7 rounded-md border border-rose-300 px-2.5 text-[12px] font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-muted'
                >
                  Roll back
                </button>
              )}
              {canReprove && (
                <button
                  type='button'
                  data-tuning-reprove
                  data-tuning-action='reprove'
                  onClick={() => run('reprove')}
                  disabled={act.isPending}
                  className={BTN_OUTLINE}
                >
                  {act.isPending ? 'Proving…' : 'Re-prove'}
                </button>
              )}
              {DISMISSABLE.includes(p.status) && (
                <button
                  type='button'
                  data-tuning-dismiss
                  onClick={() => setMode('dismiss')}
                  className='text-[12px] text-muted-foreground underline-offset-2 hover:underline'
                >
                  Dismiss
                </button>
              )}
              {p.watch_until && p.status === 'watching' && (
                <span className='text-muted-foreground'>
                  Watching until {new Date(p.watch_until).toLocaleString()}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type NumKey = Exclude<keyof TuningSettings, 'enabled' | 'ai_rewrites'>
const NUM_FIELDS: Array<[NumKey, string]> = [
  ['min_estimate_ms_per_day', 'List floor (ms saved / day)'],
  ['watch_days', 'Watch window (days)'],
  ['regression_pct', 'Regression threshold (%)'],
  ['proc_timeout_minutes', 'Proof timeout per procedure (min)'],
  ['ai_daily_budget_usd', 'AI budget (USD / day)']
]

function SettingsCard({
  s,
  onSaved,
  onNotice
}: {
  s: TuningSettings
  onSaved: () => void
  onNotice?: Notice
}) {
  const client = useNivaroClient()
  const id = useId()
  const [enabled, setEnabled] = useState(s.enabled)
  const [aiRewrites, setAiRewrites] = useState(s.ai_rewrites)
  const [nums, setNums] = useState(
    () => Object.fromEntries(NUM_FIELDS.map(([k]) => [k, String(s[k])])) as Record<NumKey, string>
  )
  const [problems, setProblems] = useState<string[]>([])
  const dirty =
    enabled !== s.enabled ||
    aiRewrites !== s.ai_rewrites ||
    NUM_FIELDS.some(([k]) => nums[k] !== String(s[k]))
  const save = useMutation({
    mutationFn: () =>
      client.request(
        patch('/db-tuning/settings', {
          enabled,
          ai_rewrites: aiRewrites,
          ...Object.fromEntries(NUM_FIELDS.map(([k]) => [k, Number(nums[k])]))
        })
      ),
    onSuccess: () => {
      setProblems([])
      onNotice?.('Tuning settings saved', 'success')
      onSaved()
    },
    onError: (e) => {
      setProblems((e as ApiError)?.response?.problems ?? [])
      onNotice?.(errText(e), 'error')
    }
  })
  return (
    <div
      data-tuning-settings
      className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
    >
      <h3 className='mb-3 text-[13px] font-semibold text-foreground'>Settings</h3>
      <div className='mb-3 space-y-2 text-[12px]'>
        <div className='flex items-center gap-2'>
          <Switch
            id={`${id}-enabled`}
            checked={enabled}
            onCheckedChange={setEnabled}
            data-tuning-setting='enabled'
          />
          <label htmlFor={`${id}-enabled`} className='text-foreground'>
            Run the nightly observer (off = nothing is proposed)
          </label>
        </div>
        <div className='flex items-center gap-2'>
          <Switch
            id={`${id}-ai`}
            checked={aiRewrites}
            onCheckedChange={setAiRewrites}
            data-tuning-setting='ai_rewrites'
          />
          <label htmlFor={`${id}-ai`} className='text-foreground'>
            Let the AI provider draft rewrites the mechanical transformers cannot
          </label>
        </div>
      </div>
      <div className='grid max-w-[44rem] gap-x-6 gap-y-1.5 md:grid-cols-2'>
        {NUM_FIELDS.map(([k, label]) => (
          <label key={k} className='flex items-center justify-between gap-3 text-[12px]'>
            <span className='text-muted-foreground'>{label}</span>
            <input
              type='number'
              inputMode='decimal'
              data-tuning-setting={k}
              value={nums[k]}
              onChange={(e) => setNums({ ...nums, [k]: e.target.value })}
              className='h-7 w-24 rounded border border-slate-300 bg-background px-2 text-right tabular-nums text-foreground dark:border-border'
            />
          </label>
        ))}
      </div>
      {problems.length > 0 && (
        <ul
          data-tuning-settings-problems
          className='mt-2 space-y-0.5 text-[12px] text-rose-700 dark:text-rose-300'
        >
          {problems.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <button
        type='button'
        data-tuning-settings-save
        onClick={() => save.mutate()}
        disabled={save.isPending || !dirty}
        className={`${BTN_PRIMARY} mt-3`}
      >
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}

function DryReport({ r, onClose }: { r: TuningObserveReport; onClose: () => void }) {
  const kinds = Object.entries(r.by_kind ?? {})
  return (
    <div
      data-tuning-dry-report
      className='flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] text-foreground dark:border-border dark:bg-card'
    >
      <span className='font-semibold'>Dry run</span>
      {r.skipped ? (
        <span className='text-muted-foreground'>skipped — {r.skipped}</span>
      ) : (
        <>
          <span>{r.candidates} candidates</span>
          <span className='text-muted-foreground'>{r.duplicates} already listed</span>
          <span className='text-muted-foreground'>{r.below_floor} below the floor</span>
          {r.carried_over > 0 && (
            <span className='text-muted-foreground'>{r.carried_over} carried over</span>
          )}
          {kinds.length > 0 && (
            <span className='text-muted-foreground'>
              would prove:{' '}
              {kinds.map(([k, n]) => `${KIND_LABEL[k as TuningKind] ?? k} ${n}`).join(', ')}
            </span>
          )}
          <span className='text-muted-foreground'>{(r.ms / 1000).toFixed(1)}s</span>
        </>
      )}
      <button
        type='button'
        onClick={onClose}
        className='ml-auto text-muted-foreground underline-offset-2 hover:underline'
      >
        Close
      </button>
    </div>
  )
}

export function DbTuningView({ onNotice }: { onNotice?: Notice }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [tab, setTab] = useState('proposed')
  const [kind, setKind] = useState('')
  const [dry, setDry] = useState<TuningObserveReport | null>(null)
  const summary = useQuery({
    queryKey: SUMMARY_KEY,
    queryFn: () => client.request(get<{ data: TuningSummary }>('/db-tuning')).then((r) => r.data),
    refetchInterval: (q) => (q.state.data?.is_running ? 3000 : 30_000)
  })
  const statuses = useMemo(
    () => TABS.find((t) => t.key === tab)?.statuses ?? (['proposed'] as TuningStatus[]),
    [tab]
  )
  const list = useQuery({
    queryKey: [...LIST_KEY, statuses, kind],
    queryFn: () =>
      client
        .request(
          get<{ data: TuningProposal[] }>('/db-tuning/proposals', {
            status: statuses.join(','),
            kind: kind || undefined
          })
        )
        .then((r) => r.data)
  })
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: SUMMARY_KEY })
    void qc.invalidateQueries({ queryKey: LIST_KEY })
    void qc.invalidateQueries({ queryKey: DETAIL_KEY })
  }, [qc])
  const observe = useMutation({
    mutationFn: (dryRun: boolean) =>
      client.request(
        post<{ data: TuningObserveReport | { started: true } }>('/db-tuning/observe', {
          dry_run: dryRun
        })
      ),
    onSuccess: (r, dryRun) => {
      if (dryRun) setDry(r.data as TuningObserveReport)
      else onNotice?.('Observe run started — the list refreshes when it finishes', 'success')
      refresh()
    },
    onError: (e) => onNotice?.(errText(e), 'error')
  })
  const s = summary.data
  const running = !!s?.is_running
  // a background run just finished: what it proposed or rejected is in the list now
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) refresh()
    wasRunning.current = running
  }, [running, refresh])
  const count = (t: (typeof TABS)[number]) =>
    t.statuses.reduce((n, st) => n + (s?.by_status[st] ?? 0), 0)
  return (
    <div className='space-y-4 p-6' data-tuning-view>
      {summary.isError && (
        <p className={`rounded px-3 py-2 text-[12px] ${PILL.rose}`}>
          Could not load database tuning — {errText(summary.error)}
        </p>
      )}
      {s && !s.settings.enabled && (
        <p
          data-tuning-inert
          className={`rounded border border-[#e7c98f] px-3 py-2 text-[12px] dark:border-[#5c4417] ${PILL.amber}`}
        >
          Database tuning is off — turn it on below and the nightly observer starts proposing.
          Nothing applies without a click either way.
        </p>
      )}
      <div
        data-tuning-strip
        className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border md:grid-cols-5'
      >
        {[
          ['Open proposals', String(s?.by_status.proposed ?? 0)],
          ['Est. hours/day saved', s ? hoursPerDay(s.open_estimate_ms_per_day) : '—'],
          ['Applied, 30 days', String(s?.applied_30d ?? 0)],
          ['Rolled back', String(s?.by_status.rolled_back ?? 0)],
          [
            'Last run',
            running
              ? 'running now'
              : s?.last_run
                ? `${formatRelative(s.last_run.started_at)} · ${s.last_run.status}`
                : 'never'
          ]
        ].map(([l, v]) => (
          <div
            key={l}
            className='col-span-1 bg-white p-3 dark:bg-card last:col-span-2 md:last:col-span-1'
          >
            <div className='text-[10px] uppercase tracking-wide text-muted-foreground'>{l}</div>
            <div
              className='truncate text-[18px] font-semibold tabular-nums text-foreground'
              title={l === 'Last run' ? (s?.last_run?.error ?? s?.last_run?.outcome ?? '') : ''}
            >
              {v}
            </div>
          </div>
        ))}
      </div>
      <div className='flex flex-wrap items-center gap-2'>
        {TABS.map((t) => (
          <button
            key={t.key}
            type='button'
            data-tuning-tab={t.key}
            aria-pressed={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-full border px-3 py-1 text-[12px] ${tab === t.key ? 'border-nvr-cyan bg-nvr-cyan/10 font-semibold text-foreground' : 'border-slate-200 text-muted-foreground hover:text-foreground dark:border-border'}`}
          >
            {t.label}
            {count(t) ? ` · ${count(t)}` : ''}
          </button>
        ))}
        <SimpleSelect
          value={kind}
          onChange={setKind}
          options={KIND_OPTIONS}
          ariaLabel='Filter by kind'
          className='h-7 w-36 text-[12px]'
          triggerProps={{ 'data-tuning-kind-filter': '' }}
        />
        <span className='flex-1' />
        <button
          type='button'
          data-tuning-observe='dry'
          onClick={() => observe.mutate(true)}
          disabled={observe.isPending || running}
          className={BTN_OUTLINE}
        >
          Dry run
        </button>
        <button
          type='button'
          data-tuning-observe='run'
          onClick={() => observe.mutate(false)}
          disabled={observe.isPending || running || !s?.settings.enabled}
          title={s && !s.settings.enabled ? 'Turn database tuning on to run the observer' : ''}
          className={BTN_OUTLINE}
        >
          {running ? 'Observing…' : 'Observe now'}
        </button>
      </div>
      {dry && <DryReport r={dry} onClose={() => setDry(null)} />}
      <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        {list.isLoading ? (
          <p className='p-6 text-[12px] text-muted-foreground'>Loading…</p>
        ) : list.isError ? (
          <p className='p-6 text-[12px] text-rose-700 dark:text-rose-300'>
            Could not load proposals — {errText(list.error)}
          </p>
        ) : list.data?.length ? (
          list.data.map((p) => (
            <ProposalRowView key={p.id} row={p} onDone={refresh} onNotice={onNotice} />
          ))
        ) : (
          <p className='p-6 text-[12px] text-muted-foreground' data-tuning-empty>
            {tab === 'proposed'
              ? 'Nothing to propose right now. The observer runs nightly; Observe now asks it early.'
              : 'Nothing here.'}
          </p>
        )}
      </div>
      {s && (
        <SettingsCard
          key={JSON.stringify(s.settings)}
          s={s.settings}
          onSaved={refresh}
          onNotice={onNotice}
        />
      )}
    </div>
  )
}
