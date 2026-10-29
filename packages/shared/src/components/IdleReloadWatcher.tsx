import { useEffect } from 'react'
import { useOptionalNivaroClient } from '../context'
import { clientVersion, markReloadFor, reloadCountFor } from '../lib/client-version'
import { get } from '../lib/commands'
import {
  type BuildStatus,
  decideIdleReload,
  lastIdleReloadInput,
  restoreScrollAfterReload,
  saveScrollForReload,
  trackIdleReloadInput
} from '../lib/idle-reload'
import { currentPageApp } from '../lib/page-context'
import { reloadHoldLabels } from '../lib/reload-holds'
import { subscribeUnsavedWork, unsavedWorkLabels } from '../lib/unsaved-work'

const TICK_MS = 10_000

/**
 * Reload old tabs when idle (#2937) — renders nothing. Mounted by ForceReloadBanner, so every
 * host that shows pushed reloads also gets this. The decision is lib/idle-reload.ts
 * `decideIdleReload` (pure, tested); this only feeds it and acts on it.
 *
 * Asks GET /realtime/build-status through the host's NivaroClient when there is one, else the
 * same-origin /api (admin mounts the banner outside its NivaroProvider).
 */
export function IdleReloadWatcher() {
  const client = useOptionalNivaroClient()

  useEffect(() => {
    trackIdleReloadInput()
    return restoreScrollAfterReload()
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    let status: BuildStatus | null = null
    let statusAt = 0
    let asking = false
    let declined = false
    let reloading = false
    let alive = true

    const ask = async (): Promise<void> => {
      const v = clientVersion()
      const params: Record<string, string> = { tab: v.tab, loaded: String(v.loaded) }
      if (v.build) params.build = v.build
      if (v.api) params.api = v.api
      const app = currentPageApp()
      if (app) params.app = app
      let answer: BuildStatus | null = null
      try {
        if (client) {
          answer = (
            await client.request<{ data: BuildStatus }>(get('/realtime/build-status', params))
          ).data
        } else {
          const res = await fetch(`/api/realtime/build-status?${new URLSearchParams(params)}`, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' }
          })
          if (res.ok) answer = ((await res.json()) as { data: BuildStatus }).data
        }
      } catch {
        answer = null
      }
      // A failed ask (signed out, offline, an older API without the route) waits a full interval.
      status = answer ?? {
        older: null,
        target: null,
        id: null,
        reason: 'unanswered',
        auto_reload: { enabled: true, idle_seconds: status?.auto_reload.idle_seconds ?? 60 }
      }
      statusAt = Date.now()
    }

    const check = () => {
      if (!alive || asking || reloading) return
      const d = decideIdleReload({
        now: Date.now(),
        lastInput: lastIdleReloadInput(),
        unsaved: unsavedWorkLabels(),
        holds: reloadHoldLabels(),
        status,
        statusAt,
        reloadedFor: reloadCountFor,
        declined
      })
      if (d.action === 'check') {
        asking = true
        void ask().finally(() => {
          asking = false
          check()
        })
        return
      }
      if (d.action !== 'reload') return
      reloading = true
      markReloadFor(d.id)
      saveScrollForReload()
      window.location.reload()
      // A page's own leave prompt answered "stay": never try again on this page load.
      setTimeout(() => {
        reloading = false
        declined = true
      }, 1500)
    }

    const timer = setInterval(check, TICK_MS)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('pageshow', check)
    const offUnsaved = subscribeUnsavedWork(() => setTimeout(check, 0))
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('pageshow', check)
      offUnsaved()
    }
  }, [client])

  return null
}
