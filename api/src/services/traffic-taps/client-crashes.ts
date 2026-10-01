// api/src/services/traffic-taps/client-crashes.ts
/**
 * #1181 — a client crash on the ticker. The /issues/client route (React error boundaries in
 * admin and efp-new) stamps what it stored on the request: the issue id and, when the browser
 * sent one, the error clip or session recording plus the offset of the error moment. This tap
 * turns that into one ticker row tagged `client crash` whose `extra.client_crash` the page links
 * to the replay (seeked to the error) and the issue.
 *
 * The recording id is only ever the one the route verified (it belongs to the reporting user).
 */
import { pushTrafficEvent } from '../traffic-map.js'
import { registerTrafficTap } from '../traffic-taps.js'

export const CLIENT_CRASHES_TAP = 'client-crashes'
const PATH_RE = /^\/api\/issues\/client\/?(?:\?|$)/

export interface ClientCrash {
  issue_id: number | null
  recording_id: string | null
  offset_ms: number | null
  message: string
}

/** The stamped crash of a finished /issues/client request; null for anything else. */
export function crashOf(method: string, path: string, req: unknown): ClientCrash | null {
  if (method !== 'POST' || !PATH_RE.test(path)) return null
  const c = (req as { __nvrClientCrash?: Partial<ClientCrash> } | null | undefined)
    ?.__nvrClientCrash
  if (!c || typeof c !== 'object') return null
  const rec =
    typeof c.recording_id === 'string' && /^[0-9a-f-]{36}$/i.test(c.recording_id)
      ? c.recording_id
      : null
  const issue = Number(c.issue_id)
  const offset = Number(c.offset_ms)
  return {
    issue_id: Number.isFinite(issue) && issue > 0 ? issue : null,
    recording_id: rec,
    offset_ms: rec && c.offset_ms != null && Number.isFinite(offset) ? Math.max(0, offset) : null,
    message: String(c.message ?? '').slice(0, 160)
  }
}

registerTrafficTap({
  id: CLIENT_CRASHES_TAP,
  onRequest(c) {
    const crash = crashOf(c.ev.method, c.ev.path, c.ev.req)
    if (!crash) return
    pushTrafficEvent({
      t: c.ev.at,
      lane: c.lane,
      entity: c.entity,
      kind: 'error',
      caller: c.caller,
      route: crash.message ? `Client crash: ${crash.message}` : 'Client crash',
      status: c.ev.status,
      ms: c.ev.latencyMs,
      tags: ['client crash'],
      extra: { client_crash: crash }
    })
  }
})
