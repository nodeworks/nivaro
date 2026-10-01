// api/src/services/traffic-taps/person-trail.ts
/**
 * #1178 — follow one person: the newest STEPS_CAP requests of every signed-in person (caller
 * `u<ID>`), each with the screen it came from (`x-nivaro-page` / `x-nivaro-app`, normalised the
 * same way the screens tap does — a route PATTERN, never an id). Read by GET
 * /traffic-map/follow; the page highlights the followed person's requests on the canvas and
 * lists the screens they moved through.
 *
 * Bounded: at most PEOPLE_CAP people (the least recently active is dropped first), each with a
 * ring of STEPS_CAP steps; a person idle for the whole map window is swept.
 */
import { RING_SECONDS } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { headerOf, reqOf } from './req-facts.js'
import { normalizeApp, normalizeScreenPath } from './screens.js'

export const PERSON_TRAIL_TAP = 'person-trail'
export const STEPS_CAP = 60
const PEOPLE_CAP = 500
const CALLER_RE = /^u[0-9A-F-]{36}$/

export interface TrailStep {
  /** Epoch ms of the response. */
  t: number
  /** `<lane>/<entity>` the request counted on. */
  key: string
  route: string
  status: number
  ms: number
  /** Screen pattern the request came from (`/collections/workflows/:id`), null when unknown. */
  page: string | null
  app: string | null
}
interface Person {
  steps: TrailStep[]
  lastSec: number
}
interface State {
  people: Map<string, Person>
}
const state = (): State => tapState<State>(PERSON_TRAIL_TAP, () => ({ people: new Map() }))

/** Append a step, keeping the newest `cap`. */
export function pushStep(steps: TrailStep[], step: TrailStep, cap = STEPS_CAP): void {
  steps.push(step)
  if (steps.length > cap) steps.splice(0, steps.length - cap)
}

/**
 * Consecutive steps on the same screen folded into one visit (newest first): the screen, when
 * it started and ended, how many requests and errors, and the entities it touched.
 */
export function visitsOf(steps: TrailStep[]): Array<{
  page: string | null
  app: string | null
  from: number
  to: number
  n: number
  errors: number
  keys: string[]
}> {
  const out: ReturnType<typeof visitsOf> = []
  for (const s of steps) {
    const last = out[out.length - 1]
    if (last && last.page === s.page && last.app === s.app) {
      last.to = s.t
      last.n++
      if (s.status >= 400) last.errors++
      if (!last.keys.includes(s.key) && last.keys.length < 8) last.keys.push(s.key)
    } else {
      out.push({
        page: s.page,
        app: s.app,
        from: s.t,
        to: s.t,
        n: 1,
        errors: s.status >= 400 ? 1 : 0,
        keys: [s.key]
      })
    }
  }
  return out.reverse()
}

/** The followed person's steps newer than `sinceMs` (all held when omitted). */
export function personTrail(caller: string, sinceMs = 0): { steps: TrailStep[]; lastSec: number } {
  const p = state().people.get(caller)
  if (!p) return { steps: [], lastSec: 0 }
  return { steps: p.steps.filter((s) => s.t > sinceMs), lastSec: p.lastSec }
}

const tap: TrafficTap = {
  id: PERSON_TRAIL_TAP,
  onRequest(c) {
    if (!CALLER_RE.test(c.caller)) return
    const r = reqOf(c.ev)
    const st = state()
    let p = st.people.get(c.caller)
    if (!p) {
      if (st.people.size >= PEOPLE_CAP) {
        // drop the least recently active person
        let oldest: string | null = null
        let oldestSec = Number.POSITIVE_INFINITY
        for (const [k, v] of st.people)
          if (v.lastSec < oldestSec) {
            oldest = k
            oldestSec = v.lastSec
          }
        if (oldest) st.people.delete(oldest)
      }
      p = { steps: [], lastSec: c.sec }
      st.people.set(c.caller, p)
    }
    p.lastSec = c.sec
    pushStep(p.steps, {
      t: c.ev.at,
      key: c.entityKey,
      route: c.route,
      status: c.ev.status,
      ms: c.ev.latencyMs,
      page: normalizeScreenPath(headerOf(r, 'x-nivaro-page')),
      app: normalizeApp(headerOf(r, 'x-nivaro-app'))
    })
  },
  sweep(sec) {
    const st = state()
    for (const [k, p] of st.people) if (sec - p.lastSec > RING_SECONDS) st.people.delete(k)
  }
}
registerTrafficTap(tap)
