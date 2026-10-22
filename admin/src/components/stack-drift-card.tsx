import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, KeyRound, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * #2798 Stack drift — what each stack's live service specs look like against the baseline the
 * last deploy stored (GET /api/infrastructure/drift). Environments shows the full card (one row
 * per environment + stack, expandable to expected vs actual per field); the Infrastructure Stacks
 * tab shows the one-line summary. Secret values never reach the browser: a secret field only
 * says that it changed. Renders nothing when the drift routes are not here (cloud) or the tables
 * are not on this database.
 */

interface DriftFinding {
  id: number
  service: string
  field: string
  kind: 'changed' | 'added' | 'removed' | 'missing' | 'extra'
  expected: string | null
  actual: string | null
  secret: boolean
  origin: 'hand-run' | 'recreated' | null
  detail: string | null
  first_seen: string
  last_seen: string
  alerted: boolean
}

interface DriftStack {
  baseline_id: number
  stack: string
  environment: string
  host: string | null
  live_host: string | null
  live_note: string | null
  baseline: {
    version: string | null
    release: string | null
    source: 'posted' | 'live'
    services: number
    at: string
  }
  last_check: {
    at: string | null
    status: 'ok' | 'drift' | 'no-source' | 'error' | null
    message: string | null
  }
  drift: number
  findings: DriftFinding[]
}

interface DriftStatus {
  available: boolean
  cloud: boolean
  docker_configured: boolean
  source_note: string | null
  stacks: DriftStack[]
}

const DRIFT_KEY = ['infrastructure', 'drift'] as const

export function useStackDrift() {
  return useQuery({
    queryKey: DRIFT_KEY,
    queryFn: async () => (await api.get<{ data: DriftStatus }>('/infrastructure/drift')).data.data,
    staleTime: 30_000,
    retry: false
  })
}

const CHIP = {
  ok: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  warn: 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200',
  bad: 'bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  muted: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
} as const

function Chip({
  tone,
  children,
  tip
}: {
  tone: keyof typeof CHIP
  children: React.ReactNode
  tip?: string
}) {
  return (
    <span
      data-tip={tip}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
        CHIP[tone]
      )}
    >
      {children}
    </span>
  )
}

/** The status chip of one stack: never "in step" when nothing was compared. */
function StackState({ s, sourceNote }: { s: DriftStack; sourceNote: string | null }) {
  if (!s.live_host)
    return (
      <Chip tone='muted' tip={s.live_note ?? sourceNote ?? undefined}>
        No live source
      </Chip>
    )
  if (s.last_check.status === 'error')
    return (
      <Chip tone='bad' tip={s.last_check.message ?? undefined}>
        Check failed
      </Chip>
    )
  if (!s.last_check.at) return <Chip tone='muted'>Not checked yet</Chip>
  if (s.drift > 0)
    return (
      <Chip tone='warn'>
        {s.drift} drifted field{s.drift === 1 ? '' : 's'}
      </Chip>
    )
  return <Chip tone='ok'>Matches the deploy</Chip>
}

const KIND_WORDS: Record<DriftFinding['kind'], string> = {
  changed: 'Changed',
  added: 'Added',
  removed: 'Removed',
  missing: 'Service missing',
  extra: 'Extra service'
}

function Value({ v, muted }: { v: string | null; muted?: boolean }) {
  if (v == null) return <span className='text-slate-400 dark:text-slate-500'>—</span>
  return (
    <span
      className={cn(
        'whitespace-pre-wrap font-mono text-[11.5px] [overflow-wrap:anywhere]',
        muted ? 'text-slate-500 dark:text-muted-foreground' : 'text-slate-800 dark:text-slate-200'
      )}
    >
      {v.length > 400 ? `${v.slice(0, 400)}…` : v}
    </span>
  )
}

