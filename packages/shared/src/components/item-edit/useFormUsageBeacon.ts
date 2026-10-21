import { useCallback, useEffect, useRef } from 'react'
import { useApiFetchConfig } from '../../context'
import { queueFormUsage, StepClock, sessionEvent } from '../../lib/form-usage-beacon'

/**
 * Records how a form is used (#2597/#2598): one session per (layout, record)
 * while the form is mounted — time on each step while the page is visible,
 * whether it saved, and for a new record the step it was left on. Sends one
 * small event when the session ends (and a chunk when the page goes hidden),
 * batched by lib/form-usage-beacon. Off in design mode and without a layout.
 */
export function useFormUsageBeacon({
  enabled,
  layoutId,
  collection,
  itemId,
  step
}: {
  enabled: boolean
  layoutId: number | null
  collection: string
  /** Saved record id; null for a new record. */
  itemId: string | null
  /** The open tab / step key; one key for a form without steps. */
  step: string
}): { markSaved: () => void } {
  const fetchCfg = useApiFetchConfig()
  const cfgRef = useRef(fetchCfg)
  cfgRef.current = fetchCfg
  const stepRef = useRef(step)
  stepRef.current = step
  const session = useRef<{
    clock: StepClock
    openSent: boolean
    saved: boolean
    elapsed: number
  } | null>(null)

  const on = enabled && layoutId != null && !!collection

  useEffect(() => {
    if (!on || layoutId == null) return
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
    const s = {
      clock: new StepClock(stepRef.current, Date.now(), visible()),
      openSent: false,
      saved: false,
      elapsed: 0
    }
    session.current = s
    const send = (final: boolean) => {
      const { steps, total } = s.clock.take(Date.now())
      s.elapsed += total
      const ev = sessionEvent({
        layoutId,
        collection,
        item: itemId,
        openSent: s.openSent,
        saved: s.saved,
        step: s.clock.currentStep,
        steps,
        total,
        elapsed: s.elapsed,
        final
      })
      if (!ev) return
      s.openSent = true
      s.saved = false
      const { apiBase, authHeaders, credentials } = cfgRef.current
      queueFormUsage(ev, { apiBase, authHeaders, credentials })
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        // Send what we have now: a hidden tab may never come back.
        send(false)
        s.clock.pause(Date.now())
      } else s.clock.resume(Date.now())
    }
    const onPageHide = () => send(true)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      send(true)
      if (session.current === s) session.current = null
    }
  }, [on, layoutId, collection, itemId])

  useEffect(() => {
    session.current?.clock.step(step, Date.now())
  }, [step])

  const markSaved = useCallback(() => {
    if (session.current) session.current.saved = true
  }, [])
  return { markSaved }
}
