// api/src/services/traffic-taps/stale-tabs.ts
/**
 * #1180 — open tabs per app and build, and how many still run an old frontend build (or loaded
 * against an older API). Read from the `x-nivaro-client` header both front ends send on every
 * API call (build / api / tab / loaded — packages/shared lib/client-version.ts). The current
 * build of an app is the one its newest page load reported (services/client-version.ts), so no
 * release registry is needed. Pairs with the redeploy banner and "reload old tabs" on /realtime.
 *
 * snapshot: { apps: [{ app, tabs, stale, builds: [{ build, tabs, people, current, older }] }],
 *             tabs, stale } over the window, or undefined when no tab reported a build.
 */
import {
  type ClientVersion,
  currentBuilds,
  olderReason,
  parseClientHeader
} from '../client-version.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { normalizeApp } from './screens.js'

export const STALE_TABS_TAP = 'stale-tabs'
const TAB_CAP = 3000

interface TabRow {
  app: string
  version: ClientVersion
  caller: string
  lastSec: number
}
interface State {
  tabs: Map<string, TabRow>
}
const state = (): State => tapState<State>(STALE_TABS_TAP, () => ({ tabs: new Map() }))

function header(req: unknown, name: string): unknown {
  const h = (req as { headers?: Record<string, unknown> } | undefined)?.headers
  return h ? h[name] : undefined
}

export interface StaleTabsBuild {
  build: string | null
  api: string | null
  tabs: number
  people: number
  current: boolean
  older: 'build' | 'api' | null
}
export interface StaleTabsApp {
  app: string
  tabs: number
  stale: number
  current_build: string | null
  builds: StaleTabsBuild[]
}
export interface StaleTabsSnapshot {
  apps: StaleTabsApp[]
  tabs: number
  stale: number
}

/** Exported for tests: the window's tabs folded per app and build. */
export function summarizeTabs(rows: TabRow[]): StaleTabsSnapshot | undefined {
  if (rows.length === 0) return undefined
  const current = currentBuilds(rows.map((r) => ({ app: r.app, version: r.version })))
  const apps = new Map<string, Map<string, { b: StaleTabsBuild; people: Set<string> }>>()
  for (const r of rows) {
    const older = olderReason(r.app, r.version, current)
    const key = `${r.version.build ?? ''}|${older ? (r.version.api ?? '') : ''}`
    let byBuild = apps.get(r.app)
    if (!byBuild) {
      byBuild = new Map()
      apps.set(r.app, byBuild)
    }
    let g = byBuild.get(key)
    if (!g) {
      g = {
        b: {
          build: r.version.build,
          api: older === 'api' ? r.version.api : null,
          tabs: 0,
          people: 0,
          current: !older && !!r.version.build && current.get(r.app) === r.version.build,
          older
        },
        people: new Set()
      }
      byBuild.set(key, g)
    }
    g.b.tabs++
    g.people.add(r.caller)
  }
  const out: StaleTabsApp[] = []
  let tabs = 0
  let stale = 0
  for (const [app, byBuild] of apps) {
    const builds = [...byBuild.values()]
      .map(({ b, people }) => ({ ...b, people: people.size }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.tabs - a.tabs)
    const n = builds.reduce((s, b) => s + b.tabs, 0)
    const old = builds.filter((b) => b.older).reduce((s, b) => s + b.tabs, 0)
    tabs += n
    stale += old
    out.push({ app, tabs: n, stale: old, current_build: current.get(app) ?? null, builds })
  }
  out.sort((a, b) => b.stale - a.stale || b.tabs - a.tabs)
  return { apps: out, tabs, stale }
}

const tap: TrafficTap = {
  id: STALE_TABS_TAP,
  onRequest(c) {
    const version = parseClientHeader(header(c.ev.req, 'x-nivaro-client'))
    if (!version?.tab) return
    const app = normalizeApp(header(c.ev.req, 'x-nivaro-app')) ?? 'app'
    const st = state()
    if (!st.tabs.has(version.tab) && st.tabs.size >= TAB_CAP) {
      const first = st.tabs.keys().next().value
      if (first !== undefined) st.tabs.delete(first)
    }
    st.tabs.set(version.tab, { app, version, caller: c.caller, lastSec: c.sec })
  },
  snapshot(windowS, sec) {
    const since = sec - windowS
    return summarizeTabs([...state().tabs.values()].filter((t) => t.lastSec > since))
  },
  sweep(sec) {
    // A tab silent for an hour is closed.
    const st = state()
    for (const [k, t] of st.tabs) if (t.lastSec < sec - 3600) st.tabs.delete(k)
  }
}
registerTrafficTap(tap)
