import { createNivaro } from '@nivaro/sdk'
import {
  defaultItemUrl,
  ItemEditAuthContext,
  NavigationContext,
  NivaroProvider,
  ProfileView
} from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(b64)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

// Shared-component host client (team-chat.tsx precedent — cookie session
// rides the same-origin requests).
const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

function BrowserPushCard() {
  const queryClient = useQueryClient()
  const supported = 'serviceWorker' in navigator && 'PushManager' in window
  const [busy, setBusy] = useState(false)

  const { data: status, isLoading } = useQuery<{ subscriptions: number }>({
    queryKey: ['push-status'],
    queryFn: () =>
      api.get<{ data: { subscriptions: number } }>('/push/status').then((r) => r.data.data),
    enabled: supported
  })
  const subscribed = (status?.subscriptions ?? 0) > 0

  async function enable() {
    setBusy(true)
    try {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        toast.error('Notification permission was denied')
        return
      }
      const reg = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const { data } = await api.get<{ data: { public_key: string } }>('/push/vapid-public-key')
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(data.data.public_key)
      })
      const json = sub.toJSON()
      await api.post('/push/subscribe', { endpoint: json.endpoint, keys: json.keys })
      toast.success('Browser notifications enabled')
      queryClient.invalidateQueries({ queryKey: ['push-status'] })
    } catch (_err) {
      toast.error('Could not enable browser notifications')
    } finally {
      setBusy(false)
    }
  }

  async function disable() {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js')
      const sub = await reg?.pushManager.getSubscription()
      if (sub) {
        await api.post('/push/unsubscribe', { endpoint: sub.endpoint })
        await sub.unsubscribe()
      }
      toast.success('Browser notifications disabled')
      queryClient.invalidateQueries({ queryKey: ['push-status'] })
    } catch {
      toast.error('Could not disable browser notifications')
    } finally {
      setBusy(false)
    }
  }

  async function sendTest() {
    const r = await api.post<{ data: { sent: number } }>('/push/test')
    toast.success(
      `Test push sent to ${r.data.data.sent} browser${r.data.data.sent === 1 ? '' : 's'}`
    )
  }

  return (
    <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'>
      <div className='mb-1 flex items-center justify-between'>
        <h2 className='text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
          Browser Notifications
        </h2>
        {supported && !isLoading && subscribed && (
          <Badge variant='success' className='h-4 px-1.5 text-[10px]'>
            {status!.subscriptions} device{status!.subscriptions === 1 ? '' : 's'}
          </Badge>
        )}
      </div>
      <p className='mb-4 text-[12px] text-slate-400'>
        Get native push notifications from your browser even when this tab is closed.
      </p>
      {!supported ? (
        <p className='text-[12px] text-slate-400'>This browser does not support web push.</p>
      ) : (
        <div className='flex gap-2'>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={subscribed ? disable : enable}
            disabled={busy || isLoading}
            className='gap-1.5 text-[12px]'
          >
            <BellRing className='h-3.5 w-3.5' />
            {busy ? 'Working…' : subscribed ? 'Disable on this device' : 'Enable notifications'}
          </Button>
          {subscribed && (
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={sendTest}
              className='gap-1.5 text-[12px]'
            >
              Send test
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * /profile — the OWN profile on the shared ProfileView (identity, out of
 * office, notification rules and sources, security, preferences). The one
 * admin-only extra is browser push, which needs this app's service worker.
 */
export function ProfilePage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  return (
    <NivaroProvider client={sharedClient}>
      <NavigationContext.Provider
        value={{
          navigate: (path) => navigate(path),
          itemUrl: defaultItemUrl,
          userUrl: (uid) => `/users/${uid}`
        }}
      >
        <ItemEditAuthContext.Provider
          value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
        >
          <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
            <h1 className='text-[15px] font-semibold text-slate-900 dark:text-slate-100'>
              My profile
            </h1>
          </div>
          <div className='p-8'>
            <ProfileView extra={<BrowserPushCard />} />
          </div>
        </ItemEditAuthContext.Provider>
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}
