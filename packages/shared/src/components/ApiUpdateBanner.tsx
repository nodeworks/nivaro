import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get } from '../lib/commands'
import { type ApiVersionInfo, startApiVersionWatch, useApiUpdate } from '../lib/api-version'

/**
 * "The API was redeployed since you loaded this page" bar.
 *
 * Deliberately has no dismiss control: it clears only by reloading onto the
 * new build, at which point the tab's baseline and the served version agree
 * and this renders nothing. Someone who dismissed it would keep running
 * against an API they had not picked up the client changes for — which is the
 * problem it exists to prevent.
 *
 * Announced politely, not assertively: nothing is broken and nothing is being
 * lost, so it must not cut across what a screen-reader user is doing.
 *
 * Mount once near the root of a host app (admin's AppLayout does). Mounting it
 * more than once is safe — the watcher behind it is a module-level singleton —
 * but each mount renders its own bar, so don't.
 *
 * Works with or without a NivaroProvider: it prefers the SDK client (correct
 * base URL for headless hosts on another origin) and otherwise falls back to a
 * same-origin fetch, which is what the admin SPA needs — it is served BY the
 * API in production and proxied to it in dev, and has no provider at its root.
 */
export function ApiUpdateBanner({
  appName = 'Nivaro',
  fetchVersion
}: {
  appName?: string
  fetchVersion?: () => Promise<ApiVersionInfo | null>
}) {
  const client = useOptionalNivaroClient()
  const update = useApiUpdate()
  const [reloading, setReloading] = useState(false)

  useEffect(() => {
    // The endpoint answers bare (no {data} envelope), but both shapes are
    // tolerated so a future envelope change cannot silently disable this.
    const unwrap = (body: (ApiVersionInfo & { data?: ApiVersionInfo }) | null) =>
      body?.data ?? body ?? null
    const viaClient = () =>
      client!
        .request<ApiVersionInfo>(get('/version'))
        .then((r) => unwrap(r as ApiVersionInfo & { data?: ApiVersionInfo }))
        .catch(() => null)
    const viaFetch = () =>
      fetch('/api/version', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then(unwrap)
        .catch(() => null)
    startApiVersionWatch(fetchVersion ?? (client ? viaClient : viaFetch))
  }, [client, fetchVersion])

  if (!update) return null

  const where = update.environment && update.environment !== 'production' ? ` (${update.environment})` : ''

  return (
    <div
      role='status'
      aria-live='polite'
      className='flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 bg-nvr-cyan/15 px-4 py-2 text-[12.5px] font-medium text-slate-900 md:px-6 dark:bg-nvr-cyan/10 dark:text-slate-100'
      data-nvr-api-update={update.version}
    >
      <RefreshCw className='h-4 w-4 shrink-0 text-nvr-cyan' strokeWidth={2} aria-hidden />
      <span>
        {appName} was updated{where}.
      </span>
      <span className='text-[11.5px] opacity-70'>Reload to pick up the latest changes.</span>
      <button
        type='button'
        disabled={reloading}
        onClick={() => {
          setReloading(true)
          window.location.reload()
        }}
        className='ml-auto inline-flex h-6 items-center gap-1 rounded-md bg-nvr-cyan px-2 text-[11.5px] font-semibold text-white transition-colors hover:bg-nvr-cyan/85 disabled:opacity-60'
      >
        <RefreshCw className={`h-3 w-3 ${reloading ? 'animate-spin' : ''}`} strokeWidth={2.5} />
        {reloading ? 'Reloading…' : 'Reload now'}
      </button>
    </div>
  )
}
