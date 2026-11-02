import { ErrorNotice, toastError } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Plug } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Settings → Mobile app: how people get this instance into the Nivaro phone app, and whether
 * it can send them alerts.
 *
 *  - QR of this instance's address (the origin the admin is served on, = ADMIN_URL or the cloud
 *    tenant host). The address only: no sign-in, no key. The app's scanner accepts a URL.
 *  - Phone alerts: GET/POST /push/relay. "Connect push" registers this instance with the Nivaro
 *    push relay; hidden in cloud mode, where Nivaro Cloud provisions the relay key itself.
 *  - Phone sign-in (MOBILE_SIGNIN, env only) and what the app shows, from GET /app-info.
 */

interface AppInfo {
  name: string
  cloud: boolean
  environment: 'production' | 'staging' | 'development' | 'test' | 'other'
  min_app_version: string | null
  sign_in: { mobile: boolean; client_ids: string[] }
  push: { mode: 'off' | 'direct' | 'relay' }
}

interface RelayStatus {
  connected: boolean
  url: string
  content: 'full' | 'minimal'
  mode: 'off' | 'direct' | 'relay'
}

const ENVIRONMENT: Record<AppInfo['environment'], string> = {
  production: 'Production',
  staging: 'Staging',
  development: 'Development',
  test: 'Test',
  other: 'Other'
}

const label = 'text-[12px] font-medium text-slate-700 dark:text-foreground'
const hint = 'text-[11.5px] leading-relaxed text-slate-500 dark:text-muted-foreground'

function Cell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className='bg-white px-3 py-2.5 dark:bg-card'>
      <div className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
        {title}
      </div>
      <div className='mt-0.5 text-[12.5px] text-slate-800 dark:text-foreground'>{children}</div>
    </div>
  )
}

function Dot({ tone }: { tone: 'on' | 'off' | 'warn' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mr-1.5 inline-block h-1.5 w-1.5 -translate-y-px rounded-full',
        tone === 'on' && 'bg-emerald-500',
        tone === 'warn' && 'bg-amber-500',
        tone === 'off' && 'bg-slate-300 dark:bg-slate-600'
      )}
    />
  )
}

/** The instance address as an SVG QR code (dark modules on white, so it scans in dark mode). */
function useQrSvg(text: string): string | null {
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    QRCode.toString(text, {
      type: 'svg',
      margin: 0,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' }
    })
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(null))
    return () => {
      live = false
    }
  }, [text])
  return svg
}

