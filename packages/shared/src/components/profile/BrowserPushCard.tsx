import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'

/**
 * Browser push for your own account, on whichever app hosts the profile.
 *
 * Push is per BROWSER: the server keeps one subscription per endpoint, and a
 * notification goes to every browser the person turned it on in. The host must
 * serve a service worker at `serviceWorkerPath` (same origin, root scope) that
 * shows `push` events and opens `data.url` on click — admin and efp-new each
 * ship one at `/sw.js`. A host without it sees an explanation, not a button
 * that fails.
 */

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

type Note = { tone: 'ok' | 'error'; text: string } | null

export function BrowserPushCard({ serviceWorkerPath = '/sw.js' }: { serviceWorkerPath?: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const supported = pushSupported()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  // Whether THIS browser holds a live subscription (null = still checking).
  const [here, setHere] = useState<boolean | null>(null)
  const [permission, setPermission] = useState<NotificationPermission | null>(
    supported ? Notification.permission : null
  )

  const { data: status } = useQuery({
    queryKey: ['nvr-push-status'],
    queryFn: () =>
      client.request<{ data: { subscriptions: number } }>(get('/push/status')).then((r) => r.data),
    enabled: supported
  })
  const total = status?.subscriptions ?? 0

  useEffect(() => {
    if (!supported) return
    let alive = true
    navigator.serviceWorker
      .getRegistration(serviceWorkerPath)
      .then((reg) => reg?.pushManager.getSubscription() ?? null)
      .then((sub) => {
        if (alive) setHere(!!sub)
      })
      .catch(() => {
        if (alive) setHere(false)
      })
    return () => {
      alive = false
    }
  }, [supported, serviceWorkerPath])

  const refresh = () => void qc.invalidateQueries({ queryKey: ['nvr-push-status'] })

  async function enable() {
    setBusy(true)
    setNote(null)
    try {
      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== 'granted') {
        setNote({
          tone: 'error',
          text: 'Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.'
        })
        return
      }
      let reg: ServiceWorkerRegistration
      try {
        reg = await navigator.serviceWorker.register(serviceWorkerPath)
      } catch {
        setNote({
          tone: 'error',
          text: 'This app is not set up for browser notifications yet (no service worker).'
        })
        return
      }
      await navigator.serviceWorker.ready
      const key = await client.request<{ data: { public_key: string } }>(
        get('/push/vapid-public-key')
      )
      const existing = await reg.pushManager.getSubscription()
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key.data.public_key)
        }))
      const json = sub.toJSON()
      await client.request(post('/push/subscribe', { endpoint: json.endpoint, keys: json.keys }))
      setHere(true)
      setNote({ tone: 'ok', text: 'Turned on in this browser.' })
      refresh()
    } catch {
      setNote({ tone: 'error', text: 'Could not turn on browser notifications.' })
    } finally {
      setBusy(false)
    }
  }

  async function disable() {
    setBusy(true)
    setNote(null)
    try {
      const reg = await navigator.serviceWorker.getRegistration(serviceWorkerPath)
      const sub = await reg?.pushManager.getSubscription()
      if (sub) {
        await client.request(post('/push/unsubscribe', { endpoint: sub.endpoint }))
        await sub.unsubscribe()
      }
      setHere(false)
      setNote({ tone: 'ok', text: 'Turned off in this browser.' })
      refresh()
    } catch {
      setNote({ tone: 'error', text: 'Could not turn off browser notifications.' })
    } finally {
      setBusy(false)
    }
  }

  async function sendTest() {
    setBusy(true)
    setNote(null)
    try {
      const r = await client.request<{ data: { sent: number } }>(post('/push/test'))
      const n = r.data?.sent ?? 0
      setNote({
        tone: n > 0 ? 'ok' : 'error',
        text:
          n > 0
            ? `Test sent to ${n} browser${n === 1 ? '' : 's'}.`
            : 'No browser received it. Turn notifications on first.'
      })
    } catch {
      setNote({ tone: 'error', text: 'Could not send a test notification.' })
    } finally {
      setBusy(false)
    }
  }

  const others = here ? total - 1 : total

  return (
    <div
      data-profile-card='browser-push'
      className='rounded-xl border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'
    >
      <div className='flex items-start justify-between gap-3'>
        <div>
          <p className='flex items-center gap-1.5 text-[13.5px] font-semibold text-slate-800 dark:text-slate-100'>
            <BellRing className='h-4 w-4 text-slate-400' />
            Browser notifications
          </p>
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Native notifications from this browser, even when the tab is closed. Which categories
            push is set in Notification rules.
          </p>
        </div>
        {supported && here !== null && (
          <span
            data-push-state={here ? 'on' : 'off'}
            className={
              here
                ? 'shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300'
                : 'shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-white/5 dark:text-slate-300'
            }
          >
            {here ? 'On in this browser' : 'Off in this browser'}
          </span>
        )}
      </div>

      {!supported ? (
        <p className='mt-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          This browser does not support push notifications.
        </p>
      ) : (
        <>
          {others > 0 && (
            <p className='mt-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Also on in {others} other browser{others === 1 ? '' : 's'}.
            </p>
          )}
          {permission === 'denied' && !here && (
            <p className='mt-2 text-[12px] text-amber-700 dark:text-amber-300'>
              Notifications are blocked for this site in your browser settings.
            </p>
          )}
          <div className='mt-3 flex flex-wrap items-center gap-2'>
            {here ? (
              <button
                type='button'
                data-push-disable
                disabled={busy}
                onClick={() => void disable()}
                className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-slate-200 dark:hover:bg-white/5'
              >
                Turn off
              </button>
            ) : (
              <button
                type='button'
                data-push-enable
                disabled={busy || here === null}
                onClick={() => void enable()}
                className='inline-flex h-8 items-center gap-1.5 rounded-md border border-nvr-cyan/50 bg-nvr-cyan/5 px-3 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/10 disabled:opacity-50 dark:text-nvr-cyan'
              >
                {busy && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
                Turn on
              </button>
            )}
            {total > 0 && (
              <button
                type='button'
                data-push-test
                disabled={busy}
                onClick={() => void sendTest()}
                className='inline-flex h-8 items-center rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-slate-200 dark:hover:bg-white/5'
              >
                Send a test
              </button>
            )}
          </div>
          {note && (
            <p
              data-push-note={note.tone}
              className={
                note.tone === 'ok'
                  ? 'mt-2 text-[12px] text-emerald-700 dark:text-emerald-300'
                  : 'mt-2 text-[12px] text-red-600 dark:text-red-400'
              }
            >
              {note.text}
            </p>
          )}
        </>
      )}
    </div>
  )
}
