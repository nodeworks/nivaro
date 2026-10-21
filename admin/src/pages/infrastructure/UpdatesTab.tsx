import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  Ago,
  Chip,
  EmptyNote,
  fmtDuration,
  ImageRef,
  InfraHostsView,
  matches,
  PANEL,
  type PerHost,
  SearchBox,
  StateChip,
  TABLE,
  TD,
  TH,
  useInfraHosts
} from './swarm-ui'

/** #2827 — GET /api/infrastructure/updates, one host. */
interface Policy {
  order: string
  failure_action: string
  parallelism: number
  delay_ms: number
  monitor_ms: number
  max_failure_ratio: number
}
interface Replacement {
  slot: string
  node: string | null
  old: {
    task_id: string
    digest: string | null
    image: string | null
    state: string | null
    ended_at: string | null
  } | null
  new: {
    task_id: string
    digest: string | null
    image: string | null
    state: string | null
    error: string | null
    created_at: string | null
    running_at: string | null
    healthy_at: string | null
    attempts: number
  }
  to_running_ms: number | null
  to_healthy_ms: number | null
  overlap_ms: number | null
}
interface Run {
  image: string | null
  digest: string | null
  force: number
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  approx: boolean
  tasks: number
  failed: number
  current: boolean
}
interface UpdateService {
  id: string
  name: string
  stack: string | null
  image: string | null
  digest: string | null
  update: {
    state: string | null
    started_at: string | null
    completed_at: string | null
    message: string | null
    duration_ms: number | null
  } | null
  in_flight: boolean
  policy: Policy
  rollback_policy: Policy | null
  auto_rollback: boolean
  failure_fired: string | null
  replacements: Replacement[]
  history: Run[]
}
interface HostUpdates {
  manager: boolean
  in_flight: boolean
  services: UpdateService[]
}

/** 5 s while any host has an update in flight, else once a minute. */
export function updatesPollMs(data: { hosts: PerHost<HostUpdates>[] } | undefined): number {
  return data?.hosts.some((h) => h.data?.in_flight) ? 5_000 : 60_000
}

/** Rolling update tracker: current updates per service, task by task, and past rollouts. */
export function UpdatesTab() {
  const query = useInfraHosts<HostUpdates>('updates', { refetchInterval: updatesPollMs })
  const [q, setQ] = useState('')
  const live = query.data?.hosts.some((h) => h.data?.in_flight)
  return (
    <InfraHostsView<HostUpdates>
      query={query}
      toolbar={
        <div className='flex flex-wrap items-center gap-3'>
          <SearchBox value={q} onChange={setQ} placeholder='Filter services and images' />
          <span
            className='text-[12px] text-slate-500 dark:text-muted-foreground'
            aria-live='polite'
          >
            {live
              ? 'An update is in progress — refreshing every 5 seconds.'
              : 'Refreshing every minute.'}
          </span>
        </div>
      }
    >
      {(data) => <HostUpdatesView data={data} q={q} />}
    </InfraHostsView>
  )
}

function HostUpdatesView({ data, q }: { data: HostUpdates; q: string }) {
  if (!data.manager)
    return (
      <EmptyNote>
        Rolling updates are read from a swarm manager; this host is not one (or is not in a swarm).
      </EmptyNote>
    )
  const services = data.services.filter((s) => matches(q, s.name, s.stack, s.image))
  const withUpdate = services.filter((s) => s.update || s.history.length > 1)
  const quiet = services.filter((s) => !s.update && s.history.length <= 1)
  if (services.length === 0)
    return (
      <EmptyNote>{q ? 'No service matches this filter.' : 'No services on this swarm.'}</EmptyNote>
    )
  return (
    <div className='space-y-4'>
      {withUpdate.map((s) => (
        <ServiceUpdate key={s.id} s={s} />
      ))}
      {quiet.length > 0 && (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Never updated since the swarm's task history began:{' '}
          <span className='font-mono'>{quiet.map((s) => s.name).join(', ')}</span>
        </p>
      )}
    </div>
  )
}

function PolicyLine({ p, label }: { p: Policy; label: string }) {
  return (
    <span>
      {label}: <span className='font-mono'>{p.order}</span>, {p.parallelism} at a time
      {p.delay_ms ? `, ${fmtDuration(p.delay_ms)} apart` : ''}, watched {fmtDuration(p.monitor_ms)},
      on failure <span className='font-mono'>{p.failure_action}</span>
      {p.max_failure_ratio ? ` (tolerates ${Math.round(p.max_failure_ratio * 100)}% failing)` : ''}
    </span>
  )
}