function ConnectPhone({ origin }: { origin: string }) {
  const svg = useQrSvg(origin)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(origin)
      setCopied(true)
    } catch (err) {
      toastError(err, 'Could not copy the address')
    }
  }
  return (
    <figure
      className='m-0 flex w-[244px] max-w-full shrink-0 flex-col items-center rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'
      data-mobile-qr
    >
      <div className='rounded-md bg-white p-2.5 ring-1 ring-slate-200 dark:ring-0'>
        {svg ? (
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
            alt={`QR code for ${origin}`}
            width={168}
            height={168}
            className='block h-[168px] w-[168px]'
          />
        ) : (
          <Skeleton className='h-[168px] w-[168px]' />
        )}
      </div>
      <figcaption className='mt-4 w-full text-center'>
        <p className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          Scan with the Nivaro app
        </p>
        <p className={cn(hint, 'mt-1')}>
          In the app, tap Add instance, then Scan code. The code holds this address only, never a
          sign-in or a key.
        </p>
        <div className='mt-3 flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 py-1 pl-2.5 pr-1 dark:border-border dark:bg-muted/40'>
          <span
            className='min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-slate-700 dark:text-slate-200'
            title={origin}
            data-mobile-origin
          >
            {origin.replace(/^https?:\/\//, '')}
          </span>
          <button
            type='button'
            onClick={copy}
            aria-label={copied ? 'Address copied' : 'Copy address'}
            data-tip={copied ? undefined : 'Copy address'}
            className='inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
          >
            {copied ? (
              <Check className='h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400' />
            ) : (
              <Copy className='h-3.5 w-3.5' />
            )}
          </button>
        </div>
      </figcaption>
    </figure>
  )
}

function pushSummary(mode: RelayStatus['mode'], connected: boolean, cloud: boolean) {
  if (mode === 'off')
    return {
      tone: 'off' as const,
      text: 'Off',
      detail: cloud
        ? 'Phone alerts are turned off for this workspace.'
        : 'Phone alerts are turned off on this server (MOBILE_PUSH=off).'
    }
  if (mode === 'relay' && connected)
    return {
      tone: 'on' as const,
      text: 'On, through the Nivaro push relay',
      detail: 'People signed in to the Nivaro app get their alerts on their phone.'
    }
  return {
    tone: 'warn' as const,
    text: 'Not connected',
    detail: cloud
      ? 'Nivaro Cloud connects push for you. If this stays, contact Nivaro support.'
      : 'Alerts only reach apps built with this server’s own Expo project. Connect push so the Nivaro app gets them too.'
  }
}

export function MobileAppCard() {
  const qc = useQueryClient()
  const switchId = useId()
  const origin = window.location.origin

  const info = useQuery({
    queryKey: ['mobile-app', 'app-info'],
    queryFn: () => api.get<AppInfo>('/app-info').then((r) => r.data)
  })
  const relay = useQuery({
    queryKey: ['mobile-app', 'relay'],
    queryFn: () => api.get<{ data: RelayStatus }>('/push/relay').then((r) => r.data.data)
  })
  // Same key and shape as Profile → Signed-in phones, so the two share one read.
  const phones = useQuery({
    queryKey: ['nvr-signed-in-devices', 'me'],
    queryFn: () =>
      api.get<{ data: Array<{ id: string }> }>('/auth/devices').then((r) => r.data.data ?? []),
    staleTime: 30_000
  })

  const update = useMutation({
    mutationFn: (body: { connect?: true; content?: 'full' | 'minimal' }) =>
      api.post<{ data: RelayStatus }>('/push/relay', body).then((r) => r.data.data),
    onSuccess: (data, body) => {
      qc.setQueryData(['mobile-app', 'relay'], data)
      void qc.invalidateQueries({ queryKey: ['mobile-app', 'app-info'] })
      toast.success(
        body.connect
          ? 'Push connected. The Nivaro app can now get alerts from this instance.'
          : body.content === 'minimal'
            ? 'Alerts now carry minimal content'
            : 'Alerts now carry the full message'
      )
    },
    onError: (err, body) =>
      toastError(err, body.connect ? 'Could not connect push' : 'Could not save the alert content')
  })

  const loading = info.isLoading || relay.isLoading
  const failed = info.error ?? relay.error
  const cloud = !!info.data?.cloud
  const r = relay.data
  const push = r ? pushSummary(r.mode, r.connected, cloud) : null
  const extraApps = (info.data?.sign_in.client_ids ?? []).filter((c) => c !== 'nivaro-mobile')

  return (
    <div className='p-8' data-mobile-app-card>
      <h2 className='text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
        Mobile app
      </h2>
      <p className={cn(hint, 'mt-1 max-w-[62ch] text-[12px]')}>
        People can work from the Nivaro app on iPhone and Android: their work, records, chat and
        alerts. They add this instance by scanning the code, then sign in the way they do here.
      </p>

      <div className='mt-6 flex flex-wrap items-start gap-6'>
        <ConnectPhone origin={origin} />

        <div className='min-w-0 max-w-2xl flex-1 basis-[420px] space-y-5'>
          {loading ? (
            <Skeleton className='h-[124px] w-full' />
          ) : failed ? (
            <ErrorNotice
              error={failed}
              what='the mobile app settings'
              onRetry={() => {
                void info.refetch()
                void relay.refetch()
              }}
            />
          ) : (
            info.data &&
            r &&
            push && (
              <>
                <div
                  className='grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'
                  data-mobile-status
                >
                  <Cell title='Phone sign-in'>
                    <span data-mobile-sign-in>
                      <Dot tone={info.data.sign_in.mobile ? 'on' : 'off'} />
                      {info.data.sign_in.mobile ? 'On' : 'Off'}
                    </span>
                    <p className={cn(hint, 'mt-0.5')}>
                      {cloud
                        ? 'Set by Nivaro Cloud.'
                        : 'Set on the server: MOBILE_SIGNIN=off turns it off.'}
                    </p>
                  </Cell>
                  <Cell title='Phone alerts'>
                    <span data-mobile-push>
                      <Dot tone={push.tone} />
                      {push.text}
                    </span>
                  </Cell>
                  <Cell title='Shown in the app as'>
                    {info.data.name}
                    <span className='text-slate-500 dark:text-muted-foreground'>
                      {' · '}
                      {ENVIRONMENT[info.data.environment]}
                    </span>
                    {info.data.min_app_version && (
                      <p className={cn(hint, 'mt-0.5')}>
                        Needs app version{' '}
                        <span className='font-mono'>{info.data.min_app_version}</span> or newer
                      </p>
                    )}
                  </Cell>
                  <Cell title='Your signed-in phones'>
                    <span data-mobile-phone-count>
                      {phones.isLoading ? '…' : phones.isError ? 'Not known' : phones.data?.length}
                    </span>
                    <Link
                      to='/profile'
                      className='ml-2 text-[11.5px] text-sky-700 hover:underline dark:text-nvr-cyan'
                    >
                      Manage in your profile
                    </Link>
                  </Cell>
                </div>

                {extraApps.length > 0 && (
                  <p className={hint}>
                    Other apps that may sign in here:{' '}
                    {extraApps.map((c, i) => (
                      <span key={c}>
                        {i > 0 && ', '}
                        <span className='font-mono text-slate-700 dark:text-slate-200'>{c}</span>
                      </span>
                    ))}
                  </p>
                )}

                <section className='space-y-4 border-t border-slate-200 pt-5 dark:border-border'>
                  <div>
                    <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
                      Alert delivery
                    </h3>
                    <p className={cn(hint, 'mt-0.5 max-w-[62ch]')} data-mobile-push-detail>
                      {push.detail}
                    </p>
                  </div>

                  {!cloud && !r.connected && r.mode !== 'off' && (
                    <Button
                      size='sm'
                      className='bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
                      onClick={() => update.mutate({ connect: true })}
                      disabled={update.isPending}
                      data-mobile-connect
                    >
                      <Plug className='mr-1.5 h-3.5 w-3.5' />
                      {update.isPending && update.variables?.connect
                        ? 'Connecting…'
                        : 'Connect push'}
                    </Button>
                  )}

                  {r.mode !== 'off' && (
                    <div className='flex max-w-xl items-start justify-between gap-6'>
                      <div className='min-w-0 flex-1'>
                        <label htmlFor={switchId} className={label}>
                          Send minimal content
                        </label>
                        <p className={cn(hint, 'mt-0.5')}>
                          Alerts show only this instance’s name and “You have a new notification”.
                          The app loads the rest when it opens, so no message text or record names
                          pass through the push relay, Apple or Google.
                        </p>
                      </div>
                      <Switch
                        id={switchId}
                        checked={r.content === 'minimal'}
                        disabled={update.isPending}
                        onCheckedChange={(on) =>
                          update.mutate({ content: on ? 'minimal' : 'full' })
                        }
                        data-mobile-minimal
                      />
                    </div>
                  )}
                </section>
              </>
            )
          )}
        </div>
      </div>
    </div>
  )
}
