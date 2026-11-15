import { useContext, useEffect, useRef, useState } from 'react'
import { ItemEditAuthContext } from '../context'
import { useAttentionPrefs } from '../lib/attention-prefs'
import { expandCoalesced, isOwnEvent } from '../lib/live'
import { type Announcer, createAnnouncer } from '../lib/live-announcer'
import { useOptionalRealtime } from '../lib/realtime'

/**
 * The one polite live region of an app shell: screen-reader users hear that something on
 * the page changed ("2 rows updated", "Status changed"), at most once every ~5 seconds, never
 * for their own writes, never a value (live events carry field NAMES only).
 *
 * Mount ONCE, inside the realtime and item-edit-auth providers. Renders nothing visible. The
 * person's "Live changes" setting (Profile → Display: Full / Brief / Off) is respected, and
 * `off` stops listening entirely.
 */
export function LiveAnnouncer() {
  const realtime = useOptionalRealtime()
  const { userId } = useContext(ItemEditAuthContext)
  const { announce } = useAttentionPrefs()
  const [message, setMessage] = useState('')
  const flip = useRef(false)
  const announcer = useRef<Announcer | null>(null)
  const selfRef = useRef(userId)
  selfRef.current = userId

  // biome-ignore lint/correctness/useExhaustiveDependencies: created once; verbosity is applied by the effect below
  useEffect(() => {
    const a = createAnnouncer({
      verbosity: announce,
      say: (text) => {
        // The same words twice in a row would not be read again: alternate an invisible mark.
        flip.current = !flip.current
        setMessage(flip.current ? text : `${text}​`)
      }
    })
    announcer.current = a
    return () => {
      a.dispose()
      announcer.current = null
    }
  }, [])

  useEffect(() => {
    announcer.current?.setVerbosity(announce)
  }, [announce])

  useEffect(() => {
    if (!realtime || announce === 'off') return
    return realtime.on('collection:update', (raw: unknown) => {
      const first = raw as Record<string, unknown> | null
      if (!first || typeof first !== 'object' || typeof first.collection !== 'string') return
      const a = announcer.current
      if (!a) return
      for (const ev of expandCoalesced(first as never)) {
        if (isOwnEvent(ev as Record<string, unknown>, selfRef.current)) continue
        a.note({
          action: (ev as { action?: string }).action ?? null,
          item: (ev as { item?: string | number | null }).item ?? null,
          bulk: (ev as { bulk?: number }).bulk,
          fields: (ev as { changed_fields?: string[] }).changed_fields ?? null
        })
      }
    })
  }, [realtime, announce])

  return (
    <div
      role='status'
      aria-live='polite'
      aria-atomic='true'
      data-live-announcer
      // Off screen, not display:none (assistive tech skips that), and fixed so it never
      // stretches a scroller it happens to sit in.
      style={{
        position: 'fixed',
        width: 1,
        height: 1,
        margin: -1,
        padding: 0,
        overflow: 'hidden',
        clip: 'rect(0 0 0 0)',
        whiteSpace: 'nowrap',
        border: 0
      }}
    >
      {message}
    </div>
  )
}
