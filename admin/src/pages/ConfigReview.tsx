import { QueryErrorState } from '@nivaro/shared'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn, formatFileSize } from '@/lib/utils'

/**
 * Config Review (#1913 / #1961 / #2020 / #1999) — the monthly report on the
 * configuration itself: rules that contradict each other, fields nothing
 * uses, layouts nobody can open, duplicate views, owner groups with only
 * inactive members (Review); things to tidy with their impact (Cleanup); and
 * one concept labelled several ways (Labels). A finding with a fix previews
 * its change set first; applied fixes stay under "Fixed" with their undo.
 */

type Family = 'review' | 'cleanup' | 'label'
type Status = 'open' | 'fixed' | 'dismissed'

interface Applied {
  at: string
  by: string | null
  title: string
  total: number
  undo: { kind: string } | null
}

interface Detail {
  reason: string
  ai_reason?: string
  impact?: { count?: number; bytes?: number; text?: string }
  fix?: { kind: string; label: string; undoable: boolean } | null
  data?: {
    suggested?: string
    ai_label?: string
    labels?: Array<{ label: string; count: number }>
    blocked?: string | null
    files?: Array<{ id: string; name: string | null; bytes: number; uploaded_on: string }>
    [k: string]: unknown
  }
  applied?: Applied[]
  can_undo: boolean
}

interface Finding {
  id: number
  family: Family
  code: string
  title: string
  detail: Detail
  severity: 'info' | 'warning'
  href: string | null
  status: Status
  first_seen: string
  last_seen: string
}

interface ChangeSet {
  kind: string
  title: string
  lines: Array<{
    action: string
    target: string
    before?: string | null
    after?: string | null
    href?: string
  }>
  total: number
  undoable: boolean
  note?: string
  ids: string[]
  hash: string
}

interface ReviewResponse {
  data: Finding[]
  counts: Array<{ family: string; status: string; c: number }>
  running: { since: string } | null
  last_run: {
    status: string
    started_at: string
    finished_at: string | null
    outcome: string | null
  } | null
}

interface CleanupSettings {
  cleanup: { draftMonths: number; taskMonths: number; viewDays: number }
  defaults: { draftMonths: number; taskMonths: number; viewDays: number }
  bounds: Record<'draftMonths' | 'taskMonths' | 'viewDays', [number, number]>
}

/** Mirrors CLEANUP_BOUNDS on the server until /settings answers. */
const FALLBACK_BOUNDS: CleanupSettings['bounds'] = {
  draftMonths: [1, 24],
  taskMonths: [1, 24],
  viewDays: [30, 365]
}

const FAMILIES: Array<{ value: Family; label: string; hint: string }> = [
  { value: 'review', label: 'Review', hint: 'Configuration problems' },
  { value: 'cleanup', label: 'Cleanup', hint: 'Things to tidy' },
  { value: 'label', label: 'Labels', hint: 'One concept, several labels' }
]

const CODE_LABEL: Record<string, string> = {
  'rule-contradiction': 'Contradicting rules',
  'rule-duplicate': 'Duplicate rules',
  'view-duplicate': 'Duplicate views',
  'field-empty-on-layout': 'Empty fields on layouts',
  'field-unused': 'Unused fields',
  'layout-unreachable': 'Layouts nobody opens',
  'owner-group-inactive': 'Inactive owner groups',
  'owner-filter': 'Owner filters that cannot match',
  'pipeline-lint': 'Pipeline problems',
  'dead-column': 'Retired columns',
  'drafts-stale': 'Old drafts',
  'tasks-idle': 'Idle tasks',
  'files-orphan': 'Unreferenced files',
  'views-unopened': 'Unopened views',
  'label-inconsistent': 'Inconsistent labels'
}

const errText = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback

const chip =
  'rounded-md border border-[#00ceff66] bg-[#00ceff0d] px-2 py-1 text-[11.5px] font-medium text-[#007a99] disabled:opacity-50 dark:text-nvr-cyan'

