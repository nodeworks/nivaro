import { useQuery } from '@tanstack/react-query'
import { Eye, RotateCw } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Arming preview (#772): what the first cycle of each Phase-2 pass would do
 * if its switch were on right now — read from
 * GET /integration-obligations/arming-preview, which runs every pass in dry
 * run (nothing is claimed, stamped or sent).
 */

interface PlanRow {
  obligation_id?: number
  id?: number
  submission_id?: number | null
  api: string | null
  kind: string | null
  collection: string | null
  item: string | null
  label?: string | null
  error_class?: string | null
  attempts?: number
  due_at?: string | null
  reason?: string | null
  outcome?: string
  recipients?: number
}

interface ArmingPreview {
  notifications: {
    enabled: boolean
    plan: {
      obligations: number
      messages: number
      recipientless: number
      recipients: Array<{ id: string; name: string; messages: number }>
      rows: PlanRow[]
    } | null
  }
  remediation: {
    enabled: boolean
    retry: {
      retry: PlanRow[]
      waiting: PlanRow[]
      give_up: PlanRow[]
      by_error_class: Record<string, { retry: number; waiting: number; give_up: number }>
    } | null
    refire: {
      refire: PlanRow[]
      queued: PlanRow[]
      left_for_a_person: Array<{ api: string; kind: string; count: number; reason: string }>
    } | null
  }
  generated_at: string
}

const ERROR_CLASS_LABEL: Record<string, string> = {
  transient: 'Transient (network, 5xx)',
  rate_limited: 'Rate limited (429)',
  auth: 'Sign-in refused (401/403)',
  not_found: 'Not found (404)',
  validation: 'Rejected (validation)',
  unknown: 'Unknown'
}

const SHOWN = 12

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

function rowLabel(r: PlanRow): string {
  return r.label || (r.collection && r.item ? `${r.collection} #${r.item}` : `#${r.obligation_id}`)
}

function SwitchState({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-px text-[10.5px] font-semibold uppercase tracking-wide',
        on
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
          : 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
      )}
    >
      {on ? 'on — runs every cycle' : 'off — nothing sent yet'}
    </span>
  )
}

