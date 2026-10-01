import { eventActions } from '../registry/eventActions'
import { register } from '../registry/registry'
import type { TrafficEventWire } from '../types'
import { SafeLink } from './shared'

/**
 * #1181 — a client crash (React error boundary → /issues/client) rides the ticker tagged
 * `client crash`; its row links straight to the error clip or session recording, seeked to the
 * moment of the error, and to the issue it landed on.
 */
export interface ClientCrash {
  issue_id: number | null
  recording_id: string | null
  offset_ms: number | null
  message: string
}

export function crashOf(ev: TrafficEventWire): ClientCrash | null {
  const c = ev.extra?.client_crash as ClientCrash | undefined
  return c && typeof c === 'object' ? c : null
}

/** The replay page link (`t` = the error offset, which the player seeks to). */
export function replayUrl(c: ClientCrash): string | null {
  if (!c.recording_id) return null
  return `/session-replays?recording=${encodeURIComponent(c.recording_id)}${
    c.offset_ms != null ? `&t=${Math.max(0, Math.round(c.offset_ms))}` : ''
  }`
}

const ROW_LINK =
  'rounded-sm px-1 text-[11px] font-medium text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

function CrashLinks({ ev }: { ev: TrafficEventWire }) {
  const c = crashOf(ev)
  if (!c) return null
  const replay = replayUrl(c)
  return (
    <>
      {replay && (
        <SafeLink
          to={replay}
          className={ROW_LINK}
          data-tm-crash-replay={c.recording_id ?? ''}
          title='Watch the replay of this crash, from the moment of the error'
        >
          Replay
        </SafeLink>
      )}
      {c.issue_id != null && (
        <SafeLink
          to={`/issues/${c.issue_id}`}
          className={ROW_LINK}
          data-tm-crash-issue={String(c.issue_id)}
          title='Open the issue this crash was recorded on'
        >
          Issue
        </SafeLink>
      )}
    </>
  )
}

register(eventActions, {
  id: 'client-crash',
  order: 5,
  applies: (ev) => !!crashOf(ev),
  Component: CrashLinks
})
