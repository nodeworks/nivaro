import { WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'

/**
 * Offline banner (#348): connectivity loss shows an honest "offline — changes
 * paused" strip and clears itself when the connection returns. Uses the
 * browser online/offline events plus a confirm probe (the events lie on some
 * networks) against a HEAD to the app's own origin.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    let alive = true
    const probe = async () => {
      try {
        await fetch('/api/version', { method: 'GET', cache: 'no-store' })
        if (alive) setOffline(false)
      } catch {
        if (alive) setOffline(true)
      }
    }
    const onOffline = () => {
      setOffline(true)
    }
    const onOnline = () => {
      void probe()
    }
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    // While offline, retry every 10s so recovery is automatic.
    const t = setInterval(() => {
      if (!navigator.onLine || offline) void probe()
    }, 10_000)
    return () => {
      alive = false
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
      clearInterval(t)
    }
  }, [offline])
  if (!offline) return null
  return (
    <div className='flex items-center justify-center gap-2 border-b border-slate-700 bg-[#0f172a] px-4 py-1.5 text-[12px] text-slate-200'>
      <WifiOff className='h-3.5 w-3.5 text-amber-400' />
      You're offline — changes are paused and will fail until the connection returns. Retrying
      automatically.
    </div>
  )
}