function RowList({ rows, extra }: { rows: PlanRow[]; extra?: (r: PlanRow) => string | null }) {
  const [all, setAll] = useState(false)
  if (rows.length === 0) return null
  const shown = all ? rows : rows.slice(0, SHOWN)
  return (
    <ul className='mt-1.5 space-y-0.5 text-[12px]'>
      {shown.map((r) => (
        <li
          key={`${r.obligation_id ?? r.id}-${r.submission_id ?? ''}`}
          className='flex flex-wrap items-baseline gap-x-2 text-slate-700 dark:text-foreground'
        >
          <span className='font-medium'>{rowLabel(r)}</span>
          <span className='text-slate-500 dark:text-muted-foreground'>
            {[r.api, r.kind].filter(Boolean).join(' · ')}
          </span>
          {extra?.(r) && (
            <span className='text-slate-500 dark:text-muted-foreground'>{extra(r)}</span>
          )}
        </li>
      ))}
      {rows.length > SHOWN && (
        <li>
          <button
            type='button'
            onClick={() => setAll((v) => !v)}
            className='text-[11.5px] font-medium text-slate-600 underline decoration-nvr-cyan/60 underline-offset-2 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
          >
            {all ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        </li>
      )}
    </ul>
  )
}

function Block({
  title,
  on,
  children,
  hook
}: {
  title: string
  on: boolean
  children: ReactNode
  hook: string
}) {
  return (
    <div
      data-arming-block={hook}
      className='rounded-md border border-slate-200 bg-white px-3 py-2.5 dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-center gap-2'>
        <p className='text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>{title}</p>
        <SwitchState on={on} />
      </div>
      <div className='mt-1.5'>{children}</div>
    </div>
  )
}

export function ObligationsArmingPreview() {
  const [asked, setAsked] = useState(false)
  const q = useQuery({
    queryKey: ['integration-obligations-arming-preview'],
    queryFn: () =>
      api.get('/integration-obligations/arming-preview').then((r) => r.data.data as ArmingPreview),
    enabled: asked,
    staleTime: 30_000
  })
  const p = q.data

  return (
    <div
      data-arming-preview
      className='rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-border dark:bg-background'
    >
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='min-w-0'>
          <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
            What the first cycle would do
          </p>
          <p className='mt-0.5 max-w-[72ch] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            A dry run of the three passes against today's ledger: who would be told, which
            submissions would retry, which missing messages would be sent again. Nothing is sent,
            claimed or recorded by looking.
          </p>
        </div>
        <Button
          type='button'
          variant='outline'
          size='sm'
          data-arming-preview-run
          disabled={q.isFetching}
          onClick={() => (asked ? void q.refetch() : setAsked(true))}
        >
          {asked ? (
            <RotateCw className={cn('mr-1.5 h-3.5 w-3.5', q.isFetching && 'animate-spin')} />
          ) : (
            <Eye className='mr-1.5 h-3.5 w-3.5' />
          )}
          {asked ? 'Check again' : 'Preview'}
        </Button>
      </div>

      {asked && q.isLoading && (
        <div className='mt-3 space-y-2'>
          <Skeleton className='h-14' />
          <Skeleton className='h-14' />
          <Skeleton className='h-14' />
        </div>
      )}
      {q.isError && (
        <p className='mt-2 text-[12px] text-red-600 dark:text-red-400'>
          Couldn't build the preview. Try again in a moment.
        </p>
      )}

      {p && (
        <div className='mt-3 space-y-2'>
          <Block title='Notify on unmet obligations' on={p.notifications.enabled} hook='notify'>
            {!p.notifications.plan || p.notifications.plan.obligations === 0 ? (
              <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                Nobody would be told — no unmet obligation is due a message.
              </p>
            ) : (
              <>
                <p className='text-[12px] text-slate-700 dark:text-foreground' data-arming-notify>
                  {plural(p.notifications.plan.messages, 'message', 'messages')} to{' '}
                  {plural(p.notifications.plan.recipients.length, 'person', 'people')} about{' '}
                  {plural(p.notifications.plan.obligations, 'obligation', 'obligations')}.
                  {p.notifications.plan.recipientless > 0 && (
                    <span className='text-amber-700 dark:text-amber-400'>
                      {' '}
                      {plural(
                        p.notifications.plan.recipientless,
                        'obligation has',
                        'obligations have'
                      )}{' '}
                      nobody to tell (no integration owner, no open record owner).
                    </span>
                  )}
                </p>
                <div className='mt-1.5 flex flex-wrap gap-1.5'>
                  {p.notifications.plan.recipients.map((u) => (
                    <span
                      key={u.id}
                      data-arming-recipient={u.id}
                      className='rounded-full border border-slate-200 bg-slate-50 px-2 py-px text-[11.5px] text-slate-700 dark:border-border dark:bg-muted dark:text-foreground'
                    >
                      {u.name}
                      <span className='ml-1 tabular-nums text-slate-500 dark:text-muted-foreground'>
                        ×{u.messages}
                      </span>
                    </span>
                  ))}
                </div>
                <RowList
                  rows={p.notifications.plan.rows}
                  extra={(r) =>
                    `${r.outcome ?? ''}${r.recipients ? '' : ' · nobody to tell'}`.trim() || null
                  }
                />
              </>
            )}
          </Block>

          <Block title='Retry failed sends' on={p.remediation.enabled} hook='retry'>
            {!p.remediation.retry ||
            p.remediation.retry.retry.length +
              p.remediation.retry.waiting.length +
              p.remediation.retry.give_up.length ===
              0 ? (
              <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                Nothing would retry — no failed send has a cause repetition could fix.
              </p>
            ) : (
              <>
                <table className='w-full text-[12px]' data-arming-retry>
                  <thead>
                    <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
                      <th className='py-1 pr-3 font-semibold'>Why it failed</th>
                      <th className='py-1 pr-3 text-right font-semibold'>Retry now</th>
                      <th className='py-1 pr-3 text-right font-semibold'>Waiting</th>
                      <th className='py-1 text-right font-semibold'>Hand to a person</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(p.remediation.retry.by_error_class).map(([cls, n]) => (
                      <tr
                        key={cls}
                        data-arming-retry-class={cls}
                        className='border-t border-slate-100 dark:border-border'
                      >
                        <td className='py-1 pr-3 text-slate-700 dark:text-foreground'>
                          {ERROR_CLASS_LABEL[cls] ?? cls}
                        </td>
                        <td className='py-1 pr-3 text-right tabular-nums'>{n.retry}</td>
                        <td className='py-1 pr-3 text-right tabular-nums'>{n.waiting}</td>
                        <td className='py-1 text-right tabular-nums'>{n.give_up}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <RowList
                  rows={p.remediation.retry.retry}
                  extra={(r) => `attempt ${(r.attempts ?? 0) + 1}`}
                />
              </>
            )}
          </Block>

          <Block title='Re-send missing messages' on={p.remediation.enabled} hook='refire'>
            {p.remediation.refire && p.remediation.refire.refire.length > 0 ? (
              <>
                <p className='text-[12px] text-slate-700 dark:text-foreground' data-arming-refire>
                  {plural(p.remediation.refire.refire.length, 'message', 'messages')} would be sent
                  again by repeating the most recent request for the same record.
                </p>
                <RowList
                  rows={p.remediation.refire.refire}
                  extra={(r) => (r.submission_id ? `repeats request #${r.submission_id}` : null)}
                />
              </>
            ) : (
              <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                Nothing would be sent again.
              </p>
            )}
            {p.remediation.refire && p.remediation.refire.queued.length > 0 && (
              <p className='mt-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
                {plural(
                  p.remediation.refire.queued.length,
                  'missing message stays',
                  'missing messages stay'
                )}{' '}
                on the board — nothing earlier to repeat.
              </p>
            )}
            {p.remediation.refire && p.remediation.refire.left_for_a_person.length > 0 && (
              <ul className='mt-1.5 space-y-0.5 text-[12px]' data-arming-left>
                {p.remediation.refire.left_for_a_person.map((k) => (
                  <li
                    key={`${k.api}:${k.kind}`}
                    className='text-slate-600 dark:text-muted-foreground'
                  >
                    <span className='font-medium text-slate-700 dark:text-foreground'>
                      {k.api} · {k.kind}
                    </span>{' '}
                    — {plural(k.count, 'missing message', 'missing messages')} left for a person:{' '}
                    {k.reason}
                  </li>
                ))}
              </ul>
            )}
          </Block>
          <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            Checked {new Date(p.generated_at).toLocaleTimeString()}. Each pass looks at a batch at a
            time (200 notifications, 50 retries, 25 re-sends); later cycles pick up the rest.
          </p>
        </div>
      )}
    </div>
  )
}
