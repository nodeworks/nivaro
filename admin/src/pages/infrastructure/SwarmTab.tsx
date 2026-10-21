import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn, formatDate, formatFileSize } from '@/lib/utils'
import {
  Chip,
  EmptyNote,
  fmtDuration,
  InfraHostsView,
  META_CELL,
  META_GRID,
  PANEL,
  StateChip,
  TABLE,
  TD,
  TH,
  useInfraHosts
} from './swarm-ui'

/** #2838 — GET /api/infrastructure/swarm, one host. */
interface SwarmNode {
  id: string
  hostname: string
  role: string | null
  availability: string | null
  state: string | null
  message: string | null
  addr: string | null
  engine: string | null
  platform: string | null
  cpus: number | null
  memory_bytes: number | null
  labels: Record<string, string>
  engine_labels: Record<string, string>
  leader: boolean
  reachability: string | null
  self: boolean
}
interface HostSwarm {
  state: string | null
  manager: boolean
  error: string | null
  counts: { nodes: number | null; managers: number | null; reachable_managers: number | null }
  nodes: SwarmNode[]
  cluster: {
    id: string | null
    created_at: string | null
    node_cert_expiry_ms: number | null
    task_history_limit: number | null
    autolock: boolean
    external_ca: boolean
    root_rotation: boolean
    raft: {
      snapshot_interval: number | null
      keep_old_snapshots: number | null
      log_entries_for_slow_followers: number | null
      election_tick: number | null
      heartbeat_tick: number | null
    }
    dispatcher_heartbeat_ms: number | null
    data_path_port: number | null
    default_addr_pool: string[]
    subnet_size: number | null
  } | null
  cert: { expires_at: string; days_left: number; warn: boolean } | null
  cert_source: 'metric' | 'not-collected'
  warnings: string[]
}

/** Swarm internals: managers and quorum, nodes, and the cluster's Raft / CA settings. */
export function SwarmTab() {
  const query = useInfraHosts<HostSwarm, { host_facts: boolean }>('swarm', {
    refetchInterval: 60_000
  })
  return (
    <InfraHostsView<HostSwarm> query={query}>
      {(data) => <HostSwarmView data={data} />}
    </InfraHostsView>
  )
}

