// api/src/services/traffic-taps/roles.ts
/**
 * #1182 — traffic by role, next to the workspace split (#1154). Every request lands on one
 * bucket: the person's role id, `integration` (an API key, a simulated key, or a machine
 * account), or `anonymous`. Bounded: at most ROLE_CAP buckets per entity.
 *
 * entity: { [bucket]: n } over the window.
 */
import { MinuteCounter, registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { reqOf } from './req-facts.js'

export const ROLES_TAP = 'roles'
const ROLE_CAP = 30
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export const INTEGRATION_BUCKET = 'integration'
export const ANONYMOUS_BUCKET = 'anonymous'

/** The role bucket of one request. */
export function roleBucket(input: {
  authMethod?: string | null
  user?: { role?: unknown; account_kind?: unknown } | null
}): string {
  if (input.authMethod === 'api_key' || input.authMethod === 'key_sim') return INTEGRATION_BUCKET
  const u = input.user
  if (!u) return ANONYMOUS_BUCKET
  if (typeof u.account_kind === 'string' && u.account_kind) return INTEGRATION_BUCKET
  const role = u.role == null ? '' : String(u.role)
  return ID_RE.test(role) ? role.toUpperCase() : ANONYMOUS_BUCKET
}

interface State {
  byEntity: Map<string, MinuteCounter>
}
const state = (): State => tapState<State>(ROLES_TAP, () => ({ byEntity: new Map() }))

const tap: TrafficTap = {
  id: ROLES_TAP,
  onRequest(c) {
    const r = reqOf(c.ev) as
      | (ReturnType<typeof reqOf> & {
          user?: { role?: unknown; account_kind?: unknown } | null
        })
      | null
    const bucket = roleBucket({ authMethod: c.ev.authMethod, user: r?.user ?? null })
    const st = state()
    let m = st.byEntity.get(c.entityKey)
    if (!m) {
      m = new MinuteCounter(ROLE_CAP)
      st.byEntity.set(c.entityKey, m)
    }
    m.bump(bucket, c.sec)
  },
  entitySnapshot(entityKey, windowS, sec) {
    const m = state().byEntity.get(entityKey)
    if (!m) return undefined
    const top = m.top(windowS, sec)
    return top.length ? Object.fromEntries(top) : undefined
  },
  sweep(sec) {
    const st = state()
    for (const [k, m] of st.byEntity) {
      m.sweep(sec)
      if (m.size === 0) st.byEntity.delete(k)
    }
  }
}
tap.entityDetail = (key, windowS, sec) => tap.entitySnapshot?.(key, windowS, sec)
registerTrafficTap(tap)
