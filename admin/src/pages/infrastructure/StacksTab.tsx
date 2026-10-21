import { ChevronRight } from 'lucide-react'
import { Fragment, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  Ago,
  Chip,
  EmptyNote,
  FilterChip,
  ImageRef,
  InfraHostsView,
  matches,
  PANEL,
  SearchBox,
  StateChip,
  StatStrip,
  TABLE,
  TD,
  TH,
  useInfraHosts
} from './swarm-ui'
import { Note, PANEL_TITLE } from './ui'

/** #2826 — GET /api/infrastructure/stacks, one host. */
interface StackTask {
  id: string
  slot: number | null
  node: string | null
  state: string | null
  desired_state: string | null
  error: string | null
  message: string | null
  image: string | null
  digest: string | null
  exit_code: number | null
  created_at: string | null
  state_at: string | null
}
interface StackService {
  id: string
  name: string
  short_name: string
  mode: 'replicated' | 'global' | 'job'
  desired: number | null
  running: number
  image: string | null
  digest: string | null
  ports: string[]
  created_at: string | null
  updated_at: string | null
  update_status: { state: string | null; message: string | null } | null
  failing: boolean
  failing_reason: string | null
  tasks: StackTask[]
  task_total: number
}
interface StackContainer {
  id: string
  name: string
  service: string | null
  image: string | null
  state: string | null
  status: string | null
  health: 'healthy' | 'unhealthy' | 'starting' | null
  ports: string[]
  created_at: string | null
  failing: boolean
}
interface HostStacks {
  swarm: 'manager' | 'worker' | 'none'
  stacks: Array<{ name: string; services: StackService[] }>
  projects: Array<{
    kind: 'compose' | 'swarm-local' | 'standalone'
    name: string
    containers: StackContainer[]
  }>
  counts: {
    services: number
    running: number
    desired: number
    failing: number
    containers: number
    containers_running: number
    containers_failing: number
  }
}

/** Stack map: swarm stacks → services → tasks → node, and compose projects → containers. */
export function StacksTab() {
  const query = useInfraHosts<HostStacks>('stacks', { refetchInterval: 30_000 })
  const [q, setQ] = useState('')
  const [failingOnly, setFailingOnly] = useState(false)
  return (
    <InfraHostsView<HostStacks>
      query={query}
      aside={(d) =>
        d && (
          <>
            <span className='tabular-nums'>
              {d.swarm === 'manager' ? `${d.counts.services} services · ` : ''}
              {d.counts.containers} containers
            </span>
            {d.counts.failing + d.counts.containers_failing > 0 ? (
              <Chip tone='bad' icon>
                {d.counts.failing + d.counts.containers_failing} failing
              </Chip>
            ) : (
              <Chip tone='ok' icon>
                All running
              </Chip>
            )}
          </>
        )
      }
      toolbar={
        <div className='flex flex-wrap items-center gap-2'>
          <SearchBox value={q} onChange={setQ} placeholder='Filter stacks, services, images' />
          <FilterChip on={failingOnly} onToggle={() => setFailingOnly((v) => !v)}>
            Failing only
          </FilterChip>
        </div>
      }
    >
      {(data) => <HostStacksView data={data} q={q} failingOnly={failingOnly} />}
    </InfraHostsView>
  )
}

function HostStacksView({
  data,
  q,
  failingOnly
}: {
  data: HostStacks
  q: string
  failingOnly: boolean
}) {
  const c = data.counts
  const stacks = data.stacks
    .map((s) => ({
      ...s,
      services: s.services.filter(
        (x) => (!failingOnly || x.failing) && matches(q, s.name, x.name, x.image, x.failing_reason)
      )
    }))
    .filter((s) => s.services.length > 0)
  const projects = data.projects
    .map((p) => ({
      ...p,
      containers: p.containers.filter(
        (x) => (!failingOnly || x.failing) && matches(q, p.name, x.name, x.service, x.image)
      )
    }))
    .filter((p) => p.containers.length > 0)
  const nothing = stacks.length === 0 && projects.length === 0
  return (
    <div className='space-y-4'>
      <StatStrip
        items={[
          ...(data.swarm === 'manager'
            ? [
                { label: 'Services', value: c.services },
                {
                  label: 'Running / desired',
                  value: `${c.running} / ${c.desired}`,
                  tone: c.running < c.desired ? ('warn' as const) : undefined
                },
                {
                  label: 'Failing services',
                  value: c.failing,
                  tone: c.failing ? ('bad' as const) : undefined
                }
              ]
            : []),
          { label: 'Containers', value: c.containers },
          { label: 'Running', value: c.containers_running },
          {
            label: 'Failing containers',
            value: c.containers_failing,
            tone: c.containers_failing ? ('bad' as const) : undefined
          }
        ]}
      />
      {data.swarm === 'worker' && (
        <Note>
          This host is a swarm worker: services and other nodes' tasks are only visible from a
          manager. Its own task containers are listed below.
        </Note>
      )}
      {nothing && (
        <EmptyNote>
          {q || failingOnly
            ? 'Nothing matches this filter.'
            : 'No stacks, services or containers on this host.'}
        </EmptyNote>
      )}
      {stacks.map((s) => (
        <StackTable key={`s:${s.name}`} name={s.name} services={s.services} />
      ))}
      {projects.map((p) => (
        <ContainerTable key={`${p.kind}:${p.name}`} group={p} />
      ))}
    </div>
  )
}