function Meta({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className={cn(META_GRID, 'grid-cols-[repeat(auto-fill,minmax(180px,1fr))]')}>
      {items.map(([k, v]) => (
        <div key={k} className={cn(META_CELL, 'px-3 py-2')}>
          <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>{k}</dt>
          <dd className='mt-0.5 text-[12px] text-slate-900 dark:text-foreground'>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

const dash = <span className='text-slate-400'>—</span>

function Labels({ labels }: { labels: Record<string, string> }) {
  const entries = Object.entries(labels)
  if (!entries.length) return dash
  return (
    <span className='flex flex-wrap gap-1'>
      {entries.map(([k, v]) => (
        <span
          key={k}
          className='rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-muted dark:text-muted-foreground'
        >
          {k}={v}
        </span>
      ))}
    </span>
  )
}

function HostSwarmView({ data }: { data: HostSwarm }) {
  if (data.state !== 'active')
    return (
      <EmptyNote>
        This host is not in a swarm{data.state ? ` (state: ${data.state})` : ''}.
        {data.error ? ` ${data.error}` : ''}
      </EmptyNote>
    )
  const c = data.cluster
  return (
    <div className='space-y-4'>
      {data.warnings.length > 0 && (
        <ul className='space-y-1.5'>
          {data.warnings.map((w) => (
            <li
              key={w}
              className='flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
            >
              <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
              {w}
            </li>
          ))}
        </ul>
      )}
      <Meta
        items={[
          [
            'Managers reachable',
            data.counts.reachable_managers != null
              ? `${data.counts.reachable_managers} of ${data.counts.managers ?? '?'}`
              : (data.counts.managers ?? '—')
          ],
          ['Nodes', data.counts.nodes ?? '—'],
          ['This node', data.manager ? 'Manager' : 'Worker'],
          [
            'Node certificate (this host)',
            data.cert ? (
              <span key='cert' className={cn(data.cert.warn && 'text-red-600 dark:text-red-400')}>
                Expires {formatDate(data.cert.expires_at)} ({data.cert.days_left} days)
              </span>
            ) : (
              <span key='cert' className='text-slate-500 dark:text-muted-foreground'>
                Host facts not collected
              </span>
            )
          ],
          ...(c
            ? ([
                ['Certificate lifetime', fmtDuration(c.node_cert_expiry_ms)],
                [
                  'Task history kept',
                  c.task_history_limit != null ? `${c.task_history_limit} per slot` : dash
                ],
                [
                  'Autolock',
                  <span
                    key='a'
                    data-tip='Kept off so hosts can restart without someone unlocking them'
                  >
                    {c.autolock ? 'On' : 'Off'}
                  </span>
                ],
                ['External CA', c.external_ca ? 'Yes' : 'No'],
                [
                  'Raft snapshot every',
                  c.raft.snapshot_interval != null ? `${c.raft.snapshot_interval} entries` : dash
                ],
                ['Old snapshots kept', c.raft.keep_old_snapshots ?? dash],
                [
                  'Election / heartbeat ticks',
                  `${c.raft.election_tick ?? '?'} / ${c.raft.heartbeat_tick ?? '?'}`
                ],
                ['Dispatcher heartbeat', fmtDuration(c.dispatcher_heartbeat_ms)],
                ['Data path port', c.data_path_port ?? dash],
                [
                  'Address pool',
                  c.default_addr_pool.length ? (
                    <span key='pool' className='font-mono'>
                      {c.default_addr_pool.join(', ')}
                      {c.subnet_size ? ` /${c.subnet_size}` : ''}
                    </span>
                  ) : (
                    dash
                  )
                ],
                ['Swarm created', c.created_at ? formatDate(c.created_at) : dash]
              ] as Array<[string, ReactNode]>)
            : [])
        ]}
      />
      {!c && data.manager && (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Cluster settings are not in this host's system info (older engine, or the info section is
          off on the proxy).
        </p>
      )}
      {data.manager ? (
        <div className={PANEL}>
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Node</th>
                <th className={TH}>Role</th>
                <th className={TH}>State</th>
                <th className={TH}>Availability</th>
                <th className={TH}>Engine</th>
                <th className={TH}>Size</th>
                <th className={TH}>Labels</th>
              </tr>
            </thead>
            <tbody>
              {data.nodes.map((n) => (
                <tr key={n.id}>
                  <td className={TD}>
                    <span className='font-mono font-medium text-slate-900 dark:text-foreground'>
                      {n.hostname}
                    </span>
                    {n.self && (
                      <span className='ml-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                        (this host)
                      </span>
                    )}
                    <span className='block font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                      {n.addr ?? ''}
                    </span>
                  </td>
                  <td className={TD}>
                    <span className='inline-flex flex-wrap items-center gap-1'>
                      <span>{n.role ?? '—'}</span>
                      {n.leader && <Chip tone='info'>leader</Chip>}
                      {n.role === 'manager' && !n.leader && n.reachability && (
                        <StateChip state={n.reachability} />
                      )}
                    </span>
                  </td>
                  <td className={TD}>
                    <StateChip state={n.state} tip={n.message ?? undefined} />
                  </td>
                  <td className={TD}>
                    <StateChip state={n.availability} />
                  </td>
                  <td className={cn(TD, 'font-mono')}>
                    {n.engine ?? '—'}
                    {n.platform && (
                      <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                        {n.platform}
                      </span>
                    )}
                  </td>
                  <td className={cn(TD, 'whitespace-nowrap tabular-nums')}>
                    {n.cpus != null ? `${n.cpus} CPUs` : '—'}
                    {n.memory_bytes ? ` · ${formatFileSize(n.memory_bytes)}` : ''}
                  </td>
                  <td className={cn(TD, 'max-w-[320px]')}>
                    <Labels labels={{ ...n.engine_labels, ...n.labels }} />
                  </td>
                </tr>
              ))}
              {data.nodes.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className={cn(TD, 'py-6 text-center text-slate-500 dark:text-muted-foreground')}
                  >
                    The node list is not readable: the proxy does not allow the nodes section.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          The node list is read from a manager; this host is a worker.
        </p>
      )}
    </div>
  )
}
