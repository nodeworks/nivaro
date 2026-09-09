import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'

/**
 * Data-integrity findings for THIS record, from the latest completed
 * conformance run — editors fix issues where they live instead of admins
 * chasing a list. Per-collection toggle (nivaro_collections.integrity_badge,
 * default on) and a per-layout hide flag are enforced by the callers;
 * nothing renders when the record is clean, the collection has never been
 * swept, or the badge is off.
 *
 * "Fix" opens a PROPOSAL picker: the server ranks concrete repairs (the only
 * option under the current parent, the value it held before an import blanked
 * it, the category 9 of 10 sibling lines use…) each with the writes it would
 * make, its basis and a confidence. The person picks one; every apply goes
 * through the normal write path and can be undone for 30 seconds.
 */

interface Finding {
  field: string
  rule: string
  message: string | null
  fixable?: boolean
}

interface Preview {
  collection: string
  item_id: string | null
  field: string
  label: string
  from: string
  to: string
}

interface Proposal {
  id: string
  kind: string
  label: string
  basis: string
  confidence: 'high' | 'medium' | 'low'
  writes: unknown[]
  preview: Preview[]
  choices?: Array<{ id: string; label: string }>
  pick?: { collection: string; item_id: string; field: string }
  notify?: { user_id: string; name: string }
}

interface ApplyResult {
  fixed: boolean
  applied: number
  failed: Array<{ error: string }>
  undo: unknown[]
  action: string
}

const CONF: Record<Proposal['confidence'], { dot: string; text: string }> = {
  high: { dot: 'bg-emerald-500', text: 'Confident' },
  medium: { dot: 'bg-amber-500', text: 'Likely' },
  low: { dot: 'bg-slate-400', text: 'Manual' }
}