function GroupHeading({
  name,
  fallback,
  kind,
  count
}: {
  name: string
  fallback: string
  kind: string
  count: string
}) {
  return (
    <div className={PANEL_TITLE}>
      <span
        className={cn(
          'text-[13px] font-semibold text-slate-900 dark:text-foreground',
          name && 'font-mono'
        )}
      >
        {name || fallback}
      </span>
      <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
        {kind} · {count}
      </span>
    </div>
  )
}

function replicaTone(s: StackService): 'ok' | 'bad' | 'warn' | 'muted' {
  if (s.mode === 'job') return 'muted'
  if (s.desired == null) return 'muted'
  if (s.running >= s.desired) return 'ok'
  return s.running === 0 ? 'bad' : 'warn'
}

function StackTable({ name, services }: { name: string; services: StackService[] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <div className={PANEL}>
      <GroupHeading
        name={name}
        fallback='Services outside a stack'
        kind={name ? 'stack' : 'swarm'}
        count={`${services.length} service${services.length === 1 ? '' : 's'}`}
      />
      <table className={TABLE}>
        <thead>
          <tr>
            <th className={TH}>Service</th>
            <th className={TH}>Replicas</th>
            <th className={TH}>Image</th>
            <th className={TH}>Update</th>
            <th className={TH}>Ports</th>
            <th className={TH}>Updated</th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => {
            const isOpen = open.has(s.id)
            return (
              <Fragment key={s.id}>
                <tr>
                  <td className={cn(TD, 'min-w-[200px]')}>
                    <button
                      type='button'
                      aria-expanded={isOpen}
                      onClick={() => toggle(s.id)}
                      className='flex items-start gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan rounded'
                    >
                      <ChevronRight
                        className={cn(
                          'mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150',
                          isOpen && 'rotate-90'
                        )}
                      />
                      <span>
                        <span className='font-mono font-medium text-slate-900 dark:text-foreground'>
                          {s.short_name}
                        </span>
                        {s.failing_reason && (
                          <span className='mt-0.5 block text-[11px] text-red-600 dark:text-red-400'>
                            {s.failing_reason}
                          </span>
                        )}
                      </span>
                    </button>
                  </td>
                  <td className={TD}>
                    <Chip
                      tone={replicaTone(s)}
                      tip={s.mode === 'global' ? 'One task per eligible node' : undefined}
                    >
                      {s.mode === 'job'
                        ? 'job'
                        : `${s.running} / ${s.desired ?? '?'}${s.mode === 'global' ? ' global' : ''}`}
                    </Chip>
                  </td>
                  <td className={cn(TD, 'max-w-[260px]')}>
                    <ImageRef image={s.image} digest={s.digest} />
                  </td>
                  <td className={TD}>
                    {s.update_status?.state ? (
                      <StateChip
                        state={s.update_status.state}
                        tip={s.update_status.message ?? undefined}
                      />
                    ) : (
                      <span className='text-slate-400'>—</span>
                    )}
                  </td>
                  <td className={cn(TD, 'font-mono text-[11px]')}>
                    {s.ports.length ? (
                      s.ports.join(', ')
                    ) : (
                      <span className='text-slate-400'>—</span>
                    )}
                  </td>
                  <td className={TD}>
                    <span className='text-slate-600 dark:text-muted-foreground'>
                      <Ago at={s.updated_at} />
                    </span>
                  </td>
                </tr>
                {isOpen && (
                  <tr className='hover:bg-transparent dark:hover:bg-transparent'>
                    <td
                      colSpan={6}
                      className='border-b border-slate-100 bg-slate-50 px-3 py-2 dark:border-border/60 dark:bg-background'
                    >
                      <TaskList service={s} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TaskList({ service }: { service: StackService }) {
  if (service.tasks.length === 0)
    return (
      <p className='py-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
        No tasks: the swarm has not scheduled this service.
      </p>
    )
  return (
    <div>
      <table className={TABLE}>
        <thead>
          <tr>
            <th className={TH}>Slot</th>
            <th className={TH}>State</th>
            <th className={TH}>Node</th>
            <th className={TH}>Image</th>
            <th className={TH}>Error or message</th>
            <th className={TH}>Created</th>
            <th className={TH}>State since</th>
          </tr>
        </thead>
        <tbody>
          {service.tasks.map((t) => (
            <tr key={t.id}>
              <td className={cn(TD, 'font-mono tabular-nums')}>{t.slot || '—'}</td>
              <td className={TD}>
                <span className='inline-flex items-center gap-1'>
                  <StateChip state={t.state} />
                  {t.desired_state && t.desired_state !== t.state && (
                    <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                      → {t.desired_state}
                    </span>
                  )}
                </span>
              </td>
              <td className={cn(TD, 'font-mono')}>{t.node ?? '—'}</td>
              <td className={cn(TD, 'font-mono text-[11px]')}>
                {t.digest ? `@${t.digest.slice(0, 7)}` : (t.image ?? '—')}
              </td>
              <td className={cn(TD, 'max-w-[420px]')}>
                {t.error ? (
                  <span className='text-red-600 dark:text-red-400'>
                    {t.error}
                    {t.exit_code != null && t.exit_code !== 0 ? ` (exit ${t.exit_code})` : ''}
                  </span>
                ) : (
                  <span className='text-slate-600 dark:text-muted-foreground'>
                    {t.message ?? '—'}
                  </span>
                )}
              </td>
              <td className={TD}>
                <Ago at={t.created_at} />
              </td>
              <td className={TD}>
                <Ago at={t.state_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {service.task_total > service.tasks.length && (
        <p className='px-3 pt-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
          Showing the newest {service.tasks.length} of {service.task_total} tasks the swarm still
          remembers (latest four per slot).
        </p>
      )}
    </div>
  )
}

const KIND_LABEL = {
  compose: 'compose project',
  'swarm-local': 'stack tasks on this node',
  standalone: 'containers'
}

function ContainerTable({ group }: { group: HostStacks['projects'][number] }) {
  return (
    <div className={PANEL}>
      <GroupHeading
        name={group.name}
        fallback='Standalone containers'
        kind={KIND_LABEL[group.kind]}
        count={`${group.containers.length} container${group.containers.length === 1 ? '' : 's'}`}
      />
      <table className={TABLE}>
        <thead>
          <tr>
            <th className={TH}>Container</th>
            <th className={TH}>State</th>
            <th className={TH}>Status</th>
            <th className={TH}>Image</th>
            <th className={TH}>Ports</th>
            <th className={TH}>Created</th>
          </tr>
        </thead>
        <tbody>
          {group.containers.map((c) => (
            <tr key={c.id}>
              <td className={TD}>
                <span className='font-mono font-medium text-slate-900 dark:text-foreground'>
                  {c.service ?? c.name}
                </span>
                {c.service && c.service !== c.name && (
                  <span className='block font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {c.name}
                  </span>
                )}
              </td>
              <td className={TD}>
                <span className='inline-flex gap-1'>
                  <StateChip state={c.state} />
                  {c.health && <StateChip state={c.health} />}
                </span>
              </td>
              <td
                className={cn(
                  TD,
                  c.failing
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-slate-600 dark:text-muted-foreground'
                )}
              >
                {c.status ?? '—'}
              </td>
              <td className={cn(TD, 'max-w-[260px]')}>
                <ImageRef image={c.image} />
              </td>
              <td className={cn(TD, 'font-mono text-[11px]')}>
                {c.ports.length ? c.ports.join(', ') : <span className='text-slate-400'>—</span>}
              </td>
              <td className={TD}>
                <Ago at={c.created_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
