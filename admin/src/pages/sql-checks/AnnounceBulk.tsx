import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, ChevronRight, Loader2, Radio, XCircle } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'
import {
  type AnnouncePlanEntry,
  type ApplyOutcome,
  DiffView,
  errorText,
  useTwoClick
} from './shared'

type RowState =
  | { s: 'applying' }
  | { s: 'applied'; fix: number; deployed: boolean }
  | { s: 'put-back'; reason: string }
  | { s: 'failed'; reason: string }

/** Where an entry's fix goes, in the words the list shows. */
function pathOf(e: AnnouncePlanEntry): {
  label: string
  tone: string
  applicable: boolean
  tip: string
} {
  const p = e.proposal
  if (e.error || !p)
    return {
      label: 'Can’t read',
      tone: 'muted',
      applicable: false,
      tip: 'The procedure’s text could not be read'
    }
  if (!p.proposable)
    return {
      label: 'Needs a person',
      tone: 'muted',
      applicable: false,
      tip: 'The fix cannot be written automatically; open it to see why'
    }
  if (p.apply_refused)
    return {
      label: 'Propose only',
      tone: 'muted',
      applicable: false,
      tip: 'Shown only: nobody here owns this procedure, so it is not changed from this page'
    }
  if (p.target.kind === 'managed_procedure')
    return {
      label: 'Managed by the app',
      tone: 'cyan',
      applicable: true,
      tip: 'Saved as a new version on the Procedures page, then deployed from there'
    }
  return {
    label: 'Owned by an import',
    tone: 'cyan',
    applicable: true,
    tip: 'Its text lives in an import definition: the fix is saved there and deployed with it'
  }
}

/**
 * "Apply announce fix to N procedures" (realtime): every procedure with an open "writes without
 * announcing" finding, its per-collection plan and diff; the chosen ones are applied one at a
 * time through the same path as a single fix (compile, re-check, put back when worse). App-managed
 * procedures are saved to config and deployed from there; import-owned ones get their stored body
 * rewritten; any other procedure is shown only.
 */
