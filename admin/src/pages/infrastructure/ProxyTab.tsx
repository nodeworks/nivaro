import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Code, fmtRate, NotConfigured, Pill } from './edge-ui'
import { Banner, Dash, LoadError, PANEL, StatStrip, TABLE, TabSkeleton, TD, TH } from './ui'

interface Server {
  url: string
  status: 'UP' | 'DOWN' | 'unknown'
}
interface Shadowing {
  winner: string
  loser: string
  sentence: string
}
interface Router {
  name: string
  rule: string
  priority: number
  priority_default: boolean
  entrypoints: string[]
  middlewares: string[]
  tls: boolean
  tls_resolver: string | null
  status: string
  errors: string[]
  service: string | null
  servers: Server[]
  healthy: number
  no_healthy_backend: boolean
  shadowed_by: Shadowing | null
  rps: number | null
  rps_5xx: number | null
}
interface View {
  version: string
  providers: string[]
  overview: Array<{ kind: string; total: number; warnings: number; errors: number }>
  routers: Router[]
  provider_errors: Array<{ router: string; provider: string; errors: string[] }>
  shadowing: Shadowing[]
  metrics: { available: boolean; reason: string | null }
}
interface Resp {
  configured: boolean
  error?: string | null
  view?: View | null
}

/** Traefik routers, their backends and rule shadowing (#2834). */
export function ProxyTab() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['infrastructure', 'proxy'],
    queryFn: async () => (await api.get('/infrastructure/proxy')).data.data as Resp,
    refetchInterval: 30_000
  })
  if (isLoading) return <TabSkeleton />
  if (error || !data) return <LoadError what='the proxy' onRetry={refetch} />
  if (!data.configured)
    return (
      <NotConfigured title='Traefik is not connected'>
        Set <Code>TRAEFIK_API_URL</Code> to the Traefik API entrypoint on an internal network
        (optionally <Code>TRAEFIK_API_TOKEN</Code>, or <Code>TRAEFIK_API_USER</Code> and{' '}
        <Code>TRAEFIK_API_PASSWORD</Code>). Nivaro only reads it.
      </NotConfigured>
    )
  if (data.error || !data.view)
    return (
      <Banner tone='warn'>
        <span className='font-medium'>Could not read Traefik.</span>{' '}
        {data.error ?? 'Traefik did not answer.'}
      </Banner>
    )
  const v = data.view
  const dead = v.routers.filter((r) => r.no_healthy_backend)
  const showRates = v.metrics.available
  return (
    <div className='space-y-4'>
      <StatStrip
        items={[
          { label: 'Traefik', value: v.version, mono: true },
          { label: 'Routers', value: v.routers.length },
          {
            label: 'Without a healthy backend',
            value: dead.length,
            tone: dead.length ? 'bad' : undefined
          },
          {
            label: 'Shadowed',
            value: v.shadowing.length,
            tone: v.shadowing.length ? 'warn' : undefined
          },
          {
            label: 'Providers',
            value: v.providers.length ? v.providers.join(', ') : '—',
            mono: true
          }
        ]}
      />
      {!showRates && v.metrics.reason && (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Request rates are hidden: {v.metrics.reason}.
        </p>
      )}

      {(dead.length > 0 || v.shadowing.length > 0 || v.provider_errors.length > 0) && (
        <section aria-label='Problems' className='space-y-2'>
          {dead.map((r) => (
            <Problem key={`d-${r.name}`} tone='bad'>
              <M>{r.name}</M> has no healthy backend: every server of{' '}
              <M>{r.service ?? 'its service'}</M> is down or none is registered.
            </Problem>
          ))}
          {v.shadowing.map((s) => (
            <Problem key={`s-${s.winner}-${s.loser}`}>{s.sentence}</Problem>
          ))}
          {v.provider_errors.map((e) => (
            <Problem key={`e-${e.router}`}>
              <M>{e.router}</M> {e.provider ? `(${e.provider}) ` : ''}
              {e.errors.length ? e.errors.join('; ') : 'reports a warning'}.
            </Problem>
          ))}
        </section>
      )}

      <div className={PANEL}>
        <table className={cn(TABLE, 'min-w-[1080px]')}>
          <thead>
            <tr>
              <th className={TH}>Router</th>
              <th className={TH}>Rule</th>
              <th className={TH}>Entrypoints</th>
              <th className={TH}>Priority</th>
              <th className={TH}>Middlewares</th>
              <th className={TH}>TLS</th>
              <th className={TH}>Backend</th>
              {showRates && <th className={cn(TH, 'text-right')}>Req/s</th>}
              {showRates && <th className={cn(TH, 'text-right')}>5xx/s</th>}
            </tr>
          </thead>
          <tbody>
            {v.routers.length === 0 && (
              <tr>
                <td
                  className={cn(TD, 'py-6 text-center text-slate-500 dark:text-muted-foreground')}
                  colSpan={showRates ? 9 : 7}
                >
                  Traefik has no HTTP routers.
                </td>
              </tr>
            )}
            {v.routers.map((r) => (
              <tr key={r.name}>
                <td className={cn(TD, 'w-[220px] max-w-[260px]')}>
                  <span className='font-mono font-medium text-slate-900 [overflow-wrap:anywhere] dark:text-foreground'>
                    {r.name}
                  </span>
                  {(r.status !== 'enabled' || r.shadowed_by) && (
                    <div className='mt-1 flex flex-wrap gap-1'>
                      {r.status !== 'enabled' && (
                        <Pill tone={r.status === 'disabled' ? 'bad' : 'warn'}>{r.status}</Pill>
                      )}
                      {r.shadowed_by && <Pill tone='warn'>shadowed</Pill>}
                    </div>
                  )}
                </td>
                <td className={cn(TD, 'min-w-[220px] max-w-[22rem]')}>
                  <code className='font-mono text-[11px] text-slate-700 [overflow-wrap:anywhere] dark:text-foreground'>
                    {r.rule}
                  </code>
                </td>
                <td className={cn(TD, 'font-mono')}>{r.entrypoints.join(', ') || <Dash />}</td>
                <td className={cn(TD, 'whitespace-nowrap tabular-nums')}>
                  <span
                    data-tip={
                      r.priority_default
                        ? 'Default priority: the length of the rule'
                        : 'Priority set on the router'
                    }
                  >
                    {r.priority}
                  </span>
                  {r.priority_default && (
                    <span className='ml-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
                      default
                    </span>
                  )}
                </td>
                <td className={cn(TD, 'min-w-[140px] font-mono text-[11px]')}>
                  {r.middlewares.length ? (
                    <ul className='space-y-0.5'>
                      {r.middlewares.map((m) => (
                        <li key={m} className='whitespace-nowrap'>
                          {m}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Dash />
                  )}
                </td>
                <td className={TD}>
                  {r.tls ? (
                    <Pill tone='ok'>{r.tls_resolver ?? 'TLS'}</Pill>
                  ) : (
                    <Pill tone='muted'>none</Pill>
                  )}
                </td>
                <td className={cn(TD, 'min-w-[240px]')}>
                  <div className='font-mono [overflow-wrap:anywhere]'>{r.service ?? <Dash />}</div>
                  {r.servers.length > 0 && (
                    <ul className='mt-1 space-y-1'>
                      {r.servers.map((s) => (
                        <li key={s.url} className='flex items-center gap-1.5'>
                          <Pill
                            tone={s.status === 'UP' ? 'ok' : s.status === 'DOWN' ? 'bad' : 'muted'}
                          >
                            {s.status === 'unknown' ? 'unchecked' : s.status.toLowerCase()}
                          </Pill>
                          <span className='whitespace-nowrap font-mono text-[11px] text-slate-600 dark:text-muted-foreground'>
                            {s.url}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {r.no_healthy_backend && (
                    <div className='mt-1'>
                      <Pill tone='bad'>no healthy backend</Pill>
                    </div>
                  )}
                </td>
                {showRates && (
                  <td className={cn(TD, 'text-right tabular-nums')}>{fmtRate(r.rps)}</td>
                )}
                {showRates && (
                  <td className={cn(TD, 'text-right tabular-nums')}>
                    {r.rps_5xx != null && r.rps_5xx > 0 ? (
                      <Pill tone='bad'>{fmtRate(r.rps_5xx)}</Pill>
                    ) : (
                      fmtRate(r.rps_5xx)
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Problem({ children, tone = 'warn' }: { children: ReactNode; tone?: 'warn' | 'bad' }) {
  return <Banner tone={tone}>{children}</Banner>
}

const M = ({ children }: { children: ReactNode }) => (
  <span className='font-mono font-medium'>{children}</span>
)
