import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Loader2, RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import { useItemNavigation, useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { cn, formatDateTime, formatNumber, formatRelative } from '../../lib/utils'
import { ConfirmButton, Pill } from './primitives'

/**
 * Roll back one MCP connection's changes (#3219): pick a window, preview what would be undone
 * (records, field names, creates and deletes; never values), then apply — through the items
 * service as the person the connection acts for. Records someone changed since are listed and
 * left alone. Used on the person's Agents tab (scope 'mine') and the administrators' MCP
 * connections page (scope 'admin').
 */

export type RollbackKind =
  | 'delete_created'
  | 'restore_values'
  | 'restore_deleted'
  | 'remove_comment'

export interface RollbackPlan {
  conn: string
  owner: { id: string; name: string } | null
  from: string
  to: string
  actions: Array<{
    kind: RollbackKind
    collection: string
    collection_label: string
    item: string
    fields: string[]
    writes: number
    first_at: string
    last_at: string
    comment_id?: string
  }>
  skipped: Array<{
    collection: string
    collection_label: string
    item: string
    reason: string
    by?: string | null
    at?: string | null
  }>
  system_writes: number
  truncated: boolean
  plan_hash: string
}

interface RollbackResult {
  done: number
  failed: Array<{ collection: string; item: string; kind: RollbackKind; error: string }>
  skipped: number
  acted_as: 'owner' | 'administrator'
}

type Preset = '1h' | '24h' | '7d' | '14d' | 'custom'
const PRESETS: Array<[Preset, string, number]> = [
  ['1h', 'Last hour', 3_600_000],
  ['24h', 'Last 24 hours', 86_400_000],
  ['7d', 'Last 7 days', 7 * 86_400_000],
  ['14d', 'Last 14 days', 14 * 86_400_000],
  ['custom', 'Between…', 0]
]

const KIND_TEXT: Record<RollbackKind, (n: number) => string> = {
  delete_created: () => 'Delete the record it created',
  restore_values: (n) => `Put back ${n} field${n === 1 ? '' : 's'}`,
  restore_deleted: (n) =>
    n
      ? `Bring back the record it deleted, then put back ${n} field${n === 1 ? '' : 's'}`
      : 'Bring back the record it deleted',
  remove_comment: () => 'Remove its comment'
}

/** `<input type=datetime-local>` value for a date, in local time. */
function localInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const inputCls =
  'h-8 rounded-md border border-slate-200 bg-white px-2 text-[12.5px] text-slate-800 outline-none transition-colors focus:border-nvr-cyan focus-visible:ring-2 focus-visible:ring-nvr-cyan/25 dark:border-border dark:bg-background dark:text-slate-100 dark:[color-scheme:dark]'

const errorOf = (e: unknown) =>
  (e as { message?: string })?.message || 'Something went wrong. Try again in a moment.'

export function ConnectionRollback({
  conn,
  name,
  scope,
  onClose
}: {
  conn: string
  name: string
  scope: 'mine' | 'admin'
  onClose: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { urlFor, open } = useItemNavigation()
  const base = scope === 'mine' ? `/mcp-connections/mine/${conn}` : `/mcp-connections/${conn}`
  const [preset, setPreset] = useState<Preset>('24h')
  const [from, setFrom] = useState(() => localInput(new Date(Date.now() - 86_400_000)))
  const [to, setTo] = useState(() => localInput(new Date()))
  const [plan, setPlan] = useState<RollbackPlan | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [result, setResult] = useState<RollbackResult | null>(null)

  const windowOf = (): { from: string; to?: string } | null => {
    if (preset === 'custom') {
      const f = new Date(from)
      const t = new Date(to)
      if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return null
      return { from: f.toISOString(), to: t.toISOString() }
    }
    const ms = PRESETS.find((p) => p[0] === preset)?.[2] ?? 86_400_000
    return { from: new Date(Date.now() - ms).toISOString() }
  }

  const preview = useMutation({
    mutationFn: () => {
      const w = windowOf()
      if (!w) throw new Error('Choose when the window starts and ends')
      return client
        .request(post<{ data: RollbackPlan }>(`${base}/rollback/preview`, w))
        .then((r) => r.data)
    },
    onSuccess: (p) => {
      setPlan(p)
      setResult(null)
      setNotice(null)
    }
  })

  const apply = useMutation({
    mutationFn: (p: RollbackPlan) =>
      client
        .request(
          post<{ data: RollbackResult }>(`${base}/rollback`, {
            from: p.from,
            to: p.to,
            plan_hash: p.plan_hash
          })
        )
        .then((r) => r.data),
    onSuccess: (r) => {
      setResult(r)
      setPlan(null)
      void qc.invalidateQueries({ queryKey: ['nvr-mcp-activity'] })
      void qc.invalidateQueries({ queryKey: ['nvr-mcp-connections'] })
    },
    onError: (e: unknown) => {
      const err = e as { status?: number; response?: { data?: RollbackPlan } }
      if (err.status === 409 && err.response?.data) {
        setPlan(err.response.data)
        setNotice(
          'Some records changed since the preview. This is the new list — check it and apply again.'
        )
      }
    }
  })

  const link = (collection: string, item: string, text: string) => {
    const target = { collection, itemId: item }
    return (
      <a
        href={urlFor(target)}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) return
          e.preventDefault()
          open(target)
        }}
        className='font-mono text-[11.5px] text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
      >
        {text}
      </a>
    )
  }

  return (
    <div
      className='rounded-lg border border-slate-200 bg-slate-50/70 p-3 dark:border-border dark:bg-muted/30'
      data-nvr-connection-rollback
    >
      <div className='flex flex-wrap items-center gap-2'>
        <RotateCcw className='h-4 w-4 text-slate-500 dark:text-slate-400' aria-hidden />
        <span className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
          Roll back what {name} changed
        </span>
        <button
          type='button'
          onClick={onClose}
          aria-label='Close'
          data-tip='Close'
          className='ml-auto rounded p-1 text-slate-400 transition-colors hover:bg-muted hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:hover:text-slate-200'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>

      <div className='mt-2.5 flex flex-wrap items-center gap-2'>
        <div className='flex flex-wrap gap-1 rounded-md bg-slate-100 p-0.5 dark:bg-muted'>
          {PRESETS.map(([key, label]) => (
            <button
              key={key}
              type='button'
              aria-pressed={preset === key}
              onClick={() => {
                setPreset(key)
                setPlan(null)
              }}
              className={cn(
                'h-7 rounded px-2.5 text-[12px] font-medium transition-colors',
                preset === key
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <span className='flex flex-wrap items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
            <input
              type='datetime-local'
              value={from}
              onChange={(e) => {
                setFrom(e.target.value)
                setPlan(null)
              }}
              aria-label='From'
              className={inputCls}
            />
            to
            <input
              type='datetime-local'
              value={to}
              onChange={(e) => {
                setTo(e.target.value)
                setPlan(null)
              }}
              aria-label='To'
              className={inputCls}
            />
          </span>
        )}
        <button
          type='button'
          onClick={() => preview.mutate()}
          disabled={preview.isPending}
          className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 disabled:opacity-40 dark:border-border dark:bg-card dark:text-slate-200'
        >
          {preview.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
          Preview
        </button>
      </div>

      {preview.isError && (
        <p className='mt-2 text-[12px] text-red-600 dark:text-red-400'>{errorOf(preview.error)}</p>
      )}
      {notice && (
        <p
          className='mt-2 flex items-center gap-1.5 text-[12px] text-amber-700 dark:text-amber-400'
          role='status'
        >
          <AlertTriangle className='h-3.5 w-3.5 shrink-0' />
          {notice}
        </p>
      )}

      {result && (
        <div
          className='mt-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-[12.5px] dark:border-border dark:bg-card'
          role='status'
        >
          <p className='flex items-center gap-1.5 text-slate-800 dark:text-slate-100'>
            <Check className='h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400' />
            {result.done
              ? `Rolled back ${formatNumber(result.done)} change${result.done === 1 ? '' : 's'}.`
              : 'Nothing was rolled back.'}
            {result.skipped > 0 && ` ${formatNumber(result.skipped)} left alone.`}
          </p>
          {result.acted_as === 'administrator' && (
            <p className='mt-1 text-[12px] text-slate-500 dark:text-slate-400'>
              The person this app acted for can no longer sign in, so the rollback ran as you.
            </p>
          )}
          {result.failed.length > 0 && (
            <ul className='mt-2 space-y-1'>
              {result.failed.map((f) => (
                <li
                  key={`${f.collection}:${f.item}:${f.kind}`}
                  className='text-[12px] text-red-700 dark:text-red-400'
                >
                  {f.collection} #{f.item}: {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {plan && (
        <div className='mt-3 space-y-3'>
          <p className='text-[12px] text-slate-600 dark:text-slate-300'>
            {formatDateTime(plan.from)} – {formatDateTime(plan.to)}
            {plan.owner && scope === 'admin' && <> · acting for {plan.owner.name}</>}
          </p>
          {plan.truncated && (
            <p className='flex items-center gap-1.5 text-[12px] text-amber-700 dark:text-amber-400'>
              <AlertTriangle className='h-3.5 w-3.5 shrink-0' />
              More changes than one rollback takes. Choose a shorter window.
            </p>
          )}
          {plan.actions.length === 0 && plan.skipped.length === 0 ? (
            <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
              {name} changed nothing in this window.
            </p>
          ) : (
            <>
              {plan.actions.length > 0 && (
                <section>
                  <h4 className='text-[11.5px] font-medium text-slate-500 dark:text-slate-400'>
                    Will be undone · {formatNumber(plan.actions.length)}
                  </h4>
                  <ul className='mt-1 max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card'>
                    {plan.actions.slice(0, 300).map((a) => (
                      <li
                        key={`${a.kind}:${a.collection}:${a.item}:${a.comment_id ?? ''}`}
                        className='flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[12px]'
                      >
                        <span className='min-w-[180px] text-slate-700 dark:text-slate-200'>
                          {KIND_TEXT[a.kind](a.fields.length)}
                        </span>
                        {a.kind === 'delete_created' || a.kind === 'restore_deleted' ? (
                          <span className='font-mono text-[11.5px] text-slate-600 dark:text-slate-300'>
                            {a.collection_label} #{a.item}
                          </span>
                        ) : (
                          link(a.collection, a.item, `${a.collection_label} #${a.item}`)
                        )}
                        {a.fields.length > 0 && (
                          <span className='flex flex-wrap gap-1'>
                            {a.fields.slice(0, 6).map((f) => (
                              <span
                                key={f}
                                className='rounded bg-slate-100 px-1.5 py-px font-mono text-[11px] text-slate-600 dark:bg-muted dark:text-slate-300'
                              >
                                {f}
                              </span>
                            ))}
                            {a.fields.length > 6 && (
                              <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                                +{a.fields.length - 6}
                              </span>
                            )}
                          </span>
                        )}
                        <span className='ml-auto whitespace-nowrap text-[11px] text-slate-500 dark:text-slate-400'>
                          {a.writes > 1 ? `${a.writes} writes · ` : ''}
                          {formatRelative(a.last_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {plan.actions.length > 300 && (
                    <p className='mt-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
                      And {formatNumber(plan.actions.length - 300)} more.
                    </p>
                  )}
                </section>
              )}
              {plan.skipped.length > 0 && (
                <section>
                  <h4 className='text-[11.5px] font-medium text-slate-500 dark:text-slate-400'>
                    Left alone · {formatNumber(plan.skipped.length)}
                  </h4>
                  <ul className='mt-1 max-h-52 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card'>
                    {plan.skipped.slice(0, 300).map((s) => (
                      <li
                        key={`${s.collection}:${s.item}`}
                        className='flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[12px]'
                      >
                        {link(s.collection, s.item, `${s.collection_label} #${s.item}`)}
                        <span className='text-slate-600 dark:text-slate-300'>
                          {s.reason}
                          {s.by ? ` (${s.by}` : ''}
                          {s.by && s.at ? `, ${formatRelative(s.at)})` : s.by ? ')' : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
          {plan.system_writes > 0 && (
            <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
              <Pill tone='neutral'>{formatNumber(plan.system_writes)}</Pill> configuration change
              {plan.system_writes === 1 ? '' : 's'} in this window are not rolled back here.
            </p>
          )}
          {plan.actions.length > 0 && !plan.truncated && (
            <div className='flex flex-wrap items-center gap-3'>
              <ConfirmButton
                onConfirm={() => apply.mutate(plan)}
                disabled={apply.isPending}
                confirmLabel={`Undo ${formatNumber(plan.actions.length)} now?`}
                title={`Roll back ${plan.actions.length} change${plan.actions.length === 1 ? '' : 's'}`}
                className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-[12.5px] font-medium text-slate-800 transition-colors hover:border-red-300 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40 disabled:opacity-40 dark:border-border dark:bg-card dark:text-slate-100 dark:hover:border-red-500/50 dark:hover:text-red-400'
                armedClassName='border-red-300 bg-red-50 text-red-700 dark:border-red-500/50 dark:bg-red-500/10 dark:text-red-400'
              >
                {apply.isPending ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                ) : (
                  <RotateCcw className='h-3.5 w-3.5' />
                )}
                Roll back {formatNumber(plan.actions.length)} change
                {plan.actions.length === 1 ? '' : 's'}
              </ConfirmButton>
              <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>
                Runs as {scope === 'mine' ? 'you' : (plan.owner?.name ?? 'the person')}, with their
                permissions. Each change is logged.
              </span>
              {apply.isError && !notice && (
                <span className='text-[12px] text-red-600 dark:text-red-400'>
                  {errorOf(apply.error)}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
