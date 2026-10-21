import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { Code, fmtRate, NotConfigured, Pill, TABLE_WRAP, TD, TH } from './edge-ui'

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
  const { data, isLoading, error } = useQuery({
    queryKey: ['infrastructure', 'proxy'],
    queryFn: async () => (await api.get('/infrastructure/proxy')).data.data as Resp,
    refetchInterval: 30_000
  })
  if (isLoading) return <Skeleton className='h-64' />
  if (error || !data)
    return <p className='text-[13px] text-red-600 dark:text-red-400'>Could not read the proxy.</p>
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
      <div className='flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
        <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
        {data.error ?? 'Traefik did not answer.'}
      </div>
    )
  const v = data.view
  const dead = v.routers.filter((r) => r.no_healthy_backend)
  const showRates = v.metrics.available
  return (
    <div className='space-y-4'>
      <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
        Traefik {v.version} · {v.routers.length} routers
        {v.providers.length ? ` · providers ${v.providers.join(', ')}` : ''}
        {!showRates && v.metrics.reason ? ` · request rates hidden (${v.metrics.reason})` : ''}
      </p>

      {(dead.length > 0 || v.shadowing.length > 0 || v.provider_errors.length > 0) && (
        <section aria-label='Problems' className='space-y-2'>
          {dead.map((r) => (
            <Problem key={`d-${r.name}`}>
              <b>{r.name}</b> has no healthy backend: every server of{' '}
              <b>{r.service ?? 'its service'}</b> is down or none is registered.
            </Problem>
          ))}
          {v.shadowing.map((s) => (
            <Problem key={`s-${s.winner}-${s.loser}`}>{s.sentence}</Problem>
          ))}
          {v.provider_errors.map((e) => (
            <Problem key={`e-${e.router}`}>
              <b>{e.router}</b> {e.provider ? `(${e.provider}) ` : ''}
              {e.errors.length ? e.errors.join('; ') : 'reports a warning'}.
            </Problem>
          ))}
        </section>
      )}

      <div className={TABLE_WRAP}>
        <table className='w-full min-w-[960px]'>
          <thead className='border-b border-slate-200 dark:border-border'>
            <tr>
              <th className={TH}>Router</th>
              <th className={TH}>Rule</th>
              <th className={TH}>Entrypoints</th>
              <th className={TH}>Priority</th>
              <th className={TH}>Middlewares</th>
              <th className={TH}>TLS</th>
              <th className={TH}>Backend</th>
              {showRates && <th className={TH}>Req/s</th>}
              {showRates && <th className={TH}>5xx/s</th>}
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 dark:divide-border'>
            {v.routers.length === 0 && (
              <tr>
                <td className={TD} colSpan={showRates ? 9 : 7}>
                  Traefik has no HTTP routers.
                </td>
              </tr>
            )}
            {v.routers.map((r) => (
              <tr key={r.name}>
                <td className={`${TD} font-medium`}>
                  <span className='break-all'>{r.name}</span>
                  {r.status !== 'enabled' && (
                    <span className='ml-1.5'>
                      <Pill tone={r.status === 'disabled' ? 'bad' : 'warn'}>{r.status}</Pill>
                    </span>
                  )}
                  {r.shadowed_by && (
                    <div className='mt-1'>
                      <Pill tone='warn'>shadowed by {r.shadowed_by.winner}</Pill>
                    </div>
                  )}
                </td>
                <td className={`${TD} max-w-[22rem]`}>
                  <code className='break-all text-[11px]'>{r.rule}</code>
                </td>
                <td className={TD}>{r.entrypoints.join(', ') || '—'}</td>
                <td className={TD}>
                  {r.priority}
                  {r.priority_default && (
                    <span className='text-slate-400 dark:text-muted-foreground'>
                      {' '}
                      (rule length)
                    </span>
                  )}
                </td>
                <td className={`${TD} break-all`}>{r.middlewares.join(' → ') || '—'}</td>
                <td className={TD}>
                  {r.tls ? (
                    <Pill tone='ok'>{r.tls_resolver ?? 'TLS'}</Pill>
                  ) : (
                    <Pill tone='muted'>none</Pill>
                  )}
                </td>
                <td className={TD}>
                  <div className='break-all'>{r.service ?? '—'}</div>
                  {r.servers.length > 0 && (
                    <ul className='mt-1 space-y-0.5'>
                      {r.servers.map((s) => (
                        <li key={s.url} className='flex items-center gap-1.5'>
                          <Pill
                            tone={s.status === 'UP' ? 'ok' : s.status === 'DOWN' ? 'bad' : 'muted'}
                          >
                            {s.status === 'unknown' ? 'unchecked' : s.status}
                          </Pill>
                          <span className='break-all text-[11px]'>{s.url}</span>
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
                {showRates && <td className={TD}>{fmtRate(r.rps)}</td>}
                {showRates && (
                  <td className={TD}>
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

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div className='flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
      <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
      <span>{children}</span>
    </div>
  )
}