function ServiceUpdate({ s }: { s: UpdateService }) {
  const u = s.update
  return (
    <div className={cn(PANEL, s.in_flight && 'border-nvr-cyan/50 dark:border-nvr-cyan/40')}>
      <div className='space-y-1.5 border-b border-slate-200 px-4 py-3 dark:border-border'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='font-mono text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            {s.name}
          </span>
          {u?.state && <StateChip state={u.state} tip={u.message ?? undefined} />}
          {s.auto_rollback && (
            <Chip tone='muted' tip='The update rolls back by itself when tasks fail'>
              auto-rollback
            </Chip>
          )}
          {s.failure_fired && <Chip tone='bad'>{s.failure_fired}</Chip>}
          <span className='ml-auto'>
            <ImageRef image={s.image} digest={s.digest} />
          </span>
        </div>
        {u && (
          <p className='text-[12px] text-slate-600 dark:text-muted-foreground'>
            Started <Ago at={u.started_at} />
            {u.completed_at ? (
              <>
                , finished <Ago at={u.completed_at} />
              </>
            ) : null}
            {u.duration_ms != null &&
              ` · ${s.in_flight ? 'running for' : 'took'} ${fmtDuration(u.duration_ms)}`}
            {u.message && <> · {u.message}</>}
          </p>
        )}
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          <PolicyLine p={s.policy} label='Update' />
          {s.rollback_policy && (
            <>
              {' · '}
              <PolicyLine p={s.rollback_policy} label='Rollback' />
            </>
          )}
        </p>
      </div>
      {s.replacements.length > 0 && (
        <table className={TABLE}>
          <caption className='px-4 pt-3 text-left text-[12px] font-medium text-slate-700 dark:text-foreground'>
            Latest rollout, slot by slot
          </caption>
          <thead>
            <tr>
              <th className={TH}>Slot</th>
              <th className={TH}>Node</th>
              <th className={TH}>Old → new</th>
              <th className={TH}>New task</th>
              <th className={TH}>To running</th>
              <th className={TH}>To healthy</th>
              {s.policy.order === 'start-first' && <th className={TH}>Overlap</th>}
            </tr>
          </thead>
          <tbody>
            {s.replacements.map((r) => (
              <tr key={r.slot}>
                <td className={cn(TD, 'font-mono')}>{r.slot.replace(/^s/, '')}</td>
                <td className={cn(TD, 'font-mono')}>{r.node ?? '—'}</td>
                <td className={cn(TD, 'font-mono text-[11px]')}>
                  {r.old?.digest ? `@${r.old.digest.slice(0, 7)}` : '—'} →{' '}
                  {r.new.digest ? `@${r.new.digest.slice(0, 7)}` : (r.new.image ?? '—')}
                </td>
                <td className={TD}>
                  <span className='inline-flex flex-wrap items-center gap-1'>
                    <StateChip state={r.new.state} />
                    {r.new.attempts > 1 && <Chip tone='warn'>{r.new.attempts} attempts</Chip>}
                  </span>
                  {r.new.error && (
                    <span className='mt-0.5 block text-[11px] text-red-600 dark:text-red-400'>
                      {r.new.error}
                    </span>
                  )}
                </td>
                <td className={cn(TD, 'tabular-nums')}>{fmtDuration(r.to_running_ms)}</td>
                <td className={cn(TD, 'tabular-nums')}>
                  {r.to_healthy_ms != null ? (
                    fmtDuration(r.to_healthy_ms)
                  ) : (
                    <span
                      className='text-slate-400'
                      data-tip='Only known for containers on this host that have a healthcheck'
                    >
                      —
                    </span>
                  )}
                </td>
                {s.policy.order === 'start-first' && (
                  <td className={cn(TD, 'tabular-nums')}>{fmtDuration(r.overlap_ms)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {s.history.length > 0 && (
        <table
          className={cn(
            TABLE,
            s.replacements.length > 0 && 'border-t border-slate-200 dark:border-border'
          )}
        >
          <caption className='px-4 pt-3 text-left text-[12px] font-medium text-slate-700 dark:text-foreground'>
            Rollouts in the task history
          </caption>
          <thead>
            <tr>
              <th className={TH}>Image</th>
              <th className={TH}>Started</th>
              <th className={TH}>Took</th>
              <th className={TH}>Tasks</th>
              <th className={TH}>Failed</th>
            </tr>
          </thead>
          <tbody>
            {s.history.map((h) => (
              <tr key={`${h.digest}|${h.force}|${h.started_at}`}>
                <td className={cn(TD, 'max-w-[300px]')}>
                  <span className='inline-flex items-center gap-1.5'>
                    <ImageRef image={h.image} digest={h.digest} />
                    {h.current && <Chip tone='info'>current</Chip>}
                    {h.force > 0 && (
                      <Chip tone='muted' tip='Forced update counter'>
                        force {h.force}
                      </Chip>
                    )}
                  </span>
                </td>
                <td className={TD}>
                  <Ago at={h.started_at} />
                </td>
                <td className={cn(TD, 'tabular-nums')}>
                  <span
                    data-tip={
                      h.approx
                        ? 'At least this long: some tasks have stopped since, so the time they started running is gone'
                        : undefined
                    }
                  >
                    {h.approx && h.duration_ms != null ? '≥ ' : ''}
                    {fmtDuration(h.duration_ms)}
                  </span>
                </td>
                <td className={cn(TD, 'tabular-nums')}>{h.tasks}</td>
                <td
                  className={cn(
                    TD,
                    'tabular-nums',
                    h.failed ? 'text-red-600 dark:text-red-400' : ''
                  )}
                >
                  {h.failed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
