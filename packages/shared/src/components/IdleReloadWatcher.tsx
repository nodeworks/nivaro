import { useEffect } from 'react'
import { useOptionalNivaroClient } from '../context'
import { clientVersion, markReloadFor, reloadCountFor } from '../lib/client-version'
import { get } from '../lib/commands'
import {
  type BuildStatus,
  decideIdleReload,
  decideIdleResync,
  lastIdleReloadInput,
  restoreScrollAfterReload,
  SLEEP_GAP_MS,
  saveScrollForReload,
  trackIdleReloadInput
} from '../lib/idle-reload'
import { currentPageApp } from '../lib/page-context'
import { reloadHoldLabels } from '../lib/reload-holds'
import { refreshScreenData } from '../lib/screen-refresh'
import { subscribeUnsavedWork, unsavedWorkLabels } from '../lib/unsaved-work'

const TICK_MS = 10_000

/**
 * Reload old tabs when idle (#2937) — renders nothing. Mounted by ForceReloadBanner, so every
 * host that shows pushed reloads also gets this. The decision is lib/idle-reload.ts
 * `decideIdleReload` (pure, tested); this only feeds it and acts on it.
 *
 * Asks GET /realtime/build-status through the host's NivaroClient when there is one, else the
 * same-origin /api (admin mounts the banner outside its NivaroProvider).
 *
 * Two reasons, two remedies (realtime idea 13): only a NEW BUILD reloads the page. Stale DATA —
 * the tab was hidden or the machine asleep longer than the server can replay live events, the
 * socket lost events it could not replay while the tab was away, or nobody used it for hours —
 * refreshes the screen's data in place on return (lib/screen-refresh.ts, the same refresh as
 * the ↻ button), keeping scroll, open panels and edits. `decideIdleResync` is the pure rule.
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

    // ── Data resync (idea 13): away / asleep / missed events → refresh data, not the page ──
    let awaySince: number | null = document.visibilityState === 'hidden' ? Date.now() : null
    let lastTick = Date.now()
    let sleptMs = 0
    let missed = false
    let lastResyncAt = 0
    const resync = (awayMs: number) => {
      if (!alive || reloading) return
      const now = Date.now()
      const reload = decideIdleReload({
        now,
        lastInput: lastIdleReloadInput(),
        unsaved: unsavedWorkLabels(),
        holds: reloadHoldLabels(),
        status,
        statusAt,
        reloadedFor: reloadCountFor,
        declined
      })
      const d = decideIdleResync({
        now,
        lastInput: lastIdleReloadInput(),
        awayMs,
        missed,
        lastResyncAt,
        status,
        reloadDue: reload.action === 'reload'
      })
      if (d.action !== 'resync') return
      lastResyncAt = now
      missed = false
      void refreshScreenData({ reason: `idle-${d.reason}` })
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        awaySince ??= Date.now()
      } else {
        const away = Math.max(awaySince == null ? 0 : Date.now() - awaySince, sleptMs)
        awaySince = null
        sleptMs = 0
        resync(away)
      }
      check()
    }
    const onPageShow = (e: Event) => {
      // Back from the browser's page cache: the page was frozen for as long as it was away.
      if ((e as PageTransitionEvent).persisted) resync(Math.max(sleptMs, 0))
      check()
    }
    const onMissed = () => {
      if (document.visibilityState === 'hidden' || awaySince != null) missed = true
    }
    const tick = () => {
      const now = Date.now()
      const gap = now - lastTick
      lastTick = now
      // The timer did not fire for a long while: the machine slept (or the tab was frozen).
      if (gap > SLEEP_GAP_MS) {
        if (document.visibilityState === 'hidden') sleptMs = Math.max(sleptMs, gap)
        else resync(gap)
      } else if (document.visibilityState === 'visible') resync(0)
      check()
    }

    const timer = setInterval(tick, TICK_MS)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('nvr:catchup-full', onMissed)
    window.addEventListener('nvr:realtime-stale', onMissed)
    const offUnsaved = subscribeUnsavedWork(() => setTimeout(check, 0))
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('nvr:catchup-full', onMissed)
      window.removeEventListener('nvr:realtime-stale', onMissed)
      offUnsaved()
    }
  }, [client])

  return null
}
