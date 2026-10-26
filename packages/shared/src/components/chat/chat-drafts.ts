import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, put } from '../../lib/commands'
import { useOptionalRealtime } from '../../lib/realtime'

/**
 * Draft sync across devices (#2474). The composer's unsent text for a room is
 * saved to the server ~1.5 s after the last keystroke and restored in another
 * tab or device; the server tells the person's other tabs over their own
 * socket room (`chat:draft`, room + cleared flag only — no text) and they
 * re-read it. Sending deletes the draft on the server. Attachments are not
 * synced. Thread composers are not synced either (v1).
 */

const DEBOUNCE_MS = 1500
/** One id per tab, so a tab ignores the echo of its own save. */
const DEVICE = Math.random().toString(36).slice(2, 12)

interface DraftState {
  body: string
  updated_at: string
}

/** Rooms where this person has an unsent draft — the sidebar's marker. */
export function useDraftRooms(enabled = true): Set<string> {
  const client = useNivaroClient()
  const realtime = useOptionalRealtime()
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-drafts'],
    queryFn: () =>
      client
        .request<{ data: Array<{ room: string }> }>(get('/chat/drafts'))
        .then((r) => (r.data ?? []).map((d) => d.room)),
    enabled,
    staleTime: 60_000
  })
  useEffect(() => {
    if (!enabled || !realtime) return
    return realtime.on(
      'chat:draft',
      () => void qc.invalidateQueries({ queryKey: ['nvr-chat-drafts'] })
    )
  }, [enabled, realtime, qc])
  return new Set(data ?? [])
}

/**
 * Keep `draft` in step with the server copy for `room`. `setDraft` is the
 * composer's state setter; remote text is only applied over an empty or
 * untouched box, never over what the person is typing here.
 */
export function useDraftSync(
  room: string,
  enabled: boolean,
  draft: string,
  setDraft: (v: string) => void
): void {
  const client = useNivaroClient()
  const realtime = useOptionalRealtime()
  const qc = useQueryClient()
  // The text the server is known to hold (after a restore or a save).
  const synced = useRef('')
  const draftRef = useRef(draft)
  draftRef.current = draft
  const restored = useRef(false)

  const pull = async (initial: boolean) => {
    try {
      const res = await client.request<{ data: DraftState | null }>(
        get(`/chat/drafts/${encodeURIComponent(room)}`)
      )
      const body = res.data?.body ?? ''
      const mine = draftRef.current
      if (initial ? mine === '' : mine === synced.current) {
        synced.current = body
        if (body !== mine) setDraft(body)
      } else if (initial) {
        // Typed before the restore answered — keep what is here, it wins.
        synced.current = body
      }
    } catch {
      /* drafts are a convenience — a failed read leaves the box as it is */
    } finally {
      restored.current = true
    }
  }

  // Restore when the room opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per room
  useEffect(() => {
    if (!enabled) return
    restored.current = false
    synced.current = ''
    void pull(true)
  }, [room, enabled])

  // Another tab saved or cleared.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pull reads refs
  useEffect(() => {
    if (!enabled || !realtime) return
    return realtime.on('chat:draft', (ev: { room?: string; device?: string | null }) => {
      if (!ev || ev.room !== room || ev.device === DEVICE) return
      void pull(false)
    })
  }, [enabled, realtime, room])

  const save = (forRoom: string, body: string) => {
    const done = () => {
      // Only the open room's copy is tracked; a flush for a room just left only refreshes the marker.
      if (forRoom === roomRef.current) synced.current = body
      void qc.invalidateQueries({ queryKey: ['nvr-chat-drafts'] })
    }
    const req = body.trim()
      ? client.request(put(`/chat/drafts/${encodeURIComponent(forRoom)}`, { body, device: DEVICE }))
      : client.request(del(`/chat/drafts/${encodeURIComponent(forRoom)}?device=${DEVICE}`))
    void req.then(done).catch(() => {})
  }
  const roomRef = useRef(room)
  roomRef.current = room
  /** Typed but not saved yet — sent at once when the room changes or the composer goes away. */
  const pending = useRef<{ room: string; body: string } | null>(null)

  // Save (or clear) shortly after typing stops.
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounced on draft only
  useEffect(() => {
    if (!enabled || !restored.current) return
    if (draft === synced.current) {
      pending.current = null
      return
    }
    pending.current = { room, body: draft }
    const t = setTimeout(() => {
      pending.current = null
      save(room, draft)
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [draft, room, enabled])

  // Switching conversations (or closing the panel) inside the debounce used to drop what was
  // typed: the timer was cleared with nothing sent (2026-10-26). Flush it instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: flushes the room being left
  useEffect(() => {
    if (!enabled) return
    return () => {
      const p = pending.current
      pending.current = null
      if (p && p.room === room) save(p.room, p.body)
    }
  }, [room, enabled])
}

/** Exported for tests: the debounce before a typed draft is saved. */
export const DRAFT_DEBOUNCE_MS = DEBOUNCE_MS