export function AnnounceBulk({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['sql-checks', 'announce-plan'],
    queryFn: () =>
      api.get<{ data: AnnouncePlanEntry[] }>('/sql-checks/announce/plan').then((r) => r.data.data),
    staleTime: 0
  })
  const entries = q.data ?? []
  const applicable = useMemo(() => entries.filter((e) => pathOf(e).applicable), [entries])
  const [picked, setPicked] = useState<Set<number> | null>(null)
  const chosen = picked ?? new Set(applicable.map((e) => e.finding_id))
  const [open, setOpen] = useState<number | null>(null)
  const [states, setStates] = useState<Map<number, RowState>>(new Map())
  const [running, setRunning] = useState(false)
  const stop = useRef(false)
  const [armed, setArmed] = useTwoClick()
  const [status, setStatus] = useState('')

  const toggle = (id: number, on: boolean) => {
    const next = new Set(chosen)
    if (on) next.add(id)
    else next.delete(id)
    setPicked(next)
  }
  const setState = (id: number, st: RowState) => setStates((m) => new Map(m).set(id, st))

  const run = async () => {
    const list = applicable.filter((e) => chosen.has(e.finding_id) && !states.has(e.finding_id))
    if (!list.length) return
    setRunning(true)
    stop.current = false
    let done = 0
    let ok = 0
    for (const e of list) {
      if (stop.current) break
      setState(e.finding_id, { s: 'applying' })
      setStatus(`Applying ${done + 1} of ${list.length}: ${e.object.label}`)
      try {
        const r = await api
          .post<{ data: ApplyOutcome }>(`/sql-checks/findings/${e.finding_id}/apply`, {
            new_definition_hash: e.proposal?.new_definition_hash
          })
          .then((x) => x.data.data)
        if (r.applied) {
          ok++
          setState(e.finding_id, { s: 'applied', fix: r.fix_id, deployed: r.deployed })
        } else
          setState(e.finding_id, {
            s: 'put-back',
            reason: r.reason ?? 'the re-check was not clean'
          })
      } catch (err) {
        setState(e.finding_id, { s: 'failed', reason: errorText(err, 'Couldn’t apply the fix.') })
      }
      done++
    }
    setRunning(false)
    const msg = `Fix applied to ${ok} of ${list.length} ${list.length === 1 ? 'procedure' : 'procedures'}${stop.current ? ' (stopped)' : ''}`
    setStatus(msg)
    if (ok === list.length) toast.success(msg)
    else toast.error(msg)
    void qc.invalidateQueries({ queryKey: ['sql-checks', 'findings'] })
    void qc.invalidateQueries({ queryKey: ['sql-checks', 'summary'] })
  }

  const waiting = applicable.filter((e) => chosen.has(e.finding_id) && !states.has(e.finding_id))

  return (
    <div className='grid min-w-0 gap-4 p-4 sm:p-6'>
      <div className='grid gap-1'>
        <button
          type='button'
          onClick={onBack}
          className='flex w-fit items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan lg:hidden'
        >
          <ArrowLeft className='h-3.5 w-3.5' aria-hidden='true' /> Findings
        </button>
        <h2 className='m-0 flex min-w-0 items-start gap-2 text-[15px] font-semibold'>
          <Radio className='mt-0.5 h-4 w-4 shrink-0 text-muted-foreground' aria-hidden='true' />
          Procedures that change records without announcing it
        </h2>
        <p className='m-0 max-w-[72ch] text-[12.5px] text-muted-foreground'>
          Screens that have these records open keep showing old values until someone reloads. The
          fix collects the ids each write changes and tells open screens at the end of the
          procedure; it can never make the procedure fail. Each one is compiled and checked again
          before it is saved, exactly as a single fix is.
        </p>
      </div>

      {q.isLoading ? (
        <div className='grid gap-2' role='status' aria-label='Preparing the fixes'>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className='h-11 rounded-md' />
          ))}
        </div>
      ) : q.isError ? (
        <p className='m-0 text-[12.5px] text-red-600 dark:text-red-400'>
          {errorText(q.error, 'Couldn’t prepare the fixes.')}
        </p>
      ) : entries.length === 0 ? (
        <p className='m-0 text-[12.5px] text-muted-foreground'>
          Every procedure that writes records announces them. Nothing to fix.
        </p>
      ) : (
        <>
          <div className='flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 dark:border-border dark:bg-card'>
            <label htmlFor='announce-choose-all' className='flex items-center gap-2 text-[12.5px]'>
              <Checkbox
                id='announce-choose-all'
                checked={
                  applicable.length > 0 && applicable.every((e) => chosen.has(e.finding_id))
                    ? true
                    : chosen.size > 0
                      ? 'indeterminate'
                      : false
                }
                disabled={running || applicable.length === 0}
                onCheckedChange={(v) =>
                  setPicked(v === true ? new Set(applicable.map((e) => e.finding_id)) : new Set())
                }
                aria-label='Choose every procedure that can be fixed from here'
              />
              <span>
                {formatNumber(chosen.size)} of {formatNumber(applicable.length)} chosen
                {entries.length > applicable.length && (
                  <span className='text-muted-foreground'>
                    {' '}
                    · {formatNumber(entries.length - applicable.length)} shown only
                  </span>
                )}
              </span>
            </label>
            <span className='flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto'>
              {running && (
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-8 text-[12.5px]'
                  onClick={() => {
                    stop.current = true
                  }}
                >
                  Stop after this one
                </Button>
              )}
              <Button
                size='sm'
                className={cn(
                  'h-8 w-full text-[12.5px] sm:w-auto [&_svg]:size-3.5',
                  armed
                    ? 'bg-amber-500 text-white hover:bg-amber-500/90'
                    : 'bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
                )}
                disabled={running || waiting.length === 0}
                onClick={() => {
                  if (!armed) return setArmed(true)
                  setArmed(false)
                  void run()
                }}
              >
                {running && <Loader2 className='animate-spin' aria-hidden='true' />}
                {running
                  ? 'Applying…'
                  : armed
                    ? `Click again to apply to ${formatNumber(waiting.length)}`
                    : `Apply the fix to ${formatNumber(waiting.length)} ${waiting.length === 1 ? 'procedure' : 'procedures'}`}
              </Button>
            </span>
          </div>
          <p className='m-0 sr-only' role='status' aria-live='polite'>
            {status}
          </p>
          {status && !running && <p className='m-0 text-[12px] text-muted-foreground'>{status}</p>}

          <ul className='m-0 grid list-none gap-0 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white p-0 dark:divide-border dark:border-border dark:bg-card'>
            {entries.map((e) => {
              const path = pathOf(e)
              const st = states.get(e.finding_id)
              const expanded = open === e.finding_id
              const p = e.proposal
              return (
                <li key={e.finding_id} className='grid min-w-0 gap-2 px-3 py-2.5'>
                  <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1'>
                    <Checkbox
                      checked={path.applicable && chosen.has(e.finding_id)}
                      disabled={!path.applicable || running || !!st}
                      onCheckedChange={(v) => toggle(e.finding_id, v === true)}
                      aria-label={`Apply to ${e.object.label}`}
                    />
                    <button
                      type='button'
                      onClick={() => setOpen(expanded ? null : e.finding_id)}
                      aria-expanded={expanded}
                      className='flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                    >
                      <ChevronRight
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                          expanded && 'rotate-90'
                        )}
                        aria-hidden='true'
                      />
                      <span className='truncate font-mono text-[12px]'>{e.object.label}</span>
                    </button>
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium',
                        path.tone === 'cyan'
                          ? 'bg-nvr-cyan/10 text-[#0e7490] dark:text-[#67e8f9]'
                          : 'bg-muted text-muted-foreground'
                      )}
                      data-tip={path.tip}
                    >
                      {path.label}
                    </span>
                    <RowResult st={st} />
                  </div>
                  <div className='flex flex-wrap gap-1.5 pl-7'>
                    {(
                      p?.plan ??
                      e.collections.map((c) => ({ collection: c, ids: false, whole: false }))
                    ).map((c) => (
                      <span
                        key={c.collection}
                        className='rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-foreground/80 dark:border-border'
                      >
                        {c.collection}
                        {(c.ids || c.whole) && (
                          <span className='text-muted-foreground'>
                            {' · '}
                            {c.ids && c.whole
                              ? 'ids + many changed'
                              : c.ids
                                ? 'ids'
                                : 'many changed'}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                  {expanded && (
                    <div className='grid gap-2 pl-7'>
                      {e.error && (
                        <p className='m-0 text-[12px] text-muted-foreground'>{e.error}</p>
                      )}
                      {p && !p.proposable && (
                        <p className='m-0 text-[12px] text-muted-foreground'>{p.manual_reason}</p>
                      )}
                      {p?.apply_refused && (
                        <p className='m-0 text-[12px] text-muted-foreground'>{p.apply_refused}</p>
                      )}
                      {p?.notes.length ? (
                        <ul className='m-0 grid gap-1 pl-4 text-[12px] text-muted-foreground'>
                          {p.notes.map((n) => (
                            <li key={n}>{n}</li>
                          ))}
                        </ul>
                      ) : null}
                      {p?.proposable && (
                        <DiffView hunks={p.diff} label={`Proposed change to ${e.object.label}`} />
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

function RowResult({ st }: { st: RowState | undefined }) {
  if (!st) return null
  if (st.s === 'applying')
    return (
      <span className='flex items-center gap-1 text-[11.5px] text-muted-foreground'>
        <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden='true' /> Applying
      </span>
    )
  if (st.s === 'applied')
    return (
      <span className='flex items-center gap-1 text-[11.5px] text-emerald-700 dark:text-emerald-400'>
        <CheckCircle2 className='h-3.5 w-3.5' aria-hidden='true' />
        {st.deployed ? 'Applied' : 'Body saved'} · fix #{st.fix}
      </span>
    )
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1 text-[11.5px]',
        st.s === 'put-back'
          ? 'text-amber-800 dark:text-amber-300'
          : 'text-red-600 dark:text-red-400'
      )}
    >
      <XCircle className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
      <span className='truncate' data-tip={st.reason}>
        {st.s === 'put-back' ? 'Put back' : 'Not applied'}: {st.reason}
      </span>
    </span>
  )
}