export default function ConfigReview() {
  const qc = useQueryClient()
  const [family, setFamily] = useState<Family>('review')
  const [status, setStatus] = useState<Status>('open')
  const [codeFilter, setCodeFilter] = useState<string | null>(null)
  const [openFix, setOpenFix] = useState<number | null>(null)
  const [ai, setAi] = useState(true)
  const [cut, setCut] = useState({ draft_months: 3, task_months: 3, view_days: 90 })
  // The saved cleanup defaults seed the controls once; the monthly run uses them too.
  const settings = useQuery({
    queryKey: ['config-review-settings'],
    queryFn: () =>
      api.get<{ data: CleanupSettings }>('/config-review/settings').then((r) => r.data.data)
  })
  const seeded = useRef(false)
  useEffect(() => {
    const c = settings.data?.cleanup
    if (!c || seeded.current) return
    seeded.current = true
    setCut({ draft_months: c.draftMonths, task_months: c.taskMonths, view_days: c.viewDays })
  }, [settings.data])
  const bounds = settings.data?.bounds ?? FALLBACK_BOUNDS
  const inRange = (v: number, [min, max]: [number, number]) =>
    Number.isInteger(v) && v >= min && v <= max
  const cutValid =
    inRange(cut.draft_months, bounds.draftMonths) &&
    inRange(cut.task_months, bounds.taskMonths) &&
    inRange(cut.view_days, bounds.viewDays)
  const saved = settings.data?.cleanup
  const cutDirty =
    !!saved &&
    (saved.draftMonths !== cut.draft_months ||
      saved.taskMonths !== cut.task_months ||
      saved.viewDays !== cut.view_days)
  const saveDefaults = useMutation({
    mutationFn: () =>
      api.put('/config-review/settings', {
        cleanup: {
          draftMonths: cut.draft_months,
          taskMonths: cut.task_months,
          viewDays: cut.view_days
        }
      }),
    onSuccess: () => {
      toast.success('Saved — the monthly review uses these thresholds')
      void qc.invalidateQueries({ queryKey: ['config-review-settings'] })
    },
    onError: (e) => toast.error(errText(e, 'Could not save the thresholds'))
  })

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['config-review', family, status],
    queryFn: () =>
      api.get<ReviewResponse>('/config-review', { params: { family, status } }).then((r) => r.data),
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false)
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['config-review'] })

  const run = useMutation({
    mutationFn: () => api.post('/config-review/run', { ai, ...cut }),
    onSuccess: () => {
      toast.success('Review started — findings refresh when it finishes')
      invalidate()
    },
    onError: (e) => toast.error(errText(e, 'Could not start the review'))
  })
  const dismiss = useMutation({
    mutationFn: (id: number) => api.post(`/config-review/${id}/dismiss`),
    onSuccess: invalidate
  })
  const undo = useMutation({
    mutationFn: (id: number) =>
      api
        .post<{ data: { restored: number } }>(`/config-review/${id}/undo`)
        .then((r) => r.data.data),
    onSuccess: (d) => {
      toast.success(`Undone — ${d.restored} change(s) put back`)
      invalidate()
    },
    onError: (e) => toast.error(errText(e, 'Undo failed'))
  })

  const all = data?.data ?? []
  const rows = all.filter((f) => !codeFilter || f.code === codeFilter)
  const byCode = new Map<string, number>()
  for (const f of all) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1)
  const countOf = (fam: string, st: string) =>
    Number(data?.counts.find((c) => c.family === fam && c.status === st)?.c ?? 0)
  const running = !!data?.running

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description='A monthly report on the configuration itself. Each finding says why it matters, links to its editor and, where it can, offers a fix you preview before applying.'
        actions={
          <>
            <label className='flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
              <input
                type='checkbox'
                checked={ai}
                onChange={(e) => setAi(e.target.checked)}
                className='h-3.5 w-3.5'
              />
              AI wording
            </label>
            <Button
              size='sm'
              className='h-8 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
              disabled={run.isPending || running || !cutValid}
              onClick={() => run.mutate()}
              data-cr-run={running ? 'running' : 'idle'}
            >
              {running ? 'Reviewing…' : 'Run review now'}
            </Button>
          </>
        }
      >
        <div className='mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          <span>
            {data?.last_run
              ? `Last run ${new Date(data.last_run.started_at).toLocaleString()} · ${data.last_run.status}${data.last_run.outcome ? ` · ${data.last_run.outcome}` : ''}`
              : 'Not run yet — it runs on the 1st of each month.'}
          </span>
          <span className='flex items-center gap-1'>
            Drafts older than
            <NumberBox
              value={cut.draft_months}
              range={bounds.draftMonths}
              onChange={(v) => setCut((c) => ({ ...c, draft_months: v }))}
            />
            months · tasks idle
            <NumberBox
              value={cut.task_months}
              range={bounds.taskMonths}
              onChange={(v) => setCut((c) => ({ ...c, task_months: v }))}
            />
            months · views unopened
            <NumberBox
              value={cut.view_days}
              range={bounds.viewDays}
              onChange={(v) => setCut((c) => ({ ...c, view_days: v }))}
            />
            days
            {cutDirty && (
              <button
                type='button'
                disabled={!cutValid || saveDefaults.isPending}
                onClick={() => saveDefaults.mutate()}
                data-cr-save-defaults
                className='ml-1.5 rounded px-1.5 py-0.5 text-[11.5px] font-medium text-[#007a99] underline decoration-dotted underline-offset-2 hover:text-nvr-cyan disabled:opacity-50 dark:text-nvr-cyan'
              >
                {saveDefaults.isPending ? 'Saving…' : 'Save as defaults'}
              </button>
            )}
          </span>
        </div>
      </HubToolbar>

      <div className='flex-1 space-y-3 overflow-y-auto p-4 sm:p-6'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
            {FAMILIES.map((t) => (
              <button
                key={t.value}
                type='button'
                data-tip={t.hint}
                onClick={() => {
                  setFamily(t.value)
                  setCodeFilter(null)
                  setOpenFix(null)
                }}
                className={cn(
                  'rounded px-2.5 py-1 text-[12px] font-medium',
                  family === t.value
                    ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                    : 'text-slate-400 hover:text-slate-600'
                )}
              >
                {t.label} <span className='font-normal'>{countOf(t.value, 'open')}</span>
              </button>
            ))}
          </span>
          <span className='ml-auto flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
            {(['open', 'fixed', 'dismissed'] as const).map((s) => (
              <button
                key={s}
                type='button'
                onClick={() => {
                  setStatus(s)
                  setCodeFilter(null)
                  setOpenFix(null)
                }}
                className={cn(
                  'rounded px-2.5 py-1 text-[12px] font-medium capitalize',
                  status === s
                    ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                    : 'text-slate-400 hover:text-slate-600'
                )}
              >
                {s} <span className='font-normal'>{countOf(family, s)}</span>
              </button>
            ))}
          </span>
        </div>

        {byCode.size > 1 && (
          <div className='flex flex-wrap gap-1.5'>
            {[...byCode.entries()]
              .sort((a, z) => z[1] - a[1])
              .map(([code, count]) => (
                <button
                  key={code}
                  type='button'
                  onClick={() => setCodeFilter(codeFilter === code ? null : code)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[11.5px]',
                    codeFilter === code
                      ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                      : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-border dark:text-muted-foreground'
                  )}
                >
                  {CODE_LABEL[code] ?? code} <span className='font-medium'>{count}</span>
                </button>
              ))}
          </div>
        )}

        {isLoading && <p className='text-[12px] text-slate-400'>Loading…</p>}
        {isError && !data && (
          <QueryErrorState error={error} what='the review' onRetry={() => void refetch()} />
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <div className='rounded-lg border border-dashed border-slate-300 p-8 text-center dark:border-border'>
            <p className='text-[13px] font-medium text-slate-500 dark:text-muted-foreground'>
              {status === 'open'
                ? data?.last_run
                  ? 'Nothing to review here.'
                  : 'No findings yet — run the review to check.'
                : `No ${status} findings.`}
            </p>
          </div>
        )}
        <div className='space-y-1.5'>
          {rows.map((f) => (
            <FindingCard
              key={f.id}
              f={f}
              fixOpen={openFix === f.id}
              onToggleFix={() => setOpenFix(openFix === f.id ? null : f.id)}
              onApplied={() => {
                setOpenFix(null)
                invalidate()
              }}
              onDismiss={() => dismiss.mutate(f.id)}
              onUndo={() => undo.mutate(f.id)}
              undoing={undo.isPending && undo.variables === f.id}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function NumberBox({
  value,
  range: [min, max],
  onChange
}: {
  value: number
  range: [number, number]
  onChange: (v: number) => void
}) {
  // Not clamped while typing ("4" on the way to "45" days); out of range shows red.
  const bad = !Number.isInteger(value) || value < min || value > max
  return (
    <input
      type='number'
      min={min}
      max={max}
      value={Number.isFinite(value) ? value : ''}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-invalid={bad}
      data-tip={`${min}–${max}`}
      className={cn(
        'h-6 w-14 rounded border bg-white px-1.5 text-[11.5px] text-slate-700 dark:bg-background dark:text-foreground',
        bad ? 'border-red-400 dark:border-red-500/60' : 'border-slate-200 dark:border-border'
      )}
    />
  )
}

function FindingCard({
  f,
  fixOpen,
  onToggleFix,
  onApplied,
  onDismiss,
  onUndo,
  undoing
}: {
  f: Finding
  fixOpen: boolean
  onToggleFix: () => void
  onApplied: () => void
  onDismiss: () => void
  onUndo: () => void
  undoing: boolean
}) {
  const d = f.detail
  const impact = d.impact
  const last = d.applied?.[0]
  return (
    <div
      data-cr-finding={f.code}
      className={cn(
        'rounded-lg border bg-white px-4 py-2.5 dark:bg-card',
        f.severity === 'warning' && f.status === 'open'
          ? 'border-amber-200 dark:border-amber-500/30'
          : 'border-slate-200 dark:border-border',
        f.status === 'dismissed' && 'opacity-60'
      )}
    >
      <div className='flex items-start gap-3'>
        <span
          className={cn(
            'mt-1.5 h-2 w-2 shrink-0 rounded-full',
            f.severity === 'warning' ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600'
          )}
        />
        <div className='min-w-0 flex-1'>
          <p className='text-[12.5px] text-slate-800 dark:text-foreground'>
            {f.href ? (
              <Link
                to={f.href}
                className='underline decoration-dotted underline-offset-2 hover:text-nvr-cyan'
              >
                {f.title}
              </Link>
            ) : (
              f.title
            )}
          </p>
          <p
            className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'
            data-tip={d.ai_reason ? `The check's own words: ${d.reason}` : undefined}
          >
            {d.ai_reason ?? d.reason}
            {d.ai_reason && (
              <span className='ml-1.5 rounded bg-slate-100 px-1 text-[10px] text-slate-500 dark:bg-muted dark:text-muted-foreground'>
                AI-worded
              </span>
            )}
          </p>
          {(impact?.count != null || impact?.bytes || impact?.text) && (
            <p className='mt-1 flex flex-wrap gap-1.5 text-[11px]'>
              {impact?.count != null && (
                <span className='rounded-full bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-muted dark:text-muted-foreground'>
                  {impact.count.toLocaleString()} affected
                </span>
              )}
              {!!impact?.bytes && (
                <span className='rounded-full bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-muted dark:text-muted-foreground'>
                  {formatFileSize(impact.bytes)}
                </span>
              )}
              {impact?.text && (
                <span className='text-slate-500 dark:text-muted-foreground'>{impact.text}</span>
              )}
            </p>
          )}
          {!!d.data?.files?.length && (
            <details className='mt-1 text-[11px]' data-cr-files={d.data.files.length}>
              <summary className='cursor-pointer text-slate-500 hover:text-slate-700 dark:text-muted-foreground'>
                The {d.data.files.length} largest — review them in Files
              </summary>
              <ul className='mt-1 max-h-60 space-y-0.5 overflow-y-auto'>
                {d.data.files.map((file) => (
                  <li
                    key={file.id}
                    className='flex gap-2 text-slate-600 dark:text-muted-foreground'
                  >
                    <span className='min-w-0 flex-1 truncate'>{file.name ?? file.id}</span>
                    <span className='shrink-0 tabular-nums'>{formatFileSize(file.bytes)}</span>
                    <span className='shrink-0 text-slate-400'>
                      {new Date(file.uploaded_on).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {f.status === 'fixed' && last && (
            <p className='mt-1 text-[11px] text-emerald-700 dark:text-emerald-400'>
              Fixed {new Date(last.at).toLocaleString()} — {last.title} ({last.total} change
              {last.total === 1 ? '' : 's'})
            </p>
          )}
          {d.data?.blocked && (
            <p className='mt-1 text-[11px] text-slate-400'>
              No one-click fix: {String(d.data.blocked)}.
            </p>
          )}
          <p className='mt-0.5 text-[10.5px] text-slate-400 dark:text-slate-500'>
            first seen {new Date(f.first_seen).toLocaleDateString()}
          </p>
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          {f.status === 'open' && d.fix && (
            <button type='button' className={chip} onClick={onToggleFix} data-cr-fix={f.id}>
              {fixOpen ? 'Close' : d.fix.label}
            </button>
          )}
          {d.can_undo && (
            <button
              type='button'
              className={chip}
              disabled={undoing}
              onClick={onUndo}
              data-cr-undo={f.id}
            >
              {undoing ? 'Undoing…' : 'Undo'}
            </button>
          )}
          {f.status !== 'fixed' && (
            <button
              type='button'
              onClick={onDismiss}
              className='text-[11.5px] text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-600'
            >
              {f.status === 'dismissed' ? 'Reopen' : 'Dismiss'}
            </button>
          )}
        </div>
      </div>
      {fixOpen && d.fix && <FixPanel f={f} onApplied={onApplied} />}
    </div>
  )
}

/** Preview → apply, inline under the finding. Labels pick the label first. */
function FixPanel({ f, onApplied }: { f: Finding; onApplied: () => void }) {
  const d = f.detail
  const isLabel = d.fix?.kind === 'label-rename'
  const initial = d.data?.ai_label ?? d.data?.suggested ?? ''
  const [label, setLabel] = useState(initial)
  // Typing a label previews once the typing stops, not per keystroke.
  const [asked, setAsked] = useState(initial)
  useEffect(() => {
    const t = setTimeout(() => setAsked(label), 350)
    return () => clearTimeout(t)
  }, [label])
  const [confirm, setConfirm] = useState(false)
  const candidates = [
    ...new Set([
      ...(d.data?.ai_label ? [d.data.ai_label] : []),
      ...(d.data?.labels ?? []).map((l) => l.label)
    ])
  ]
  const preview = useQuery({
    queryKey: ['config-review-preview', f.id, isLabel ? asked : ''],
    queryFn: () =>
      api
        .get<{ data: ChangeSet }>(`/config-review/${f.id}/preview`, {
          params: isLabel ? { label: asked } : {}
        })
        .then((r) => r.data.data),
    enabled: !isLabel || !!asked.trim(),
    retry: false,
    placeholderData: keepPreviousData
  })
  const apply = useMutation({
    // Apply exactly what the preview showed: its ids + hash. The server
    // re-plans and answers 409 when the change set moved since.
    mutationFn: (cs: ChangeSet) =>
      api
        .post<{ data: { change_set: ChangeSet; applied: number; undoable: boolean } }>(
          `/config-review/${f.id}/apply`,
          { ...(isLabel ? { label: asked } : {}), ids: cs.ids, hash: cs.hash }
        )
        .then((r) => r.data.data),
    onSuccess: (r) => {
      toast.success(
        `${r.change_set.title} — ${r.applied} change${r.applied === 1 ? '' : 's'} made${r.undoable ? '; undo it from the Fixed list' : ''}`
      )
      onApplied()
    },
    onError: (e) => {
      setConfirm(false)
      toast.error(errText(e, 'The fix failed'))
      void preview.refetch()
    }
  })
  const cs = preview.data
  const needsConfirm = cs ? !cs.undoable : false

  return (
    <div
      className='mt-2.5 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-background'
      data-cr-preview={f.id}
    >
      {isLabel && (
        <div className='mb-2.5 space-y-1.5'>
          <p className='text-[11.5px] font-medium text-slate-600 dark:text-muted-foreground'>
            Use this label everywhere
          </p>
          <div className='flex flex-wrap items-center gap-1.5'>
            {candidates.map((c) => (
              <button
                key={c}
                type='button'
                onClick={() => setLabel(c)}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-[11.5px]',
                  label === c
                    ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                    : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-border dark:text-muted-foreground'
                )}
              >
                {c}
                {c === d.data?.ai_label && <span className='ml-1 text-[10px]'>(AI)</span>}
              </button>
            ))}
            <input
              value={label}
              maxLength={80}
              onChange={(e) => setLabel(e.target.value)}
              placeholder='Or type a label'
              className='h-6 w-48 rounded border border-slate-200 bg-white px-2 text-[11.5px] text-slate-700 dark:border-border dark:bg-card dark:text-foreground'
            />
          </div>
        </div>
      )}
      {preview.isLoading && <p className='text-[11.5px] text-slate-400'>Working out the change…</p>}
      {preview.isError && (
        <p className='text-[11.5px] text-red-600 dark:text-red-400'>
          {errText(preview.error, 'Could not preview this fix')}
        </p>
      )}
      {cs && !preview.isError && (
        <>
          <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
            {cs.title}
            <span
              className={cn(
                'ml-2 rounded px-1.5 py-0.5 text-[10.5px] font-normal',
                cs.undoable
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                  : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
              )}
            >
              {cs.undoable ? 'Can be undone' : 'Cannot be undone'}
            </span>
          </p>
          <table className='mt-2 w-full text-[11.5px]'>
            <tbody>
              {cs.lines.map((l, i) => (
                <tr
                  key={`${l.target}-${i}`}
                  className='border-t border-slate-200 first:border-t-0 dark:border-border'
                >
                  <td className='w-20 py-1 pr-2 align-top capitalize text-slate-400'>
                    {l.action.replace('-', ' ')}
                  </td>
                  <td className='py-1 pr-2 align-top text-slate-700 dark:text-foreground'>
                    {l.href ? (
                      <Link to={l.href} className='hover:text-nvr-cyan'>
                        {l.target}
                      </Link>
                    ) : (
                      l.target
                    )}
                  </td>
                  <td className='py-1 align-top text-slate-500 dark:text-muted-foreground'>
                    {l.before != null || l.after != null ? (
                      <>
                        <span className='line-through decoration-slate-300'>{l.before ?? '—'}</span>
                        {' → '}
                        <span className='text-slate-700 dark:text-foreground'>
                          {l.after ?? '—'}
                        </span>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cs.total > cs.lines.length && (
            <p className='mt-1 text-[11px] text-slate-400'>
              …and {cs.total - cs.lines.length} more.
            </p>
          )}
          {cs.note && (
            <p className='mt-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
              {cs.note}
            </p>
          )}
          <div className='mt-2.5 flex items-center gap-2'>
            <button
              type='button'
              disabled={apply.isPending || preview.isFetching || (isLabel && asked !== label)}
              data-cr-apply={needsConfirm && confirm ? 'confirm' : 'ask'}
              onClick={() => (needsConfirm && !confirm ? setConfirm(true) : apply.mutate(cs))}
              onBlur={() => setConfirm(false)}
              className={
                needsConfirm && confirm
                  ? 'h-7 rounded-md border border-red-300 bg-red-50 px-3 text-[12px] font-medium text-red-700 disabled:opacity-50 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300'
                  : 'h-7 rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white disabled:opacity-50'
              }
            >
              {apply.isPending
                ? 'Applying…'
                : needsConfirm && confirm
                  ? 'This cannot be undone — apply?'
                  : `Apply ${cs.total} change${cs.total === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