export function RecordIntegrityBanner({
  collection,
  itemId,
  onJumpToField
}: {
  collection: string
  itemId: string
  onJumpToField?: (field: string) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const { data } = useQuery<{
    enabled: boolean
    checked_at?: string | null
    findings: Finding[]
  }>({
    queryKey: ['record-integrity', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: never }>(
          get(`/config-conformance/record/${collection}/${encodeURIComponent(itemId)}`)
        )
        .then((r) => r.data)
        .catch(() => ({ enabled: false, findings: [] }) as never),
    staleTime: 5 * 60_000
  })

  const invalidateRecord = () => {
    void qc.invalidateQueries({ queryKey: ['record-integrity', collection, itemId] })
    void qc.invalidateQueries({ queryKey: ['item', collection, itemId] })
    void qc.invalidateQueries({ queryKey: [collection, itemId] })
    // Child grids + summary chips read their own queries; a line write must
    // repaint them without a reload.
    void qc.invalidateQueries({ queryKey: ['o2m-rows'] })
    void qc.invalidateQueries({ queryKey: ['revisions'] })
  }

  if (!data?.enabled || data.findings.length === 0) return null
  const n = data.findings.length
  return (
    <div
      data-record-integrity
      className='rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 dark:border-amber-500/30 dark:bg-amber-400/10'
    >
      <div className='flex items-center gap-2'>
        <span className='text-[12.5px] font-medium text-amber-800 dark:text-amber-300'>
          {n} data integrity issue{n === 1 ? '' : 's'} on this record
        </span>
        {data.checked_at && (
          <span className='text-[11px] text-amber-600/80 dark:text-amber-400/70'>
            checked {new Date(data.checked_at).toLocaleDateString()}
          </span>
        )}
        <button
          type='button'
          onClick={() => setExpanded((v) => !v)}
          className='ml-auto text-[11.5px] font-medium text-amber-700 underline decoration-dotted underline-offset-2 dark:text-amber-300'
        >
          {expanded ? 'Hide' : 'View'}
        </button>
      </div>
      {expanded && (
        <div className='mt-1.5 space-y-1'>
          {data.findings.map((f, i) => (
            <div key={`${f.field}|${f.rule}|${i}`}>
              <div className='flex items-baseline gap-2 text-[12px]'>
                <button
                  type='button'
                  onClick={() => onJumpToField?.(f.field)}
                  className='shrink-0 font-mono text-[11px] text-amber-700 underline decoration-dotted underline-offset-2 dark:text-amber-300'
                >
                  {f.field}
                </button>
                <span className='min-w-0 flex-1 text-amber-800 dark:text-amber-200/90'>
                  {f.message}
                </span>
                {f.fixable && (
                  <button
                    type='button'
                    onClick={() => setOpenIdx((v) => (v === i ? null : i))}
                    className={cn(
                      'shrink-0 rounded px-2 py-0.5 text-[10.5px] font-semibold transition-colors',
                      openIdx === i
                        ? 'bg-amber-200 text-amber-900 dark:bg-amber-400/30 dark:text-amber-100'
                        : 'bg-amber-600 text-white hover:bg-amber-700'
                    )}
                  >
                    {openIdx === i ? 'Close' : 'Fix…'}
                  </button>
                )}
              </div>
              {openIdx === i && (
                <ProposalPicker
                  collection={collection}
                  itemId={itemId}
                  finding={f}
                  onApplied={invalidateRecord}
                  onClose={() => setOpenIdx(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ProposalPicker({
  collection,
  itemId,
  finding,
  onApplied,
  onClose
}: {
  collection: string
  itemId: string
  finding: Finding
  onApplied: () => void
  onClose: () => void
}) {
  const client = useNivaroClient()
  const base = `/config-conformance/record/${collection}/${encodeURIComponent(itemId)}`
  const body = { field: finding.field, rule: finding.rule, message: finding.message }
  const { data, isLoading, error } = useQuery<Proposal[]>({
    queryKey: ['integrity-proposals', collection, itemId, finding.field, finding.rule],
    queryFn: () =>
      client
        .request<{ data: { proposals: Proposal[] } }>(post(`${base}/proposals`, body))
        .then((r) => r.data.proposals),
    staleTime: 60_000
  })
  const [extra, setExtra] = useState<Proposal[]>([])
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState('')
  const [result, setResult] = useState<{ text: string; undo: unknown[] } | null>(null)
  const [undoLeft, setUndoLeft] = useState(0)
  const [err, setErr] = useState<string | null>(null)

  const proposals = useMemo(() => [...(data ?? []), ...extra], [data, extra])

  useEffect(() => {
    if (!result || result.undo.length === 0) return
    setUndoLeft(30)
    const t = setInterval(() => setUndoLeft((s) => (s <= 1 ? 0 : s - 1)), 1000)
    return () => clearInterval(t)
  }, [result])

  const apply = useMutation({
    mutationFn: (p: Proposal) =>
      client.request<{ data: ApplyResult }>(
        post(`${base}/fix`, {
          ...body,
          proposal_id: p.id,
          choice: p.kind === 'pick' ? choice[p.id] : undefined
        })
      ),
    onSuccess: (r, p) => {
      setErr(null)
      const d = r.data
      const failed = d.failed?.length ?? 0
      setResult({
        text:
          p.kind === 'notify'
            ? `Sent to ${p.notify?.name ?? 'the owner'} as a task.`
            : `${d.applied} write${d.applied === 1 ? '' : 's'} applied${failed ? ` — ${failed} failed: ${d.failed[0]?.error ?? ''}` : ''}.`,
        undo: d.undo ?? []
      })
      onApplied()
    },
    onError: (e) => setErr(msgOf(e))
  })

  const undo = useMutation({
    mutationFn: (writes: unknown[]) =>
      client.request<{ data: ApplyResult }>(post(`${base}/fix`, { ...body, undo: writes })),
    onSuccess: () => {
      setResult({ text: 'Undone.', undo: [] })
      onApplied()
    },
    onError: (e) => setErr(msgOf(e))
  })

  const askAi = useMutation({
    mutationFn: () =>
      client
        .request<{ data: { proposal: Proposal } }>(post(`${base}/proposals/ai`, body))
        .then((r) => r.data.proposal),
    onSuccess: (p) => {
      setErr(null)
      setExtra((xs) => (xs.some((x) => x.id === p.id) ? xs : [...xs, p]))
    },
    onError: (e) => setErr(msgOf(e))
  })

  return (
    <div
      data-integrity-proposals
      className='mt-1.5 rounded-md border border-amber-200/80 bg-white/70 px-3 py-2 dark:border-amber-500/20 dark:bg-black/20'
    >
      {isLoading && (
        <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          Working out what would fix this…
        </p>
      )}
      {error && <p className='text-[11.5px] text-red-600 dark:text-red-400'>{msgOf(error)}</p>}
      {result ? (
        <div className='flex flex-wrap items-center gap-2 text-[11.5px]'>
          <span className='font-medium text-emerald-700 dark:text-emerald-400'>{result.text}</span>
          {result.undo.length > 0 && undoLeft > 0 && (
            <button
              type='button'
              disabled={undo.isPending}
              onClick={() => undo.mutate(result.undo)}
              className='rounded border border-slate-300 px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-foreground dark:hover:bg-muted'
            >
              {undo.isPending ? 'Undoing…' : `Undo (${undoLeft}s)`}
            </button>
          )}
          <button
            type='button'
            onClick={onClose}
            className='ml-auto text-[11px] text-slate-500 hover:text-slate-700 dark:text-muted-foreground'
          >
            Done
          </button>
        </div>
      ) : (
        !isLoading && (
          <div className='space-y-1.5'>
            {proposals.length === 0 && (
              <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                Nothing on this record can derive a value — fix it by hand on the form.
              </p>
            )}
            {proposals.map((p) => {
              const c = CONF[p.confidence] ?? CONF.low
              const picked = choice[p.id]
              const choices = (p.choices ?? []).filter(
                (ch) => !filter || ch.label.toLowerCase().includes(filter.toLowerCase())
              )
              return (
                <div
                  key={p.id}
                  className='rounded border border-slate-200/80 bg-white px-2.5 py-1.5 dark:border-border dark:bg-card'
                >
                  <div className='flex items-start gap-2'>
                    <span
                      className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', c.dot)}
                      title={c.text}
                      data-tip={c.text}
                    />
                    <div className='min-w-0 flex-1'>
                      <p className='text-[12px] font-medium text-slate-800 dark:text-foreground'>
                        {p.label}
                        <span className='ml-1.5 text-[10px] font-normal uppercase tracking-wide text-slate-400'>
                          {p.kind === 'ai' ? 'AI' : c.text}
                        </span>
                      </p>
                      <p className='text-[11px] leading-snug text-slate-500 dark:text-muted-foreground'>
                        {p.basis}
                      </p>
                      {p.preview.length > 0 && (
                        <div className='mt-1 flex flex-wrap gap-1'>
                          {p.preview.slice(0, 8).map((pv, j) => (
                            <span
                              key={`${pv.item_id}|${pv.field}|${j}`}
                              className='rounded bg-slate-100 px-1.5 py-0.5 text-[10.5px] text-slate-700 dark:bg-muted dark:text-foreground'
                            >
                              {pv.label}: <span className='line-through opacity-60'>{pv.from}</span>{' '}
                              → <span className='font-medium'>{pv.to}</span>
                            </span>
                          ))}
                          {p.preview.length > 8 && (
                            <span className='text-[10.5px] text-slate-400'>
                              +{p.preview.length - 8} more
                            </span>
                          )}
                        </div>
                      )}
                      {p.kind === 'pick' && (
                        <div className='mt-1.5'>
                          {(p.choices?.length ?? 0) > 8 && (
                            <input
                              value={filter}
                              onChange={(e) => setFilter(e.target.value)}
                              placeholder='Filter options…'
                              className='mb-1 h-6 w-full rounded border border-slate-200 bg-white px-2 text-[11px] dark:border-border dark:bg-background'
                            />
                          )}
                          <div className='flex max-h-36 flex-wrap gap-1 overflow-y-auto'>
                            {choices.map((ch) => (
                              <button
                                key={ch.id}
                                type='button'
                                onClick={() => setChoice((m) => ({ ...m, [p.id]: ch.id }))}
                                className={cn(
                                  'rounded border px-1.5 py-0.5 text-[11px] transition-colors',
                                  picked === ch.id
                                    ? 'border-nvr-cyan bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
                                    : 'border-slate-200 text-slate-700 hover:bg-muted dark:border-border dark:text-foreground'
                                )}
                              >
                                {ch.label}
                              </button>
                            ))}
                            {choices.length === 0 && (
                              <span className='text-[11px] text-slate-400'>No options match.</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                    <button
                      type='button'
                      disabled={apply.isPending || (p.kind === 'pick' && !picked)}
                      onClick={() => apply.mutate(p)}
                      className={cn(
                        'shrink-0 rounded px-2 py-0.5 text-[10.5px] font-semibold text-white transition-colors disabled:opacity-50',
                        p.kind === 'notify'
                          ? 'bg-slate-600 hover:bg-slate-700'
                          : 'bg-nvr-cyan hover:bg-[#00b8e0]'
                      )}
                    >
                      {apply.isPending && apply.variables?.id === p.id
                        ? 'Applying…'
                        : p.kind === 'notify'
                          ? 'Send'
                          : 'Apply'}
                    </button>
                  </div>
                </div>
              )
            })}
            <div className='flex items-center gap-2 pt-0.5'>
              {!extra.some((x) => x.kind === 'ai') && (
                <button
                  type='button'
                  disabled={askAi.isPending}
                  onClick={() => askAi.mutate()}
                  className='text-[11px] font-medium text-slate-600 underline decoration-dotted underline-offset-2 hover:text-slate-900 disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground'
                >
                  {askAi.isPending ? 'Asking AI…' : 'Ask AI for a suggestion'}
                </button>
              )}
              <button
                type='button'
                onClick={onClose}
                className='ml-auto text-[11px] text-slate-500 hover:text-slate-700 dark:text-muted-foreground'
              >
                Cancel
              </button>
            </div>
            {err && <p className='text-[11px] text-red-600 dark:text-red-400'>{err}</p>}
          </div>
        )
      )}
    </div>
  )
}

function msgOf(e: unknown): string {
  const x = e as { response?: { error?: string }; message?: string }
  return String(x?.response?.error ?? x?.message ?? 'Request failed')
}