function FindingsTable({ findings }: { findings: DriftFinding[] }) {
  return (
    <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
      <table className='w-full min-w-[720px] text-left text-[12px]' data-drift-table>
        <thead className='bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-muted/40 dark:text-muted-foreground'>
          <tr>
            <th className='px-3 py-2 font-medium'>Service</th>
            <th className='px-3 py-2 font-medium'>Field</th>
            <th className='px-3 py-2 font-medium'>Deployed</th>
            <th className='px-3 py-2 font-medium'>Running now</th>
            <th className='px-3 py-2 font-medium'>How</th>
            <th className='px-3 py-2 font-medium'>Since</th>
          </tr>
        </thead>
        <tbody className='divide-y divide-slate-100 bg-white dark:divide-border dark:bg-card'>
          {findings.map((f) => (
            <tr key={f.id} data-drift-finding={`${f.service}:${f.field}`} className='align-top'>
              <td className='px-3 py-2 font-medium text-slate-800 dark:text-slate-200'>
                {f.service}
              </td>
              <td className='px-3 py-2'>
                <div className='font-mono text-[11.5px] text-slate-700 dark:text-slate-300'>
                  {f.field}
                </div>
                <div className='mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                  {KIND_WORDS[f.kind]}
                </div>
              </td>
              {f.secret ? (
                <td className='px-3 py-2' colSpan={2}>
                  <span
                    data-drift-secret
                    className='inline-flex items-center gap-1 text-[12px] text-slate-600 dark:text-slate-300'
                  >
                    <KeyRound className='h-3.5 w-3.5 text-amber-600 dark:text-amber-400' />
                    {f.kind === 'added'
                      ? 'Secret value set (not in the deploy)'
                      : f.kind === 'removed'
                        ? 'Secret value removed'
                        : 'Secret value changed'}
                  </span>
                </td>
              ) : (
                <>
                  <td className='min-w-[190px] px-3 py-2'>
                    <Value v={f.expected} muted />
                  </td>
                  <td className='min-w-[190px] px-3 py-2'>
                    <Value v={f.actual} />
                  </td>
                </>
              )}
              <td className='px-3 py-2'>
                {f.origin === 'hand-run' ? (
                  <Chip tone='warn' tip={f.detail ?? undefined}>
                    Hand-run update
                  </Chip>
                ) : f.origin === 'recreated' ? (
                  <Chip tone='bad' tip={f.detail ?? undefined}>
                    Recreated
                  </Chip>
                ) : f.detail ? (
                  <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    {f.detail}
                  </span>
                ) : (
                  <span className='text-slate-400 dark:text-slate-500'>—</span>
                )}
              </td>
              <td className='whitespace-nowrap px-3 py-2 text-slate-500 dark:text-muted-foreground'>
                {formatRelative(f.first_seen)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Environments → Stack drift: one row per environment + stack. */
export function StackDriftCard() {
  const qc = useQueryClient()
  const q = useStackDrift()
  const [params] = useSearchParams()
  const asked = params.get('drift')
  const [open, setOpen] = useState<Set<string>>(() => new Set(asked ? [asked] : []))
  useEffect(() => {
    if (asked) setOpen((s) => (s.has(asked) ? s : new Set([...s, asked])))
  }, [asked])

  const check = useMutation({
    mutationFn: async () =>
      (await api.post<{ data: { checked: number } }>('/infrastructure/drift/check', {})).data.data,
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: DRIFT_KEY })
      toast.success(`Checked ${d.checked} stack${d.checked === 1 ? '' : 's'}`)
    },
    onError: (err: Error) => toast.error(err.message)
  })

  if (q.isError || (q.data && (!q.data.available || q.data.cloud))) return null
  const d = q.data
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <section
      data-drift-card
      className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1'>
        <div className='min-w-0'>
          <h2 className='text-[13.5px] font-semibold text-slate-900 dark:text-foreground'>
            Stack drift
          </h2>
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Running service specs compared with what the last deploy left — checked nightly.
          </p>
        </div>
        {d && d.stacks.length > 0 && d.docker_configured && (
          <Button
            size='sm'
            variant='outline'
            data-drift-check
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            {check.isPending ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
            ) : (
              <RefreshCw className='h-3.5 w-3.5' />
            )}
            Check now
          </Button>
        )}
      </div>

      {q.isLoading && (
        <div className='mt-3 space-y-2'>
          <Skeleton className='h-5 w-2/3' />
          <Skeleton className='h-5 w-1/2' />
        </div>
      )}

      {d?.source_note && (
        <p
          data-drift-source-note
          className='mt-2 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200'
        >
          {d.source_note}
        </p>
      )}

      {d && d.stacks.length === 0 && (
        <p className='mt-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No baseline yet — the deploy script stores one after every converged deploy (POST
          /api/infrastructure/drift/baseline).
        </p>
      )}

      {d && d.stacks.length > 0 && (
        <ul className='mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-border dark:border-border'>
          {d.stacks.map((s) => {
            const key = `${s.stack}:${s.environment}`
            const isOpen = open.has(key)
            const canOpen = s.findings.length > 0
            return (
              <li key={key} data-drift-stack={key}>
                <button
                  type='button'
                  disabled={!canOpen}
                  aria-expanded={canOpen ? isOpen : undefined}
                  onClick={() => toggle(key)}
                  className={cn(
                    'flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left',
                    canOpen && 'hover:bg-muted'
                  )}
                >
                  {canOpen ? (
                    isOpen ? (
                      <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                    ) : (
                      <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                    )
                  ) : (
                    <span className='w-3.5 shrink-0' />
                  )}
                  <span className='text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
                    {s.environment}
                  </span>
                  <span className='font-mono text-[12px] text-slate-500 dark:text-muted-foreground'>
                    {s.stack}
                  </span>
                  <StackState s={s} sourceNote={d.source_note} />
                  <span className='ml-auto flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    <span>
                      Baseline
                      {s.baseline.version ? ` ${s.baseline.version}` : ''}
                      {s.baseline.release ? ` · release ${s.baseline.release}` : ''} ·{' '}
                      {s.baseline.services} service{s.baseline.services === 1 ? '' : 's'} ·{' '}
                      {s.baseline.source === 'live' ? 'read live' : 'from the deploy'}{' '}
                      {formatRelative(s.baseline.at)}
                    </span>
                    <span className='text-slate-300 dark:text-slate-600'>·</span>
                    <span>
                      {s.last_check.at
                        ? `checked ${formatRelative(s.last_check.at)}${s.live_host ? ` on ${s.live_host}` : ''}`
                        : (s.live_note ?? 'not checked yet')}
                    </span>
                  </span>
                </button>
                {s.last_check.status === 'error' && s.last_check.message && (
                  <p className='px-9 pb-2 text-[12px] text-rose-600 dark:text-rose-400'>
                    {s.last_check.message}
                  </p>
                )}
                {isOpen && canOpen && (
                  <div className='px-3 pb-3'>
                    <FindingsTable findings={s.findings} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** Infrastructure → Stacks: one line per stack with drift, linking to Environments. */
export function StackDriftSummary() {
  const q = useStackDrift()
  const d = q.data
  if (!d?.available || d.cloud || d.stacks.length === 0) return null
  const drifted = d.stacks.filter((s) => s.drift > 0)
  return (
    <div
      data-drift-summary
      className='mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] dark:border-border dark:bg-card'
    >
      <span className='font-medium text-slate-800 dark:text-slate-200'>Stack drift</span>
      {drifted.length === 0 ? (
        <span className='text-slate-500 dark:text-muted-foreground'>
          {d.docker_configured
            ? 'every stack with a baseline matches its last deploy'
            : 'no live source — set DOCKER_HOSTS'}
        </span>
      ) : (
        drifted.map((s) => (
          <Chip key={`${s.stack}:${s.environment}`} tone='warn'>
            {s.environment} · {s.stack}: {s.drift} field{s.drift === 1 ? '' : 's'}
          </Chip>
        ))
      )}
      <Link
        to={
          drifted[0]
            ? `/environments?drift=${encodeURIComponent(`${drifted[0].stack}:${drifted[0].environment}`)}`
            : '/environments'
        }
        className='ml-auto font-medium text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
      >
        Open on Environments
      </Link>
    </div>
  )
}
